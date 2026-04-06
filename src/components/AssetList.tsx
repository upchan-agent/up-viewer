'use client';

import { useUpProvider } from '@/lib/up-provider';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens, useNft } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { ethers } from 'ethers';

interface AssetListProps {
  address?: `0x${string}`;
}

// ─── helpers ────────────────────────────────────────────────

const flattenImages = (nft: any): string[] => {
  if (!nft?.images) return [];
  const images = Array.isArray(nft.images[0]) ? nft.images.flat() : nft.images;
  return images.map((img: any) => img.url).filter(Boolean);
};

const isUsableIpfs = (url: string): boolean => {
  const cid = url.replace('ipfs://', '');
  return !(cid.startsWith('baf') && !cid.includes('.'));
};

const formatBalance = (balance: bigint | null, decimals: number | null | undefined): string => {
  if (!balance) return '0';
  const dec = decimals || 18;
  const divisor = BigInt(10 ** dec);
  return (Number(balance / divisor) + Number(balance % divisor) / Number(divisor)).toString();
};

const shortenId = (id: string, maxLen = 16): string => {
  if (!id || id.length <= maxLen) return id;
  const half = Math.floor((maxLen - 2) / 2);
  return `${id.slice(0, half + 2)}...${id.slice(-half)}`;
};

const toTokenIdHex = (tid: string): string => {
  if (tid.startsWith('0x')) return tid;
  const digits = tid.replace(/[^0-9]/g, '');
  if (!digits) return '0x' + tid.padStart(64, '0').slice(-64);
  return '0x' + BigInt(digits).toString(16).padStart(64, '0');
};

const INDEXER_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── Rate limiter: max 3 concurrent fetches ─────────────────
let _activeFetches = 0;
const _fetchQueue: { fn: () => Promise<string | null>; resolve: (v: string | null) => void; reject: (e: any) => void }[] = [];

function _drainQueue() {
  while (_activeFetches < 3 && _fetchQueue.length > 0) {
    _activeFetches++;
    const { fn, resolve, reject } = _fetchQueue.shift()!;
    fn().then(resolve).catch(reject).finally(() => { _activeFetches--; _drainQueue(); });
  }
}

function fetchWithLimit(fn: () => Promise<string | null>): Promise<string | null> {
  return new Promise((resolve, reject) => {
    _fetchQueue.push({ fn: () => fetchWithRetry(fn), resolve, reject });
    _drainQueue();
  });
}

const MAX_RETRIES = 2;
async function fetchWithRetry(fn: () => Promise<string | null>): Promise<string | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch {
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return null;
}

// ─── API fetchers ──────────────────────────────────────────

async function fetchAssetImage(addr: string): Promise<string | null> {
  const query = `{Asset(where:{id:{_eq:"${addr.toLowerCase()}"}},limit:1){icons{url}images{url}url}}`;
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const a = json.data?.Asset?.[0];
  if (a?.icons?.[0]?.url) return toGatewayUrl(a.icons[0].url) ?? null;
  if (a?.images?.[0]?.url) return toGatewayUrl(a.images[0].url) ?? null;
  if (a?.url?.startsWith('ipfs://')) return toGatewayUrl(a.url) ?? null;
  return null;
}

async function fetchTokenImage(addr: string, tidHex: string): Promise<string | null> {
  const fullId = `${addr.toLowerCase()}-${tidHex}`;
  const query = `{Token(where:{id:{_eq:"${fullId}"}},limit:1){images{url}icons{url}}}`;
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const t = json.data?.Token?.[0];
  if (t?.images?.[0]?.url) return toGatewayUrl(t.images[0].url) ?? null;
  if (t?.icons?.[0]?.url) return toGatewayUrl(t.icons[0].url) ?? null;
  return null;
}

// ─── Module-level API image cache ─────────────────────────
// key → string: resolved URL
// key → null:   API confirmed no image (don't retry)
// key absent:   not yet fetched
//
// Per-key subscriber map: components register a re-render callback.
// Only the component watching a given key is notified — no broadcast.
const _apiCache = new Map<string, string | null>();
const _apiSubs = new Map<string, Set<() => void>>();
const _apiInFlight = new Set<string>();

function _apiSubscribe(key: string, cb: () => void): () => void {
  if (!_apiSubs.has(key)) _apiSubs.set(key, new Set());
  _apiSubs.get(key)!.add(cb);
  return () => _apiSubs.get(key)?.delete(cb);
}

function _apiNotify(key: string) {
  _apiSubs.get(key)?.forEach(cb => cb());
}

// Initiate a fetch for `key` if not already cached or in-flight.
// On completion (url or null), stores in cache and notifies subscribers.
// Transient errors (throw) are not cached — next call will retry.
function _apiFetch(key: string, fn: () => Promise<string | null>) {
  if (_apiCache.has(key) || _apiInFlight.has(key)) return;
  _apiInFlight.add(key);
  fetchWithLimit(fn)
    .then(url => { _apiCache.set(key, url); })
    .catch(() => { /* transient error: leave absent so next mount retries */ })
    .finally(() => { _apiInFlight.delete(key); _apiNotify(key); });
}

// ─── ResolvedIcon ──────────────────────────────────────────

interface ResolvedIcon {
  url: string;
  scheme: string;
}

function resolveDaIcon(item: any): ResolvedIcon | null {
  if (!item) return null;
  const digitalAsset = item.digitalAsset;
  if (digitalAsset?.icons?.[0]?.url) return { url: toGatewayUrl(digitalAsset.icons[0].url)!, scheme: 'ownedAsset.digitalAsset.icons' };
  if (digitalAsset?.images?.[0]?.url) return { url: toGatewayUrl(digitalAsset.images[0].url)!, scheme: 'ownedAsset.digitalAsset.images' };
  // digitalAsset.url (LSP4TokenURI) intentionally excluded:
  // it points to a metadata JSON, not an image, and is not a reliable image source.
  return null;
}

// ─── types ─────────────────────────────────────────────────

interface TokenItem {
  id: string; name: string; symbol: string; amount: string;
  contractAddress: string; type: string;
  indexerIcon?: ResolvedIcon;
}

