'use client';

import { useUpProvider } from '@/lib/up-provider';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens, useNft } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useEffect, useState, useMemo, useCallback, useRef, memo } from 'react';
import { ethers } from 'ethers';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { useVirtualizer } from '@tanstack/react-virtual';

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
  const dec = decimals ?? 18;
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
// Size-limited to MAX_CACHE_ENTRIES to prevent unbounded memory growth
// during long sessions (especially relevant on mobile with limited RAM).
// Eviction is LRU-approximated: when full, the oldest inserted key is dropped.
const MAX_CACHE_ENTRIES = 500;
const _apiCache = new Map<string, string | null>();
const _apiInFlight = new Set<string>();

// Per-key subscriber map.
// Only the component(s) watching a specific cache key are notified when
// that key's fetch completes — no global broadcast.
// This prevents the cascade where 1 fetch completion triggers re-renders
// across all mounted NftChildItems (was N fetches × N components re-renders).
const _apiSubs = new Map<string, Set<() => void>>();

function _apiSubscribe(key: string, cb: () => void): () => void {
  if (!_apiSubs.has(key)) _apiSubs.set(key, new Set());
  _apiSubs.get(key)!.add(cb);
  return () => {
    const subs = _apiSubs.get(key);
    if (!subs) return;
    subs.delete(cb);
    if (subs.size === 0) _apiSubs.delete(key);
  };
}

function _apiNotify(key: string) {
  _apiSubs.get(key)?.forEach(cb => cb());
}

// Popup open flag — set to true while any popup is visible.
// _apiFetch checks this flag and defers new fetches while popup is open,
// preventing background API calls from competing with popup interactions
// on the main thread (was causing tap delays and slow close on mobile).
let _isPopupOpen = false;
const _deferredFetches: Array<{ key: string; fn: () => Promise<string | null> }> = [];

function _setPopupOpen(open: boolean) {
  _isPopupOpen = open;
  if (!open && _deferredFetches.length > 0) {
    // Drain deferred fetches now that popup is closed
    const pending = _deferredFetches.splice(0);
    for (const { key, fn } of pending) _apiFetch(key, fn);
  }
}