interface NftListEntry {
  id: string; name: string; symbol: string;
  tokenId: string; rawTokenId: string; contractAddress: string;
  collectionFallbackIcon?: ResolvedIcon;
  amount?: string;
}

interface NftCollEntry {
  isCollection: true;
  id: string; name: string; symbol: string;
  collectionIcon?: ResolvedIcon; count: number; children: NftListEntry[];
}

type NftRenderItem = NftListEntry | NftCollEntry;
const isColl = (x: NftRenderItem): x is NftCollEntry => 'isCollection' in x && x.isCollection;

// ─── useLsp8ChildImage ─────────────────────────────────────
// Resolves an image for a single LSP8 child NFT.
// Priority chain (mirrors popup exactly):
//   1. useNft.images              (flattenImages + isUsableIpfs)
//   2. api.Token                  (fetchTokenImage — covers non-standard NFTs)
//   3. useNft.icons
//   4. useNft.collection.icons
//   5. ownedToken.nft icons/images (passed as nftIndexerData — popup only)
//   6. collectionFallbackIcon      (parent collection icon)
//
// All 6 levels are always evaluated and recorded in debug[], regardless of
// which level resolved the image. This gives complete visibility in the
// debug panel even when resolution succeeds early.
//
// Return value:
//   undefined           → still resolving (caller shows placeholder)
//   { url: '', ... }    → confirmed no image (caller shows emoji)
//   { url: '...', ... } → resolved (caller shows image)
//
// useNft timeout: if isLoading stays true beyond NFT_HOOK_TIMEOUT_MS,
// the hook stops waiting and proceeds to the API + fallback chain.
// timedOut is stored in a ref (not state) so it never resets when
// nftLoadingRaw later becomes false — eliminating the "stuck on loading" bug.

const NFT_HOOK_TIMEOUT_MS = 5000;

interface ResolvedNftImage {
  url: string;
  scheme: string;
  debug: string[];
}

function useLsp8ChildImage({
  contractAddress,
  formattedTokenId,
  collectionFallbackIcon,
  nftIndexerData,
}: {
  contractAddress: string;
  formattedTokenId: string;
  collectionFallbackIcon?: ResolvedIcon;
  nftIndexerData?: any; // (selectedOwnedData as any)?.nft — popup only
}): ResolvedNftImage | undefined {
  const contractAddressLower = contractAddress.toLowerCase();
  const tokenIdHex = toTokenIdHex(formattedTokenId);
  const imageCacheKey = `lsp8:${contractAddressLower}:${tokenIdHex}`;

  // ── useNft ──────────────────────────────────────────────
  const { nft: nftData, isLoading: nftLoadingRaw } = useNft({
    address: contractAddressLower,
    formattedTokenId,
    include: {
      name: true, icons: true, images: true,
      description: true, links: true, attributes: true,
      category: true, collection: { baseUri: true, icons: true },
    },
  });

  // ── useNft timeout ──────────────────────────────────────
  const hasTimedOut = useRef(false);
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!nftLoadingRaw) { hasTimedOut.current = false; return; }
    const timeoutId = setTimeout(() => { hasTimedOut.current = true; forceUpdate(n => n + 1); }, NFT_HOOK_TIMEOUT_MS);
    return () => clearTimeout(timeoutId);
  // imageCacheKey as proxy for "new asset" — resets timer when asset changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageCacheKey]);

  const nftHookIsLoading = nftLoadingRaw && !hasTimedOut.current;

  // ── Subscribe to API cache for this key ─────────────────
  const [, setApiCacheTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setApiCacheTick(tick => tick + 1)), [imageCacheKey]);

  // ── Kick off API fetch once useNft is settled ───────────
  useEffect(() => {
    if (nftHookIsLoading) return;
    const nftMetadata = nftData as any;
    const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
    if (nftImages.some(isUsableIpfs)) return; // useNft succeeded — skip API
    _apiFetch(imageCacheKey, () => fetchTokenImage(contractAddressLower, tokenIdHex));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nftHookIsLoading, imageCacheKey]);

  // ── Priority chain — all levels evaluated before returning ─
  // Each level is always checked and logged, so debug[] always shows
  // the complete picture regardless of which level resolved the image.

  if (nftHookIsLoading) return undefined; // waiting for useNft hook

  const nftMetadata = nftData as any;
  const debug: string[] = [];

  // 1st: useNft.images
  const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
  const usableImageUrl = nftImages.find(isUsableIpfs);
  debug.push(`1st useNft.images: ${usableImageUrl ? '✓ ' + usableImageUrl : '(none)'}`);

  // 2nd: api.Token
  const cachedImageUrl = _apiCache.has(imageCacheKey) ? _apiCache.get(imageCacheKey) : undefined;
  const isCacheSettled = cachedImageUrl !== undefined;
  debug.push(`2nd api.Token: ${!isCacheSettled ? '(pending...)' : cachedImageUrl ? '✓ ' + cachedImageUrl : '(null)'}`);

  // 3rd: useNft.icons
  const nftIconUrl = nftMetadata?.icons?.[0]?.url;
  debug.push(`3rd useNft.icons: ${nftIconUrl ? '✓ ' + nftIconUrl : '(none)'}`);

  // 4th: useNft.collection.icons
  const collectionIconUrl = nftMetadata?.collection?.icons?.[0]?.url;
  debug.push(`4th useNft.collection.icons: ${collectionIconUrl ? '✓ ' + collectionIconUrl : '(none)'}`);

  // 5th: ownedToken.nft indexer (popup only — undefined in list context)
  const indexerImageUrl = nftIndexerData?.icons?.[0]?.url || nftIndexerData?.images?.[0]?.url;
  debug.push(`5th ownedToken.nft indexer: ${indexerImageUrl ? '✓ ' + indexerImageUrl : nftIndexerData ? '(none)' : '(list — n/a)'}`);

  // 6th: collectionFallbackIcon
  debug.push(`6th collectionFallbackIcon: ${collectionFallbackIcon?.url ? '✓ ' + collectionFallbackIcon.url : '(none)'}`);

  // ── Select winner in priority order ─────────────────────
  if (usableImageUrl) {
    debug.push(`selected: 1st`);
    return { url: toGatewayUrl(usableImageUrl)!, scheme: 'useNft.images', debug };
  }
  if (!isCacheSettled) return undefined; // still waiting for API
  if (cachedImageUrl) {
    debug.push(`selected: 2nd`);
    return { url: cachedImageUrl, scheme: 'api.Token', debug };
  }
  if (nftIconUrl) {
    debug.push(`selected: 3rd`);
    return { url: toGatewayUrl(nftIconUrl)!, scheme: 'useNft.icons', debug };
  }
  if (collectionIconUrl) {
    debug.push(`selected: 4th`);
    return { url: toGatewayUrl(collectionIconUrl)!, scheme: 'useNft.collection.icons', debug };
  }
  if (indexerImageUrl) {
    debug.push(`selected: 5th`);
    return { url: toGatewayUrl(indexerImageUrl)!, scheme: 'ownedToken.nft', debug };
  }
  if (collectionFallbackIcon?.url) {
    debug.push(`selected: 6th`);
    return { url: collectionFallbackIcon.url, scheme: 'collectionFallbackIcon', debug };
  }

  debug.push(`selected: none`);
  return { url: '', scheme: 'none', debug };
}

// ─── useLsp8CollectionImage ────────────────────────────────
// Resolves the header image for an LSP8 collection (the parent row).
// Simpler than child resolution — no useNft involved:
//   1. ownedAsset indexer data  (resolveDaIcon result passed as collectionIcon)
//   2. api.Asset                (fetchAssetImage fallback)

function useLsp8CollectionImage({
  collectionAddress,
  collectionIcon,
}: {
  collectionAddress: string;
  collectionIcon?: ResolvedIcon;
}): { icon: ResolvedIcon | undefined; debug: string[] } {
  const imageCacheKey = `lsp8coll:${collectionAddress.toLowerCase()}`;

  const [, setApiCacheTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setApiCacheTick(tick => tick + 1)), [imageCacheKey]);

  useEffect(() => {
    if (collectionIcon) return; // indexer provided icon — skip API
    _apiFetch(imageCacheKey, () => fetchAssetImage(collectionAddress));
  }, [imageCacheKey, collectionAddress, collectionIcon]);

  const debug: string[] = [];

  // 1st: ownedAsset indexer
  debug.push(`1st ownedAsset indexer: ${collectionIcon?.url ? '✓ ' + collectionIcon.url : '(none)'}`);

  // 2nd: api.Asset
  const cachedImageUrl = _apiCache.has(imageCacheKey) ? _apiCache.get(imageCacheKey) : undefined;
  const isCacheSettled = cachedImageUrl !== undefined;
  debug.push(`2nd api.Asset: ${!isCacheSettled ? '(pending...)' : cachedImageUrl ? '✓ ' + cachedImageUrl : '(null)'}`);

  if (collectionIcon?.url) return { icon: collectionIcon, debug };
  if (cachedImageUrl) return { icon: { url: cachedImageUrl, scheme: 'api.Asset' }, debug };
  return { icon: undefined, debug };
}

// ─── useTokenImage ─────────────────────────────────────────
// Resolves an image for a fungible Token (LSP7 TOKEN type).
// Priority chain:
//   1. ownedAsset indexer icons   (resolveDaIcon → digitalAsset.icons)
//   2. ownedAsset indexer images  (resolveDaIcon → digitalAsset.images)
//   3. api.Asset                  (fetchAssetImage fallback)
//
// The indexerIcon is the result of resolveDaIcon() already split into
// its two sub-sources for debug transparency.
// All levels always evaluated before returning.

function useTokenImage({
  contractAddress,
  indexerIcon,
}: {
  contractAddress: string;
  indexerIcon?: ResolvedIcon;
}): ResolvedNftImage | undefined {
  const imageCacheKey = `token:${contractAddress.toLowerCase()}`;

  const [, setApiCacheTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setApiCacheTick(tick => tick + 1)), [imageCacheKey]);

  useEffect(() => {
    if (indexerIcon) return; // indexer already provided icon — skip API
    _apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress));
  }, [imageCacheKey, contractAddress, indexerIcon]);

  const debug: string[] = [];

  // 1st: ownedAsset.digitalAsset.icons
  const indexerIconsUrl = indexerIcon?.scheme === 'ownedAsset.digitalAsset.icons' ? indexerIcon.url : undefined;
  debug.push(`1st ownedAsset.digitalAsset.icons: ${indexerIconsUrl ? '✓ ' + indexerIconsUrl : '(none)'}`);

  // 2nd: ownedAsset.digitalAsset.images
  const indexerImagesUrl = indexerIcon?.scheme === 'ownedAsset.digitalAsset.images' ? indexerIcon.url : undefined;
  debug.push(`2nd ownedAsset.digitalAsset.images: ${indexerImagesUrl ? '✓ ' + indexerImagesUrl : '(none)'}`);

  // 3rd: api.Asset
  const cachedImageUrl = _apiCache.has(imageCacheKey) ? _apiCache.get(imageCacheKey) : undefined;
  const isCacheSettled = cachedImageUrl !== undefined;
  debug.push(`3rd api.Asset: ${!isCacheSettled ? '(pending...)' : cachedImageUrl ? '✓ ' + cachedImageUrl : '(null)'}`);

  // Select winner
  if (indexerIconsUrl) {
    debug.push(`selected: 1st`);
    return { url: indexerIconsUrl, scheme: 'ownedAsset.digitalAsset.icons', debug };
  }
  if (indexerImagesUrl) {
    debug.push(`selected: 2nd`);
    return { url: indexerImagesUrl, scheme: 'ownedAsset.digitalAsset.images', debug };
  }
  if (!isCacheSettled) return undefined; // waiting for API
  if (cachedImageUrl) {
    debug.push(`selected: 3rd`);
    return { url: cachedImageUrl, scheme: 'api.Asset', debug };
  }

  debug.push(`selected: none`);
  return { url: '', scheme: 'none', debug };
}