// Initiate a fetch for `key` if not already cached or in-flight.
// priority=true bypasses the popup gate — used by popup image resolution
// so the popup's own fetch is never deferred by its own open state.
// priority=false (default) defers while popup is open to keep main thread free.
// Transient errors (throw) are not cached — next call will retry.
function _apiFetch(key: string, fn: () => Promise<string | null>, priority = false) {
  if (_apiCache.has(key) || _apiInFlight.has(key)) return;
  if (_isPopupOpen && !priority) {
    // Defer background fetches until popup closes
    if (!_deferredFetches.some(d => d.key === key)) _deferredFetches.push({ key, fn });
    return;
  }
  _apiInFlight.add(key);
  fetchWithLimit(fn)
    .then(url => {
      if (_apiCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = _apiCache.keys().next().value;
        if (oldestKey !== undefined) _apiCache.delete(oldestKey);
      }
      _apiCache.set(key, url);
    })
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

// ─── renderIcon (standalone, no re-creation on each render) ──

function renderIcon(icon: ResolvedIcon | undefined, fallbackEmoji: string) {
  return (
    <div style={icon ? styles.itemIconWithImg : styles.itemIcon}>
      {icon ? <img src={icon.url} alt="" style={styles.itemIconImg} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span>{fallbackEmoji}</span>}
    </div>
  );
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
  isPopupContext = false,
}: {
  contractAddress: string;
  formattedTokenId: string;
  collectionFallbackIcon?: ResolvedIcon;
  nftIndexerData?: any;
  isPopupContext?: boolean;
}): ResolvedNftImage | undefined {
  const contractAddressLower = contractAddress.toLowerCase();
  const tokenIdHex = toTokenIdHex(formattedTokenId);
  const imageCacheKey = `lsp8:${contractAddressLower}:${tokenIdHex}`;

  const { nft: nftData, isLoading: nftLoadingRaw } = useNft({
    address: contractAddressLower,
    formattedTokenId,
    // Minimal include for list view — images and icons only.
    // description/links/attributes are fetched separately in the popup via popupNftData.
    include: {
      images: true, icons: true,
      collection: { icons: true },
    },
  });

  // Timeout via ref — no state update (prevents mass re-render of all children)
  const hasTimedOut = useRef(false);
  useEffect(() => {
    if (!nftLoadingRaw) { hasTimedOut.current = false; return; }
    const t = setTimeout(() => { hasTimedOut.current = true; }, NFT_HOOK_TIMEOUT_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageCacheKey]);

  const nftHookIsLoading = nftLoadingRaw && !hasTimedOut.current;

  // Per-key subscription — only re-renders when this component's own fetch completes
  const [, setTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  // Kick off API fetch once useNft settles
  useEffect(() => {
    if (nftHookIsLoading) return;
    if (_apiCache.has(imageCacheKey) || _apiInFlight.has(imageCacheKey)) return;
    const nftMetadata = nftData as any;
    const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
    if (nftImages.some(isUsableIpfs)) return;
    _apiFetch(imageCacheKey, () => fetchTokenImage(contractAddressLower, tokenIdHex), isPopupContext);
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

  const [, setTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  useEffect(() => {
    if (collectionIcon) return;
    _apiFetch(imageCacheKey, () => fetchAssetImage(collectionAddress));
  }, [imageCacheKey, collectionAddress, collectionIcon]);

  const debug: string[] = [];

  debug.push(`1st ownedAsset indexer: ${collectionIcon?.url ? '✓ ' + collectionIcon.url : '(none)'}`);

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
  isPopupContext = false,
}: {
  contractAddress: string;
  indexerIcon?: ResolvedIcon;
  isPopupContext?: boolean;
}): ResolvedNftImage | undefined {
  const imageCacheKey = `token:${contractAddress.toLowerCase()}`;

  const [, setTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  useEffect(() => {
    if (indexerIcon) return;
    _apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress), isPopupContext);
  }, [imageCacheKey, contractAddress, indexerIcon, isPopupContext]);

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
  isPopupContext = false,
}: {
  contractAddress: string;
  indexerIcon?: ResolvedIcon;
  isPopupContext?: boolean;
}): ResolvedNftImage | undefined {
  const imageCacheKey = `lsp7nft:${contractAddress.toLowerCase()}`;

  const [, setTick] = useState(0);
  useEffect(() => _apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  useEffect(() => {
    if (indexerIcon) return;
    _apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress), isPopupContext);
  }, [imageCacheKey, contractAddress, indexerIcon, isPopupContext]);

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

function NftChildItem({ entry, collectionFallbackIcon, handleSelectAsset }: {
  entry: NftListEntry;
  collectionFallbackIcon?: ResolvedIcon;
  handleSelectAsset: (type: 'token' | 'nft', addr: string, formattedTokenId?: string, e?: React.MouseEvent) => void;
}) {
  const resolved = useLsp8ChildImage({
    contractAddress: entry.contractAddress,
    formattedTokenId: entry.tokenId,
    collectionFallbackIcon,
  });

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

// ─── Virtual row types ─────────────────────────────────────
// Defined at module level so NftVirtualList can be a stable component.

type VirtualRow =
  | { kind: 'section-header'; label: string; protocol: string; count: number; sectionKey: string }
  | { kind: 'divider' }
  | { kind: 'collection-header'; coll: NftCollEntry }
  | { kind: 'nft-child'; child: NftListEntry }
  | { kind: 'lsp7-single'; item: NftListEntry };

// ─── NftSectionHeaderRow ───────────────────────────────────

function NftSectionHeaderRow({ label, protocol, count, sectionKey, isExpanded, onToggle }: {
  label: string; protocol: string; count: number; sectionKey: string;
  isExpanded: boolean; onToggle: (key: string) => void;
}) {
  return (
    <div style={{ background: '#f8fafc', marginBottom: '2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer', userSelect: 'none' }}
        onClick={() => onToggle(sectionKey)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}>
        <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: '0.75rem', fontWeight: '700', color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
        <span style={{ fontSize: '0.65rem', color: '#a0aec0', fontWeight: '500' }}>{protocol}</span>
        <span style={{ fontSize: '0.65rem', color: '#cbd5e0', fontWeight: '600', marginLeft: 'auto' }}>{count}</span>
      </div>
    </div>
  );
}

// ─── NftCollectionHeaderRow ────────────────────────────────

function NftCollectionHeaderRow({ coll, isExpanded, onToggle, renderIcon }: {
  coll: NftCollEntry; isExpanded: boolean;
  onToggle: (id: string) => void;
  renderIcon: (icon: ResolvedIcon | undefined, fallback: string) => React.ReactNode;
}) {
  const { icon: collIcon } = useLsp8CollectionImage({
    collectionAddress: coll.id,
    collectionIcon: coll.collectionIcon,
  });
  return (
    <div style={{ ...styles.item, fontWeight: 600 }} onClick={() => onToggle(coll.id)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
      {renderIcon(collIcon, '📂')}
      <div style={styles.itemInfo}><span style={styles.itemName}>{coll.name}</span><span style={styles.itemSymbol}>{coll.count} NFTs</span></div>
      <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
    </div>
  );
}

// ─── NftVirtualList ────────────────────────────────────────
// Defined at module level — stable identity prevents useVirtualizer
// from resetting when AssetList re-renders (which caused scroll-to-top).

const NftVirtualList = memo(function NftVirtualList({
  rows,
  listRef,
  renderRow,
}: {
  rows: VirtualRow[];
  listRef: React.RefObject<HTMLDivElement | null>;
  renderRow: (row: VirtualRow) => React.ReactNode;
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => {
      const row = rows[index];
      if (row.kind === 'divider') return 17;
      if (row.kind === 'section-header') return 32;
      return 44;
    },
    overscan: 5,
  });

  if (rows.length === 0) return <p style={styles.empty}>No NFTs found</p>;

  return (
    <div style={styles.list} ref={listRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => (
          <div
            key={virtualItem.key}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualItem.start}px)`,
            }}
          >
            {renderRow(rows[virtualItem.index])}
          </div>
        ))}
      </div>
    </div>
  );
});

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
  const [nftFilter, setNftFilter] = useState<'all' | 'lsp8' | 'lsp7'>('all');

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
    _setPopupOpen(true);
    setSelectedAsset({ type, address: addr, formattedTokenId });
  }, []);

  const handleClosePopup = useCallback(() => {
    _setPopupOpen(false);
    setSelectedAsset(null);
  }, []);
  const toggleCollection = useCallback((id: string) => {
    // 1. re-render前にscroll位置を保存
    const el = nftListRef.current;
    const saved = el ? el.scrollTop : 0;
    nftScrollByFilter.current[nftFilter] = saved;
    // 2. state更新 → virtualRowsの再生成 → NftVirtualList re-render
    setExpandedCollections(prev => { const n = new Set(prev); const k = id.toLowerCase(); n.has(k) ? n.delete(k) : n.add(k); return n; });
    // 3. DOM更新完了後にscroll復元（rAF 2段）
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (el) el.scrollTop = nftScrollByFilter.current[nftFilter] ?? saved;
      });
    });
  }, [nftFilter]);

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

    return { nftTree: result.sort((a, b) => (a.name || '').localeCompare(b.name || '')), lsp7Nfts: lsp7Nfts.sort((a, b) => (a.name || '').localeCompare(b.name || '')) };
  }, [ownedTokens, ownedAssets, searchQuery]);

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

  // ─── Virtual row types ───────────────────────────────────
  // NFT list is flattened into a single array for virtualization.
  // Only rows visible in the viewport are mounted — this is the fix
  // for "300 NftChildItems all mounted at once" causing device heating.

  // ─── Flat virtual rows ───────────────────────────────────
  // Rebuilt when filter, search, or expand state changes.

  const virtualRows = useMemo((): VirtualRow[] => {
    const showLsp8 = nftFilter !== 'lsp7';
    const showLsp7 = nftFilter !== 'lsp8';
    const rows: VirtualRow[] = [];
    const hasCollections = nftTree.length > 0 && showLsp8;
    const hasSingles = lsp7Nfts.length > 0 && showLsp7;
    if (!hasCollections && !hasSingles) return rows;
    const collTotal = (nftTree as NftCollEntry[]).reduce((s, c) => s + c.count, 0);

    if (hasCollections) {
      rows.push({ kind: 'section-header', label: 'Collection NFT', protocol: 'LSP8', count: collTotal, sectionKey: 'lsp8' });
      if (expandedSections.has('lsp8')) {
        for (const item of nftTree) {
          const coll = item as NftCollEntry;
          rows.push({ kind: 'collection-header', coll });
          if (expandedCollections.has(coll.id.toLowerCase())) {
            for (const child of coll.children) {
              rows.push({ kind: 'nft-child', child });
            }
          }
        }
      }
    }
    if (hasCollections && hasSingles) rows.push({ kind: 'divider' });
    if (hasSingles) {
      rows.push({ kind: 'section-header', label: 'Single NFT', protocol: 'LSP7', count: lsp7Nfts.length, sectionKey: 'lsp7' });
      if (expandedSections.has('lsp7')) {
        for (const item of lsp7Nfts) rows.push({ kind: 'lsp7-single', item });
      }
    }
    return rows;
  }, [nftTree, lsp7Nfts, nftFilter, expandedSections, expandedCollections]);

  // scrollOffset: save position before rows change, restore after
  // ─── スクロール位置管理（フィルター別） ─────────────────
  // フィルター（all/lsp8/lsp7）ごとにスクロール位置を記録する。
  // 展開/折りたたみ時は現在のフィルターの位置を維持する。
  // すべて1つの仕組みで管理し、競合を防ぐ。

  const nftScrollByFilter = useRef<Record<string, number>>({ all: 0, lsp8: 0, lsp7: 0 });
  // フィルター切り替え中フラグ：切り替え後の復元が展開復元と衝突しないようにする
  const nftFilterSwitching = useRef(false);

  // スクロールイベントで現在のフィルターの位置を常時記録
  useEffect(() => {
    const el = nftListRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!nftFilterSwitching.current) {
        nftScrollByFilter.current[nftFilter] = el.scrollTop;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [nftFilter]);

  const handleNftFilterChange = useCallback((next: 'all' | 'lsp8' | 'lsp7') => {
    if (next === nftFilter) return;
    // 現在位置を保存
    if (nftListRef.current) {
      nftScrollByFilter.current[nftFilter] = nftListRef.current.scrollTop;
    }
    nftFilterSwitching.current = true;
    setNftFilter(next);
  }, [nftFilter]);

  // フィルター切り替え後に保存済み位置を復元
  useEffect(() => {
    if (!nftFilterSwitching.current) return;
    const el = nftListRef.current;
    if (el) el.scrollTop = nftScrollByFilter.current[nftFilter] ?? 0;
    // 次のフレームでフラグを解除（scroll イベントが先に走らないよう）
    requestAnimationFrame(() => { nftFilterSwitching.current = false; });
  }, [nftFilter]);

  // 展開/折りたたみ時は現在フィルターのスクロール位置を維持
  // rAF × 2 で virtualizer の DOM 測定完了を確実に待つ
  const prevVirtualRowsLength = useRef(virtualRows.length);
  useEffect(() => {
    if (nftFilterSwitching.current) return;
    const el = nftListRef.current;
    if (!el) return;
    if (prevVirtualRowsLength.current === virtualRows.length) return;
    // 1. 行数が変わる前の現在のスクロール位置を保存
    const savedScroll = el.scrollTop;
    nftScrollByFilter.current[nftFilter] = savedScroll;
    prevVirtualRowsLength.current = virtualRows.length;
    // 2. rAF: ブラウザがDOM更新を確定するのを待つ
    requestAnimationFrame(() => {
      // 3. さらにrAF: virtualizerのmeasureElement完了後に復元
      requestAnimationFrame(() => {
        el.scrollTop = nftScrollByFilter.current[nftFilter] ?? savedScroll;
      });
    });
  }, [virtualRows.length, nftFilter]);

  // ─── renderVirtualRow callback ───────────────────────────
  // Passed to NftVirtualList which lives outside AssetList.

  const renderVirtualRow = useCallback((row: VirtualRow): React.ReactNode => {
    switch (row.kind) {
      case 'section-header':
        return (
          <NftSectionHeaderRow
            label={row.label} protocol={row.protocol} count={row.count}
            sectionKey={row.sectionKey}
            isExpanded={expandedSections.has(row.sectionKey)}
            onToggle={toggleSection}
          />
        );
      case 'divider':
        return <div style={{ height: '1px', background: '#e2e8f0', margin: '8px 0' }} />;
      case 'collection-header':
        return (
          <NftCollectionHeaderRow
            coll={row.coll}
            isExpanded={expandedCollections.has(row.coll.id.toLowerCase())}
            onToggle={toggleCollection}
            renderIcon={renderIcon}
          />
        );
      case 'nft-child':
        return (
          <div style={{ paddingLeft: '12px' }}>
            <NftChildItem
              entry={row.child}
              collectionFallbackIcon={row.child.collectionFallbackIcon}
              handleSelectAsset={handleSelectAsset}
            />
          </div>
        );
      case 'lsp7-single':
        return <Lsp7SingleNftListItem item={row.item} />;
    }
  }, [expandedSections, toggleSection, toggleCollection, handleSelectAsset]);

  // NftVirtualList is defined at module level (below) to prevent
  // useVirtualizer from resetting on every AssetList re-render.

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
          isPopupContext: true,
        }
      : { contractAddress: '', formattedTokenId: 'skip' }
  );

  // Token popup image
  const popupTokenImage = useTokenImage(
    isTokenPopup && popupContractAddress
      ? {
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
          isPopupContext: true,
        }
      : { contractAddress: 'skip' }
  );

  // LSP7 Single NFT popup image
  const popupLsp7NftImage = useLsp7SingleNftImage(
    isLsp7NftPopup && popupContractAddress
      ? {
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
          isPopupContext: true,
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

  // ── Assemble Popup props ─────────────────────────────────

  const popupStats = useMemo((): { label: string; value: string }[] => {
    if (!selectedOwnedData) return [];
    const da = popupDa as any;
    if (isTokenPopup) return [
      { label: 'Supply',  value: formatBigInt(da?.totalSupply, da?.decimals) },
      { label: 'Holders', value: da?.holderCount?.toLocaleString() || '-' },
      { label: 'Balance', value: formatBalance((selectedOwnedData as any)?.balance ?? null, da?.decimals ?? null) },
      ...((da?.decimals) ? [{ label: 'Decimals', value: String(da.decimals) }] : []),
    ];
    if (isLsp7NftPopup) return [
      { label: 'Supply',  value: formatBigInt(da?.totalSupply, 0) },
      { label: 'Holders', value: da?.holderCount?.toLocaleString() || '-' },
      { label: 'Balance', value: formatBalance((selectedOwnedData as any)?.balance ?? null, 0) },
      ...((da?.decimals) ? [{ label: 'Decimals', value: String(da.decimals) }] : []),
    ];
    return []; // LSP8: no stats grid
  }, [isTokenPopup, isLsp7NftPopup, selectedOwnedData, popupDa]);

  // Normalize links to PopupLink format (Asset uses "name", LSP3 profile uses "title")
  const popupNormalizedLinks = useMemo((): PopupLink[] => {
    if (!popupLinks) return [];
    return popupLinks.map((l: any) => ({ title: l.name || l.title, url: l.url }));
  }, [popupLinks]);

  const popupExternalUrl = selectedOwnedData?.digitalAssetAddress
    ? { label: 'Contract', url: `https://explorer.execution.mainnet.lukso.network/address/${selectedOwnedData.digitalAssetAddress}` }
    : undefined;

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
          {/* Search bar — NFTs tab shows inline filter toggle on the right */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' }}>
            <input
              type="text"
              placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ ...styles.searchInput, marginBottom: 0, flex: 1 }}
            />
            {activeTab === 'nfts' && (
              <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                {(['all', 'lsp8', 'lsp7'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => handleNftFilterChange(f)}
                    style={{
                      padding: '6px 8px', border: 'none', borderRadius: '7px', cursor: 'pointer',
                      fontSize: '0.7rem', fontWeight: '600', lineHeight: 1,
                      background: nftFilter === f ? 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)' : '#f7fafc',
                      color: nftFilter === f ? '#fff' : '#718096',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {f === 'all' ? 'All' : f.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ position: 'relative' }}>
            <div style={{ display: activeTab === 'tokens' ? 'block' : 'none' }}>{renderTokenList(tokenItems, tokenListRef)}</div>
            <div style={{ display: activeTab === 'nfts' ? 'block' : 'none' }}>
              {virtualRows.length === 0
                ? <p style={styles.empty}>No NFTs found</p>
                : <NftVirtualList rows={virtualRows} listRef={nftListRef} renderRow={renderVirtualRow} />}
            </div>
          </div>
        </div>
      )}
      {selectedAsset && selectedOwnedData && (
        <Popup
          onClose={handleClosePopup}
          image={popupImage}
          placeholderEmoji={isLsp8Popup ? '🖼️' : isTokenPopup ? '💎' : '🖼️'}
          name={popupDisplayName}
          subLabel={popupDisplaySymbol}
          description={popupDesc}
          stats={popupStats}
          links={popupNormalizedLinks}
          attributes={popupAttrs}
          externalUrl={popupExternalUrl}
          debugText={popupDebug}
        />
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

const formatBigInt = (raw: string | null | undefined, decimals: number | null | undefined): string => {
  if (!raw) return '-';
  try { return ethers.formatUnits(BigInt(raw), decimals ?? 18); } catch { return raw; }
};

const formatTokenAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  if (num >= 1) return num.toFixed(2);
  return num.toFixed(6);
};

// ─── Styles ──────────────────────────────────────────────────

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
};