// ─── useLsp7SingleNftImage ──────────────────────────────────
// Resolves an image for a LSP7 Single NFT (tokenType: NFT or COLLECTION,
// no individual token IDs — held as a single ownedAsset entry).
// Priority chain is identical to useTokenImage:
//   1. ownedAsset indexer icons
//   2. ownedAsset indexer images
//   3. api.Asset
//
// Kept as a separate hook (rather than reusing useTokenImage) so that
// the cache key namespace is distinct and debug labels are accurate.

function useLsp7SingleNftImage({
  contractAddress,
  indexerIcon,
}: {
  contractAddress: string;
  indexerIcon?: ResolvedIcon;
}): ResolvedNftImage | undefined {
  const imageCacheKey = `lsp7nft:${contractAddress.toLowerCase()}`;

  const [, setApiCacheTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setApiCacheTick(tick => tick + 1)), [imageCacheKey]);

  useEffect(() => {
    if (indexerIcon) return;
    _apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress));
  }, [imageCacheKey, contractAddress, indexerIcon]);

  const debug: string[] = [];

  // 1st: ownedAsset.digitalAsset.icons
  const indexerIconsUrl = indexerIcon?.scheme === 'ownedAsset.digitalAsset.icons' ? indexerIcon.url : undefined;
  debug.push(`1st ownedAsset.digitalAsset.icons: ${indexerIconsUrl ? '✓ ' + indexerIconsUrl : '(none)'}`);

  // 2nd: ownedAsset.digitalAsset.images
  const indexerImagesUrl = indexerIcon?.scheme === 'ownedAsset.digitalAsset.images' ? indexerIcon.url : undefined;
  debug.push(`2nd ownedAsset.digitalAsset.images: ${indexerImagesUrl ? '✓ ' + indexerImagesUrl : '(none)'}`);

  // 3rd: api.Asset
  const cachedImageUrl = _apiCache.has(imageCacheKey) ? _apiCache.get(imageCacheKey) : undefined;
  const isCacheSettled = cachedImageUrl !== undefined;
  debug.push(`3rd api.Asset: ${!isCacheSettled ? '(pending...)' : cachedImageUrl ? '✓ ' + cachedImageUrl : '(null)'}`);

  // Select winner
  if (indexerIconsUrl) {
    debug.push(`selected: 1st`);
    return { url: indexerIconsUrl, scheme: 'ownedAsset.digitalAsset.icons', debug };
  }
  if (indexerImagesUrl) {
    debug.push(`selected: 2nd`);
    return { url: indexerImagesUrl, scheme: 'ownedAsset.digitalAsset.images', debug };
  }
  if (!isCacheSettled) return undefined;
  if (cachedImageUrl) {
    debug.push(`selected: 3rd`);
    return { url: cachedImageUrl, scheme: 'api.Asset', debug };
  }

  debug.push(`selected: none`);
  return { url: '', scheme: 'none', debug };
}

// ─── NftChildItem ──────────────────────────────────────────

function NftChildItem({ entry, collectionFallbackIcon, renderIcon, styles, handleSelectAsset }: {
  entry: NftListEntry;
  collectionFallbackIcon?: ResolvedIcon;
  renderIcon: (icon: ResolvedIcon | undefined, fallbackEmoji: string) => React.ReactNode;
  styles: Record<string, React.CSSProperties>;
  handleSelectAsset: (type: 'token' | 'nft', addr: string, formattedTokenId?: string, e?: React.MouseEvent) => void;
}) {
  const resolved = useLsp8ChildImage({
    contractAddress: entry.contractAddress,
    formattedTokenId: entry.tokenId,
    collectionFallbackIcon,
  });

  // undefined = still resolving → show empty placeholder (no emoji flash)
  // url === '' = confirmed no image → show emoji
  const displayIcon = resolved?.url ? resolved : undefined;

  return (
    <div style={{ ...styles.item, marginLeft: '12px' }}
      onClick={(e) => handleSelectAsset('nft', entry.contractAddress, entry.tokenId, e)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
      {renderIcon(displayIcon, '🖼️')}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{entry.name}</span>
        <span style={styles.itemSymbol}>{entry.tokenId ? `#${shortenId(entry.tokenId, 16)}` : entry.symbol}</span>
      </div>
      <span style={styles.expandIcon}>›</span>
    </div>
  );
}

// ─── component ─────────────────────────────────────────────

export function AssetList({ address }: AssetListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [lyxBalance, setLyxBalance] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tokens' | 'nfts'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');

  const tokenListRef = useRef<HTMLDivElement>(null);
  const nftListRef = useRef<HTMLDivElement>(null);

  const [selectedAsset, setSelectedAsset] = useState<{ type: 'token' | 'nft'; address: string; formattedTokenId?: string } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['lsp8', 'lsp7']));
  const [debugOpen, setDebugOpen] = useState(false);

  const toggleSection = useCallback((key: string) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  // ─── Data hooks ──────────────────────────────────────────

  const {
    ownedAssets, hasNextPage: hasMoreAssets, fetchNextPage: fetchMoreAssets,
    isFetchingNextPage: loadingMoreAssets,
  } = useInfiniteOwnedAssets({
    filter: { holderAddress: targetAddress?.toLowerCase() || '' },
    include: { balance: true, digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true, url: true } },
    pageSize: 500,
  });

  const {
    ownedTokens, hasNextPage: hasMoreTokens, fetchNextPage: fetchMoreTokens,
    isFetchingNextPage: loadingMoreTokens,
  } = useInfiniteOwnedTokens({
    filter: { holderAddress: targetAddress?.toLowerCase() || '' },
    include: { digitalAsset: { name: true, symbol: true, tokenType: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true }, nft: { formattedTokenId: true, name: true, icons: true, description: true, images: true, links: true, attributes: true } },
    pageSize: 500,
  });

  useEffect(() => { if (hasMoreAssets && !loadingMoreAssets) fetchMoreAssets(); }, [hasMoreAssets, loadingMoreAssets, fetchMoreAssets]);
  useEffect(() => { if (hasMoreTokens && !loadingMoreTokens) fetchMoreTokens(); }, [hasMoreTokens, loadingMoreTokens, fetchMoreTokens]);
  useEffect(() => {
    if (!targetAddress) return;
    new ethers.JsonRpcProvider(LUKSO_RPC_URL).getBalance(targetAddress).then(b => setLyxBalance(ethers.formatEther(b)));
  }, [targetAddress]);

  // ─── selected asset data ─────────────────────────────────

  const selectedOwnedData = useMemo(() => {
    if (!selectedAsset) return null;
    if (selectedAsset.type === 'token') {
      return (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase());
    }
    const fmtId = selectedAsset.formattedTokenId;
    if (fmtId) {
      return (ownedTokens || []).find(t => t.nft?.formattedTokenId === fmtId && t.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase());
    }
    return (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase() && (a.digitalAsset?.tokenType === 'NFT' || a.digitalAsset?.tokenType === 'COLLECTION'));
  }, [selectedAsset, ownedAssets, ownedTokens]);

  const handleSelectAsset = useCallback((type: 'token' | 'nft', addr: string, formattedTokenId?: string, e?: React.MouseEvent) => {
    if (e) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPopupPosition({ top: r.top + window.scrollY, right: window.innerWidth - r.right + window.scrollX }); }
    setSelectedAsset({ type, address: addr, formattedTokenId });
  }, []);

  const handleClosePopup = useCallback(() => { setSelectedAsset(null); }, []);
  const toggleCollection = useCallback((id: string) => {
    setExpandedCollections(prev => { const n = new Set(prev); const k = id.toLowerCase(); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClosePopup(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [handleClosePopup]);

  // ─── Token items ─────────────────────────────────────────

  const tokenItems = useMemo((): TokenItem[] => {
    const lyxItem = { id: 'lyx', name: 'LYX', symbol: 'LYX', amount: lyxBalance || '0', type: 'LYX' as const, contractAddress: '' };
    const items = (ownedAssets || [])
      .filter(item => item.digitalAsset?.tokenType === 'TOKEN')
      .filter(item => !searchQuery || item.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase()))
      .map(item => ({
        id: item.digitalAssetAddress,
        name: item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        amount: formatBalance(item.balance, item.digitalAsset?.decimals),
        contractAddress: item.digitalAssetAddress,
        type: 'LSP7' as const,
        indexerIcon: resolveDaIcon(item) || undefined,
      }));
    return [lyxItem, ...[...items].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))];
  }, [lyxBalance, ownedAssets, searchQuery]);

  // ─── NFT tree ────────────────────────────────────────────

  const { nftTree, lsp7Nfts } = useMemo(() => {
    const addrMap = new Map<string, NftListEntry[]>();

    for (const item of (ownedTokens || [])) {
      const addr = item.digitalAssetAddress?.toLowerCase() || '';
      const entry: NftListEntry = {
        id: `${addr}-${item.tokenId}`,
        name: item.nft?.name || item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        tokenId: item.nft?.formattedTokenId || item.tokenId,
        rawTokenId: item.tokenId,
        contractAddress: item.digitalAssetAddress,
      };
      if (!addrMap.has(addr)) addrMap.set(addr, []);
      addrMap.get(addr)!.push(entry);
    }

    const result: NftRenderItem[] = [];
    for (const [addr, entries] of addrMap) {
      const filtered = !searchQuery ? entries : entries.filter(e =>
        e.name.toLowerCase().includes(searchQuery.toLowerCase()) || e.tokenId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.symbol.toLowerCase().includes(searchQuery.toLowerCase()));
      if (filtered.length === 0) continue;

      const collEntry = (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === addr);
      const collName = collEntry?.digitalAsset?.name || filtered[0].name.replace(/ #\d+$/, '') || filtered[0].name;
      const collIcon = resolveDaIcon(collEntry) || undefined;

      for (const e of filtered) { if (collIcon) e.collectionFallbackIcon = collIcon; }

      result.push({ isCollection: true, id: addr, name: collName, symbol: collEntry?.digitalAsset?.symbol || entries[0].symbol, collectionIcon: collIcon, count: filtered.length, children: filtered });
    }

    const lsp7Nfts: NftListEntry[] = [];
    const seen = new Set(addrMap.keys());
    for (const asset of (ownedAssets || [])) {
      const type = asset.digitalAsset?.tokenType;
      const addr = asset.digitalAssetAddress?.toLowerCase();
      if (addr && seen.has(addr)) continue;
      if (type !== 'NFT' && type !== 'COLLECTION') continue;
      if (searchQuery && !asset.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) && !asset.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase())) continue;

      lsp7Nfts.push({
        id: asset.digitalAssetAddress, name: asset.digitalAsset?.name || 'Unknown', symbol: asset.digitalAsset?.symbol || '???',
        tokenId: '', rawTokenId: '', contractAddress: asset.digitalAssetAddress,
        collectionFallbackIcon: resolveDaIcon(asset) || undefined,
        amount: asset.balance != null ? String(asset.balance) : '',
      });
    }

    return { nftTree: result.sort((a, b) => (a.name || '').localeCompare(b.name || '')), lsp7Nfts };
  }, [ownedTokens, ownedAssets, searchQuery]);

  // ─── renderIcon ──────────────────────────────────────────

  const renderIcon = (icon: ResolvedIcon | undefined, fallbackEmoji: string) => (
    <div style={icon ? styles.itemIconWithImg : styles.itemIcon}>
      {icon ? <img src={icon.url} alt="" style={styles.itemIconImg} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span>{fallbackEmoji}</span>}
    </div>
  );

  // ─── Collection header (LSP8) ────────────────────────────
  // useLsp8CollectionImage handles image resolution.
  // LSP8 section starts expanded; individual collections start collapsed.

  function NftCollectionHeader({ coll }: { coll: NftCollEntry }) {
    const isExpanded = expandedCollections.has(coll.id.toLowerCase());
    const { icon: collIcon } = useLsp8CollectionImage({
      collectionAddress: coll.id,
      collectionIcon: coll.collectionIcon,
    });

    return (
      <div>
        <div style={{ ...styles.item, fontWeight: 600 }} onClick={() => toggleCollection(coll.id)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
          {renderIcon(collIcon, '📂')}
          <div style={styles.itemInfo}><span style={styles.itemName}>{coll.name}</span><span style={styles.itemSymbol}>{coll.count} NFTs</span></div>
          <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        </div>
        {isExpanded && (
          <div style={{ paddingLeft: '8px' }}>
            {coll.children.map(child => (
              <NftChildItem
                key={child.id}
                entry={child}
                collectionFallbackIcon={child.collectionFallbackIcon}
                renderIcon={renderIcon}
                styles={styles}
                handleSelectAsset={handleSelectAsset}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─── Token list item (sub-component for hook usage) ─────

  function TokenListItem({ item }: { item: TokenItem }) {
    const resolved = useTokenImage({
      contractAddress: item.contractAddress,
      indexerIcon: item.indexerIcon,
    });
    const displayIcon = resolved?.url ? resolved : undefined;
    return (
      <div style={styles.item}
        onClick={(e) => handleSelectAsset('token' as const, item.contractAddress, undefined, e)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
        {renderIcon(displayIcon, '💎')}
        <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.symbol}</span></div>
        <div style={styles.itemAmount}>{formatTokenAmount(item.amount || '0')} {item.symbol}</div>
        <span style={styles.expandIcon}>›</span>
      </div>
    );
  }

  // ─── LSP7 Single NFT list item ───────────────────────────

  function Lsp7SingleNftListItem({ item }: { item: NftListEntry }) {
    const resolved = useLsp7SingleNftImage({
      contractAddress: item.contractAddress,
      indexerIcon: item.collectionFallbackIcon,
    });
    const displayIcon = resolved?.url ? resolved : undefined;
    return (
      <div style={styles.item}
        onClick={(e) => handleSelectAsset('nft', item.contractAddress, item.tokenId, e)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
        {renderIcon(displayIcon, '🖼️')}
        <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.amount ? `${item.amount} ${item.symbol}` : item.symbol}</span></div>
        <span style={styles.expandIcon}>›</span>
      </div>
    );
  }

  // ─── Section header ──────────────────────────────────────

  const SectionHeader = ({ label, protocol, count, sectionKey }: { label: string; protocol: string; count: number; sectionKey: string }) => {
    const isExpanded = expandedSections.has(sectionKey);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => toggleSection(sectionKey)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}>
        <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
        <span style={{ fontSize: '0.65rem', color: '#a0aec0', fontWeight: '500' }}>{protocol}</span>
        <span style={{ fontSize: '0.65rem', color: '#cbd5e0', fontWeight: '600', marginLeft: 'auto' }}>{count}</span>
      </div>
    );
  };

  // ─── Render ──────────────────────────────────────────────

  const showPlaceholder = !targetAddress;

  const renderTokenList = (items: TokenItem[], listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={listRef}>
      {items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => {
        if (item.type === 'LYX') {
          return (
            <div key={item.id} style={styles.item}
              onClick={(e) => handleSelectAsset('token' as const, item.contractAddress, undefined, e)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
              {renderIcon(undefined, '💎')}
              <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.symbol}</span></div>
              <div style={styles.itemAmount}>{parseFloat(item.amount || '0').toFixed(4)} LYX</div>
              <span style={styles.expandIcon}>›</span>
            </div>
          );
        }
        return <TokenListItem key={item.id} item={item} />;
      })}
    </div>
  );

  const renderNftTree = (tree: NftRenderItem[], singleNfts: NftListEntry[], listRef: React.RefObject<HTMLDivElement | null>) => {
    const hasCollections = tree.length > 0;
    const hasSingles = singleNfts.length > 0;
    if (!hasCollections && !hasSingles) return <p style={styles.empty}>No NFTs found</p>;
    const collTotal = (tree as NftCollEntry[]).reduce((s, c) => s + c.count, 0);

    return (
      <div style={styles.list} ref={listRef}>
        {hasCollections && (
          <>
            <SectionHeader label="Collection NFT" protocol="LSP8" count={collTotal} sectionKey="lsp8" />
            {expandedSections.has('lsp8') && tree.map((item) => (
              <div key={item.id}><NftCollectionHeader coll={item as NftCollEntry} /></div>
            ))}
          </>
        )}
        {hasCollections && hasSingles && <div style={{ height: '1px', background: '#e2e8f0', margin: '8px 0' }} />}
        {hasSingles && (
          <>
            <SectionHeader label="Single NFT" protocol="LSP7" count={singleNfts.length} sectionKey="lsp7" />
            {expandedSections.has('lsp7') && singleNfts.map((item) => (
              <Lsp7SingleNftListItem key={item.id} item={item} />
            ))}
          </>
        )}
      </div>
    );
  };

  // ─── Popup ───────────────────────────────────────────────
  // All three asset types now resolved via dedicated hooks.
  // isLsp8Popup:    useLsp8ChildImage
  // isTokenPopup:   useTokenImage
  // isLsp7NftPopup: useLsp7SingleNftImage

  const isLsp8Popup    = selectedAsset?.type === 'nft' && !!selectedAsset?.formattedTokenId;
  const isTokenPopup   = selectedAsset?.type === 'token';
  const isLsp7NftPopup = selectedAsset?.type === 'nft' && !selectedAsset?.formattedTokenId;

  const popupContractAddress = selectedAsset?.address ?? '';
  const popupNftAddr = isLsp8Popup ? popupContractAddress : '';
  const popupNftTid  = isLsp8Popup ? (selectedAsset?.formattedTokenId ?? '') : '';

  // LSP8 popup image
  const popupLsp8Image = useLsp8ChildImage(
    isLsp8Popup && popupNftAddr && popupNftTid
      ? {
          contractAddress: popupNftAddr,
          formattedTokenId: popupNftTid,
          collectionFallbackIcon: resolveDaIcon(
            (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === popupNftAddr.toLowerCase())
          ) ?? undefined,
          nftIndexerData: (selectedOwnedData as any)?.nft,
        }
      : { contractAddress: '', formattedTokenId: 'skip' }
  );

  // Token popup image
  const popupTokenImage = useTokenImage(
    isTokenPopup && popupContractAddress
      ? {
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
        }
      : { contractAddress: 'skip' }
  );

  // LSP7 Single NFT popup image
  const popupLsp7NftImage = useLsp7SingleNftImage(
    isLsp7NftPopup && popupContractAddress
      ? {
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
        }
      : { contractAddress: 'skip' }
  );

  // Unified popup image — picks the active hook result
  const popupImage = useMemo((): { url: string | null; scheme: string } => {
    const activeResolved = isLsp8Popup ? popupLsp8Image
      : isTokenPopup   ? popupTokenImage
      : isLsp7NftPopup ? popupLsp7NftImage
      : undefined;
    if (activeResolved === undefined) return { url: null, scheme: 'loading' };
    if (activeResolved.url) return { url: activeResolved.url, scheme: activeResolved.scheme };
    return { url: null, scheme: 'none' };
  }, [isLsp8Popup, isTokenPopup, isLsp7NftPopup, popupLsp8Image, popupTokenImage, popupLsp7NftImage]);

  // Unified debug panel
  const popupDebug = useMemo(() => {
    const assetType = isLsp8Popup ? '[LSP8]' : isTokenPopup ? '[Token]' : '[LSP7 Single NFT]';
    const activeResolved = isLsp8Popup ? popupLsp8Image
      : isTokenPopup   ? popupTokenImage
      : isLsp7NftPopup ? popupLsp7NftImage
      : undefined;
    const debugLines = activeResolved?.debug ?? ['(resolving...)'];
    return [
      `${assetType} selected: ${popupImage.scheme}`,
      ...debugLines,
      `final: ${popupImage.url ?? '(null)'}`,
    ].join('\n');
  }, [isLsp8Popup, isTokenPopup, isLsp7NftPopup, popupLsp8Image, popupTokenImage, popupLsp7NftImage, popupImage]);

  // useNft for popup text metadata (name, description, links, attributes)
  // Image resolution is handled separately by useLsp8ChildImage above.
  const { nft: popupNftData } = useNft(
    isLsp8Popup && popupNftAddr && popupNftTid
      ? { address: popupNftAddr.toLowerCase(), formattedTokenId: popupNftTid,
          include: { name: true, description: true, links: true, attributes: true } }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  const popupDa = selectedOwnedData?.digitalAsset;
  const popupDisplayName = isLsp8Popup
    ? ((popupNftData as any)?.name || (selectedOwnedData as any)?.nft?.name || popupDa?.name || 'Unknown') : (popupDa?.name || 'Unknown');
  const popupDisplaySymbol = isLsp8Popup
    ? `#${(popupNftData as any)?.formattedTokenId || (selectedOwnedData as any)?.nft?.formattedTokenId || selectedAsset?.formattedTokenId || '?'}` : (popupDa?.symbol || '');
  const popupDesc = isLsp8Popup
    ? ((popupNftData as any)?.description || (selectedOwnedData as any)?.nft?.description || popupDa?.description) : popupDa?.description;
  const popupLinks = !isLsp8Popup ? popupDa?.links : ((popupNftData as any)?.links || (selectedOwnedData as any)?.nft?.links);
  const popupAttrs = !isLsp8Popup ? popupDa?.attributes : ((popupNftData as any)?.attributes || (selectedOwnedData as any)?.nft?.attributes);

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>💎 Assets</h3>
      {showPlaceholder && <p style={styles.empty}>🔌</p>}
      {targetAddress && (
        <div style={{ animation: 'contentReveal 0.25s ease' }}>
          <div style={styles.tabs}>
            <button style={{ ...styles.tab, ...(activeTab === 'tokens' ? styles.tabActive : {}) }} onClick={() => setActiveTab('tokens')}>🪙 <span style={styles.tabCount}>{tokenItems.length}</span> Tokens</button>
            <button style={{ ...styles.tab, ...(activeTab === 'nfts' ? styles.tabActive : {}) }} onClick={() => setActiveTab('nfts')}>🖼️ <span style={styles.tabCount}>{(nftTree as NftCollEntry[]).reduce((s, i) => s + i.count, 0) + lsp7Nfts.length}</span> NFTs</button>
          </div>
          <input type="text" placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={styles.searchInput} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: activeTab === 'tokens' ? 'block' : 'none' }}>{renderTokenList(tokenItems, tokenListRef)}</div>
            <div style={{ display: activeTab === 'nfts' ? 'block' : 'none' }}>{renderNftTree(nftTree, lsp7Nfts, nftListRef)}</div>
          </div>
        </div>
      )}
      {selectedAsset && selectedOwnedData && (
        <div style={styles.overlay} onClick={() => setSelectedAsset(null)}>
          <div style={styles.popup} onClick={(e) => e.stopPropagation()}>
            <button style={styles.closeButton} onClick={() => setSelectedAsset(null)}>×</button>
            <div style={debugStyles.container}>
              <button
                style={{ ...debugStyles.summary, width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer' }}
                onClick={(e) => { e.stopPropagation(); setDebugOpen(open => !open); }}
              >
                🔍 Debug: Image Resolution {debugOpen ? '▲' : '▼'}
              </button>
              {debugOpen && <div style={debugStyles.content}>{popupDebug}</div>}
            </div>
            <div style={styles.popupImageWrapper}>
              {popupImage.scheme === 'loading' ? <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>⏳ Loading...</span>
              : popupImage.url ? <img src={popupImage.url} alt="" style={styles.popupImage} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              : <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>🖼️</span>}
            </div>
            <div style={styles.popupHeader}>
              <h3 style={styles.popupName}>{popupDisplayName}</h3>
              <span style={styles.popupSymbol}>{popupDisplaySymbol}</span>
            </div>
            {popupDesc && <p style={styles.popupDescription}>{popupDesc}</p>}
            {!isLsp8Popup && (
              <div style={styles.detailGrid}>
                <div><span style={styles.detailLabel}>Supply</span><span style={styles.detailValue}>{formatBigInt((popupDa as any)?.totalSupply, (popupDa as any)?.decimals)}</span></div>
                <div><span style={styles.detailLabel}>Holders</span><span style={styles.detailValue}>{(popupDa as any)?.holderCount?.toLocaleString() || '-'}</span></div>
                <div><span style={styles.detailLabel}>Balance</span><span style={styles.detailValue}>{formatBalance((selectedOwnedData as any)?.balance ?? null, (popupDa as any)?.decimals ?? null)}</span></div>
                {(popupDa as any)?.decimals != null && <div><span style={styles.detailLabel}>Decimals</span><span style={styles.detailValue}>{(popupDa as any).decimals}</span></div>}
              </div>
            )}
            {selectedOwnedData.digitalAssetAddress && (
              <div><span style={styles.detailLabel}>Contract</span><span style={styles.detailValue}><a href={`https://explorer.execution.mainnet.lukso.network/address/${selectedOwnedData.digitalAssetAddress}`} target="_blank" rel="noopener noreferrer" style={styles.link}>{selectedOwnedData.digitalAssetAddress}</a></span></div>
            )}
            {popupLinks?.length && (
              <div style={{ marginTop: '8px' }}><span style={styles.detailLabel}>Links</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>{popupLinks.map((l: { name?: string; url: string }, i: number) => <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" style={styles.outboundLink}>{l.name || l.url} ↗</a>)}</div>
              </div>
            )}
            {popupAttrs?.length && (
              <div style={{ marginTop: '8px' }}><span style={styles.detailLabel}>Attributes</span>
                <div style={styles.attributesGrid}>{popupAttrs.slice(0, 12).map((a: { key: string; value: string }, i: number) => <div key={i} style={styles.attributeItem}>{a.key && <span style={styles.attrKey}>{a.key}</span>}<span style={styles.attrValue}>{a.value}</span></div>)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

const formatBigInt = (raw: string | null | undefined, decimals: number | null | undefined): string => {
  if (!raw) return '-';
  try { return ethers.formatUnits(BigInt(raw), decimals || 18); } catch { return raw; }
};

const formatTokenAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  if (num >= 1) return num.toFixed(2);
  return num.toFixed(6);
};

// ─── Styles ──────────────────────────────────────────────────

const debugStyles: Record<string, React.CSSProperties> = {
  container: { marginBottom: '8px', fontSize: '0.58rem', color: '#6b7280', borderRadius: '6px', border: '1px solid #e5e7eb', overflow: 'hidden' },
  summary: { padding: '4px 8px', background: '#f9fafb', fontWeight: 600, fontSize: '0.65rem', color: '#374151', userSelect: 'none' },
  content: { padding: '6px 8px', background: '#fef2f2', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: '1.4', color: '#e74c3c', fontFamily: 'monospace', fontSize: '0.58rem' },
};

const styles: Record<string, React.CSSProperties> = {
  card: { padding: '8px', background: 'rgba(255,255,255,0.95)', borderRadius: '16px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' },
  title: { margin: '0 0 8px 0', fontSize: '1rem', fontWeight: '700', color: '#1a202c' },
  tabs: { display: 'flex', gap: '8px', marginBottom: '8px' },
  tab: { flex: 1, padding: '10px 12px', border: 'none', borderRadius: '10px', background: '#f7fafc', color: '#718096', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', transition: 'all 0.25s ease', minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' },
  tabActive: { background: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', color: '#fff' },
  tabCount: { fontWeight: '800' },
  searchInput: { width: '100%', padding: '8px 12px', marginBottom: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '16px', outline: 'none', boxSizing: 'border-box' },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '450px', overflowY: 'auto', minHeight: '60px' },
  item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: '#f7fafc', borderRadius: '8px', transition: 'background 0.15s ease', position: 'relative' },
  itemIcon: { width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', overflow: 'hidden', flexShrink: 0 },
  itemIconWithImg: { width: '28px', height: '28px', borderRadius: '50%', background: '#ffffff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', overflow: 'hidden', flexShrink: 0 },
  itemIconImg: { width: '100%', height: '100%', objectFit: 'cover' },
  itemInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  itemName: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemSymbol: { fontSize: '0.75rem', color: '#718096', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px', flexShrink: 0 },
  itemAmount: { fontSize: '0.75rem', fontWeight: '600', color: '#718096', textAlign: 'right', flexShrink: 0, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  expandIcon: { fontSize: '1.2rem', color: '#cbd5e0', flexShrink: 0, marginLeft: '2px' },
  empty: { margin: 0, padding: '16px', textAlign: 'center', color: '#a0aec0', fontSize: '0.85rem' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.3)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' },
  popup: { background: '#fff', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.15)', maxWidth: '420px', width: '90%', maxHeight: '70vh', overflowY: 'auto', overflowX: 'hidden', position: 'relative', padding: '16px', animation: 'popupIn 0.2s ease', transformOrigin: 'center' },
  closeButton: { position: 'absolute', top: '8px', right: '12px', background: 'none', border: 'none', fontSize: '1.5rem', cursor: 'pointer', color: '#718096', lineHeight: 1, zIndex: 1 },
  popupImageWrapper: { width: '100%', height: '200px', borderRadius: '12px', overflow: 'hidden', marginBottom: '12px', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f7fafc', flexShrink: 0 },
  popupImage: { maxWidth: '100%', maxHeight: '200px', objectFit: 'contain' },
  popupHeader: { marginBottom: '8px' },
  popupName: { fontSize: '1.1rem', fontWeight: '700', color: '#1a202c', margin: 0, lineHeight: 1.3 },
  popupSymbol: { fontSize: '0.8rem', color: '#718096', fontWeight: '500' },
  popupDescription: { fontSize: '0.85rem', color: '#4a5568', lineHeight: 1.5, margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' },
  detailLabel: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.025em' },
  detailValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-all' },
  link: { color: '#667eea', textDecoration: 'none', wordBreak: 'break-all' },
  outboundLink: { fontSize: '0.8rem', padding: '4px 8px', background: '#edf2f7', borderRadius: '6px', color: '#4a5568', textDecoration: 'none', transition: 'background 0.15s', wordBreak: 'break-all' },
  attributesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' },
  attributeItem: { padding: '6px 8px', background: '#f7fafc', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden' },
  attrKey: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '500' },
  attrValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-word' },
};

if (typeof document !== 'undefined' && !document.getElementById('popup-keyframes')) {
  const s = document.createElement('style'); s.id = 'popup-keyframes';
  s.textContent = '@keyframes popupIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(s);
}
