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

// Retry: only on HTTP/network errors (throw), NOT on null results.
// null = "no image exists" — retrying won't help.
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

// ─── Persistent cache for API results ──────────────────────
// _tokenImageCache (LSP8 child NFTs):
//   string = found, null = server confirmed no image, undefined = not fetched or transient error
// _tokenImageInFlight: keys currently being fetched
// _tokenImageErrors: keys with transient errors (deleted on collapse, retried on next expand)
const _tokenImageCache = new Map<string, string | null>();
const _tokenImageInFlight = new Set<string>();

// Listeners: NftChildItem components subscribe to cache updates
type CacheListener = (key: string, value: string | null) => void;
const _cacheListeners = new Set<CacheListener>();

function notifyCacheUpdate(key: string, value: string | null) {
  _tokenImageInFlight.delete(key);
  if (value === '__error__') {
    // Transient error: remove from cache so next expand retries.
    // Don't notify listeners (keeps apiResult undefined → shows fallback)
    _tokenImageCache.delete(key);
  } else {
    _tokenImageCache.set(key, value);
    for (const listener of _cacheListeners) listener(key, value);
  }
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

// Batch fetch: multiple tokens in one query using _or filter
// Returns Map<cacheKey, url | null>
async function fetchTokenImageBatch(
  requests: { cacheKey: string; addr: string; tidHex: string }[]
): Promise<Map<string, string | null>> {
  if (requests.length === 0) return new Map();
  const whereClauses = requests.map(r => `{id:{_eq:"${r.addr.toLowerCase()}-${r.tidHex}"}}`).join(',');
  const query = `{Token(where:{_or:[${whereClauses}]}){id images{url}icons{url}}}`;
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const tokens = json.data?.Token ?? [];
  const result = new Map<string, string | null>();
  // Pre-populate all as null ("confirmed no image")
  for (const r of requests) result.set(r.cacheKey, null);
  // Override with actual results
  for (const t of tokens) {
    if (t?.images?.[0]?.url) {
      const url = toGatewayUrl(t.images[0].url) ?? null;
      const match = requests.find(r => t.id === `${r.addr.toLowerCase()}-${r.tidHex}`);
      if (match && url) result.set(match.cacheKey, url);
    } else if (t?.icons?.[0]?.url) {
      const url = toGatewayUrl(t.icons[0].url) ?? null;
      const match = requests.find(r => t.id === `${r.addr.toLowerCase()}-${r.tidHex}`);
      if (match && url) result.set(match.cacheKey, url);
    }
  }
  return result;
}

// ─── Cached icon type ──────────────────────────────────────

interface CachedIcon {
  url: string;
  scheme: string;
}

function resolveDaIcon(item: any): CachedIcon | null {
  if (!item) return null;
  const da = item.digitalAsset;
  if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'ownedAsset.digitalAsset.icons' };
  if (da?.images?.[0]?.url) return { url: toGatewayUrl(da.images[0].url)!, scheme: 'ownedAsset.digitalAsset.images' };
  if (da?.url?.startsWith('ipfs://')) return { url: toGatewayUrl(da.url)!, scheme: 'ownedAsset.digitalAsset.url' };
  return null;
}

// ─── types ─────────────────────────────────────────────────

interface TokenItem {
  id: string; name: string; symbol: string; amount: string;
  contractAddress: string; type: string;
  indexerIcon?: CachedIcon;
}

interface NftListEntry {
  id: string; name: string; symbol: string;
  tokenId: string; rawTokenId: string; contractAddress: string;
  collFallback?: CachedIcon;
  amount?: string;
}

interface NftCollEntry {
  isCollection: true;
  id: string; name: string; symbol: string;
  collectionIcon?: CachedIcon; count: number; children: NftListEntry[];
}

type NftRenderItem = NftListEntry | NftCollEntry;
const isColl = (x: NftRenderItem): x is NftCollEntry => 'isCollection' in x && x.isCollection;

// ─── Child item component ──────────────────────────────────
// Uses useNft for image, subscribes to cache for API fallback.
// Fallback chain: useNft.images → api.Token → useNft.icons → collFallback → 🖼️

function NftChildItem({ entry, collFallback, onClick, renderIcon, styles, shortenId, handleSelectAsset }: {
  entry: NftListEntry;
  collFallback?: CachedIcon;
  onClick: (e: React.MouseEvent) => void;
  renderIcon: (icon: CachedIcon | undefined, fallbackEmoji: string) => React.ReactNode;
  styles: Record<string, React.CSSProperties>;
  shortenId: (id: string, maxLen?: number) => string;
  handleSelectAsset: (type: 'token' | 'nft', addr: string, formattedTokenId?: string, e?: React.MouseEvent) => void;
}) {
  const { nft: nftData, isLoading: nftLoading } = useNft({
    address: entry.contractAddress.toLowerCase(),
    formattedTokenId: entry.tokenId,
    include: { images: true, icons: true, collection: { icons: true } },
  });

  const cacheKey = `${entry.contractAddress.toLowerCase()}-${toTokenIdHex(entry.tokenId)}`;

  // Subscribe to cache updates instead of polling
  const [apiResult, setApiResult] = useState<string | null | undefined>(() => {
    if (_tokenImageCache.has(cacheKey)) return _tokenImageCache.get(cacheKey)!;
    return undefined; // not yet fetched
  });

  useEffect(() => {
    // Check if result arrived while unmounted
    if (_tokenImageCache.has(cacheKey)) {
      setApiResult(_tokenImageCache.get(cacheKey)!);
      return;
    }
    // Subscribe to future updates
    const listener: CacheListener = (key, value) => {
      if (key === cacheKey) setApiResult(value);
    };
    _cacheListeners.add(listener);
    return () => { _cacheListeners.delete(listener); };
  }, [cacheKey]);

  const apiAttempted = apiResult !== undefined;

  // Resolve image: same priority chain as popup.
  // If useNft.images resolves → done immediately.
  // If API not attempted → undefined (wait, show no partial).
  // If API null-confirmed → fall through to icons / collFallback.
  const resolvedIcon = useMemo((): CachedIcon | undefined => {
    if (nftLoading) return undefined; // wait, don't show partial

    const da = nftData as any;

    // 1st: useNft.images -- if found, done (no API wait needed)
    if (da?.images) {
      const imgs = flattenImages(da);
      for (const u of imgs) {
        if (isUsableIpfs(u)) return { url: toGatewayUrl(u)!, scheme: 'useNft.images' };
      }
    }

    // 2nd: api.Token
    if (!apiAttempted) return undefined; // API not started yet -- wait
    if (apiResult) return { url: apiResult, scheme: 'api.token.images' }; // API found
    // API null-confirmed -- fall through to remaining fallbacks

    // 3rd: useNft.icons
    if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'useNft.icons' };

    // 4th: useNft.collection.icons
    if (da?.collection?.icons?.[0]?.url) return { url: toGatewayUrl(da.collection.icons[0].url)!, scheme: 'useNft.collection.icons' };

    // 5th: collFallback (final fallback after all attempts exhausted)
    return collFallback;
  }, [nftData, nftLoading, apiResult, apiAttempted, collFallback]);

  return (
    <div style={{ ...styles.item, marginLeft: '12px' }}
      onClick={(e) => handleSelectAsset('nft', entry.contractAddress, entry.tokenId, e)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
      {renderIcon(resolvedIcon, '🖼️')}
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
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const toggleSection = useCallback((key: string) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  const [iconCache, setIconCache] = useState<Map<string, CachedIcon>>(new Map());
  const fetchInFlight = useRef<Set<string>>(new Set());

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

      for (const e of filtered) { if (collIcon) e.collFallback = collIcon; }

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
        collFallback: resolveDaIcon(asset) || undefined,
        amount: asset.balance != null ? String(asset.balance) : '',
      });
    }

    return { nftTree: result.sort((a, b) => (a.name || '').localeCompare(b.name || '')), lsp7Nfts };
  }, [ownedTokens, ownedAssets, searchQuery]);

  // ─── Lazy icon loading (Token / LSP7 API fallback) ───────

  useEffect(() => {
    const keysToFetch: { key: string; fetchFn: () => Promise<string | null>; scheme: string }[] = [];

    const addFetch = (key: string, fetchFn: () => Promise<string | null>, scheme: string) => {
      if (fetchInFlight.current.has(key) || iconCache.has(key)) return;
      fetchInFlight.current.add(key);
      keysToFetch.push({ key, fetchFn, scheme });
    };

    for (const item of tokenItems) {
      if (item.type === 'LYX' || item.indexerIcon || !item.contractAddress) continue;
      addFetch(`token:${item.contractAddress.toLowerCase()}`, () => fetchAssetImage(item.contractAddress), 'api.asset.icons');
    }

    for (const item of lsp7Nfts) {
      if (item.collFallback) continue;
      addFetch(`coll:${item.id}`, () => fetchAssetImage(item.contractAddress), 'api.asset.icons');
    }

    for (const item of nftTree) {
      if (!isColl(item) || item.collectionIcon) continue;
      addFetch(`coll:${item.id.toLowerCase()}`, () => fetchAssetImage(item.id), 'api.asset.icons');
    }

    for (const { key, fetchFn, scheme } of keysToFetch) {
      fetchWithLimit(fetchFn).then(url => {
        fetchInFlight.current.delete(key);
        // Only cache if we actually found an image
        if (url) {
          setIconCache(prev => { const n = new Map(prev); n.set(key, { url, scheme }); return n; });
        }
      }).catch(() => {
        fetchInFlight.current.delete(key);
        // Don't cache errors — allows retry on next render cycle
      });
    }
  }, [tokenItems, lsp7Nfts, nftTree]); // NOTE: iconCache intentionally excluded to prevent infinite re-fetch

  // ─── Collection header + batch image pre-fetch ─────────────

  const getCachedIcon = useCallback((key: string, fallback?: CachedIcon): CachedIcon | undefined => {
    const cached = iconCache.get(key);
    // urlが空文字（APIで画像なし確認済み）の場合はフォールバックを使用
    if (cached && cached.url) return cached;
    return fallback;
  }, [iconCache]);

  function NftCollectionHeader({ coll }: { coll: NftCollEntry }) {
    const isExpanded = expandedCollections.has(coll.id.toLowerCase());
    const cIcon = getCachedIcon(`coll:${coll.id.toLowerCase()}`, coll.collectionIcon);

    // On expand: clear cache for all children so they always retry fresh
    useEffect(() => {
      if (!isExpanded) return;
      for (const child of coll.children) {
        const hex = toTokenIdHex(child.tokenId);
        const cKey = `${coll.id.toLowerCase()}-${hex}`;
        _tokenImageCache.delete(cKey);
        _tokenImageInFlight.delete(cKey);
      }
    }, [isExpanded, coll]);

    // Batch fetch: one GraphQL query for all children on expand
    useEffect(() => {
      if (!isExpanded) return;

      const pending = coll.children
        .map(child => {
          const hex = toTokenIdHex(child.tokenId);
          const cKey = `${coll.id.toLowerCase()}-${hex}`;
          if (_tokenImageCache.has(cKey) || _tokenImageInFlight.has(cKey)) return null;
          _tokenImageInFlight.add(cKey);
          return { cacheKey: cKey, addr: coll.id, tidHex: hex };
        })
        .filter(Boolean) as { cacheKey: string; addr: string; tidHex: string }[];

      if (pending.length === 0) return;

      fetchTokenImageBatch(pending).then(batchResult => {
        for (const [key, url] of batchResult) {
          notifyCacheUpdate(key, url);
        }
      }).catch(() => {
        // Transient error: clear in-flight for retry on next expand
        for (const p of pending) _tokenImageInFlight.delete(p.cacheKey);
      });
    }, [isExpanded, coll]);

    return (
      <div>
        <div style={{ ...styles.item, fontWeight: 600 }} onClick={() => toggleCollection(coll.id)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
          {renderIcon(cIcon, '📂')}
          <div style={styles.itemInfo}><span style={styles.itemName}>{coll.name}</span><span style={styles.itemSymbol}>{coll.count} NFTs</span></div>
          <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        </div>
        {isExpanded && <div style={{ paddingLeft: '8px' }}>
          {coll.children.map(child => (
            <NftChildItem
              key={child.id}
              entry={child}
              collFallback={child.collFallback}
              onClick={(e) => handleSelectAsset('nft', child.contractAddress, child.tokenId, e)}
              renderIcon={renderIcon}
              styles={styles}
              shortenId={shortenId}
              handleSelectAsset={handleSelectAsset}
            />
          ))}
        </div>}
      </div>
    );
  }

  const renderIcon = (icon: CachedIcon | undefined, fallbackEmoji: string) => (
    <div style={icon ? styles.itemIconWithImg : styles.itemIcon}>
      {icon ? <img src={icon.url} alt="" style={styles.itemIconImg} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span>{fallbackEmoji}</span>}
    </div>
  );

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

  const renderTokenList = (items: TokenItem[], _listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={_listRef}>
      {items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => {
        const icon = item.type === 'LYX' ? undefined : getCachedIcon(`token:${item.contractAddress?.toLowerCase() || item.id}`, item.indexerIcon);
        return (
          <div key={item.id} style={styles.item}
            onClick={(e) => handleSelectAsset('token' as const, item.contractAddress, undefined, e)}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
            {renderIcon(icon, '💎')}
            <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.symbol}</span></div>
            <div style={styles.itemAmount}>{item.type === 'LYX' ? `${parseFloat(item.amount || '0').toFixed(4)} LYX` : `${formatTokenAmount(item.amount || '0')} ${item.symbol}`}</div>
            <span style={styles.expandIcon}>›</span>
          </div>
        );
      })}
    </div>
  );

  const renderNftTree = (tree: NftRenderItem[], singleNfts: NftListEntry[], _listRef: React.RefObject<HTMLDivElement | null>) => {
    const hasCollections = tree.length > 0;
    const hasSingles = singleNfts.length > 0;
    if (!hasCollections && !hasSingles) return <p style={styles.empty}>No NFTs found</p>;
    const collTotal = (tree as NftCollEntry[]).reduce((s, c) => s + c.count, 0);

    return (
      <div style={styles.list} ref={_listRef}>
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
            {expandedSections.has('lsp7') && singleNfts.map((item) => {
              const icon = getCachedIcon(`coll:${item.id}`, item.collFallback);
              return (
                <div key={item.id} style={styles.item}
                  onClick={(e) => handleSelectAsset('nft', item.contractAddress, item.tokenId, e)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                  {renderIcon(icon, '🖼️')}
                  <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.amount ? `${item.amount} ${item.symbol}` : item.symbol}</span></div>
                  <span style={styles.expandIcon}>›</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  };

  // ─── Popup ───────────────────────────────────────────────

  const isLsp8Popup = selectedAsset?.type === 'nft' && !!selectedAsset?.formattedTokenId;
  const popupNftAddr = isLsp8Popup ? selectedAsset?.address : undefined;
  const popupNftTid = isLsp8Popup ? selectedAsset?.formattedTokenId : undefined;

  const { nft: popupNftData, isLoading: rawPopupNftLoading } = useNft(
    isLsp8Popup && popupNftAddr && popupNftTid
      ? { address: popupNftAddr.toLowerCase(), formattedTokenId: popupNftTid,
          include: { name: true, icons: true, images: true, description: true, links: true, attributes: true, category: true, collection: { baseUri: true, icons: true } } }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  const popupAssetKey = `${selectedAsset?.type}:${selectedAsset?.address}:${selectedAsset?.formattedTokenId || ''}`;
  const popupPrevKey = useRef('');

  // Timeout: if useNft takes >5s, stop waiting and proceed to API fallback
  const [popupNftTimedOut, setPopupNftTimedOut] = useState(false);
  useEffect(() => {
    if (!isLsp8Popup || !rawPopupNftLoading) { setPopupNftTimedOut(false); return; }
    const t = setTimeout(() => setPopupNftTimedOut(true), 5000);
    return () => clearTimeout(t);
  }, [isLsp8Popup, rawPopupNftLoading, popupAssetKey]);
  const popupNftLoading = isLsp8Popup ? (rawPopupNftLoading && !popupNftTimedOut) : false;

  const [popupApiImg, setPopupApiImg] = useState<string | null>(null);
  const [popupApiScheme, setPopupApiScheme] = useState<string | null>(null);
  const [popupApiLoading, setPopupApiLoading] = useState(false);
  const [popupApiDone, setPopupApiDone] = useState(false);

  useEffect(() => {
    if (popupPrevKey.current !== popupAssetKey) {
      popupPrevKey.current = popupAssetKey;
      setPopupApiImg(null); setPopupApiScheme(null); setPopupApiLoading(false);
      setPopupApiDone(false);
    }
  }, [popupAssetKey]);

  // API fallback — LSP8
  useEffect(() => {
    if (!isLsp8Popup) return;
    if (popupPrevKey.current !== popupAssetKey) return;
    if (popupNftLoading) return;
    const da = popupNftData as any;
    if (da?.images) {
      const imgs = flattenImages(da);
      if (imgs.length > 0) { setPopupApiDone(true); return; }
    }
    if (da?.icons?.[0]?.url) { setPopupApiDone(true); return; }

    const addr = da?.address || selectedOwnedData?.digitalAssetAddress || '';
    if (!addr || !popupNftTid) return;
    let cancelled = false;
    setPopupApiLoading(true);
    const hex = toTokenIdHex(popupNftTid);
    (async () => {
      // Direct fetch -- bypass rate limiter queue so popup isn't blocked by list batch
      try {
        const tokenUrl = await fetchTokenImage(addr, hex);
        if (!cancelled && tokenUrl) { setPopupApiImg(tokenUrl); setPopupApiScheme('api.token.images'); setPopupApiDone(true); setPopupApiLoading(false); return; }
      } catch { /* continue to asset fallback */ }
      try {
        const assetUrl = await fetchAssetImage(addr);
        if (!cancelled && assetUrl) { setPopupApiImg(assetUrl); setPopupApiScheme('api.asset.icons'); }
      } catch { /* no image */ }
      if (!cancelled) { setPopupApiDone(true); setPopupApiLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [isLsp8Popup, popupNftData, popupNftLoading, popupAssetKey, selectedOwnedData, popupNftTid]);

  // API fallback — Token / LSP7
  useEffect(() => {
    if (isLsp8Popup) return;
    if (popupPrevKey.current !== popupAssetKey) return;
    if (!selectedAsset) return;
    const da = selectedOwnedData?.digitalAsset as any;
    if (da?.icons?.[0]?.url || da?.images?.[0]?.url) { setPopupApiDone(true); return; }
    const addr = selectedOwnedData?.digitalAssetAddress || '';
    if (!addr) return;
    let cancelled = false;
    setPopupApiLoading(true);
    // Direct fetch -- bypass rate limiter queue
    fetchAssetImage(addr).then(url => {
      if (!cancelled && url) { setPopupApiImg(url); setPopupApiScheme('api.asset.icons'); }
      if (!cancelled) { setPopupApiDone(true); setPopupApiLoading(false); }
    }).catch(() => {
      if (!cancelled) { setPopupApiDone(true); setPopupApiLoading(false); }
    });
    return () => { cancelled = true; };
  }, [isLsp8Popup, popupAssetKey, selectedAsset, selectedOwnedData]);

  // Popup image resolution — same chain as NftChildItem
  const popupImage = useMemo((): { url: string | null; scheme: string } => {
    if (isLsp8Popup) {
      if (popupNftLoading) return { url: null, scheme: 'loading' };
      const da = popupNftData as any;

      // 1st: useNft.images
      if (da?.images) {
        const imgs = flattenImages(da);
        if (imgs.length > 0) return { url: toGatewayUrl(imgs[0])!, scheme: 'useNft.images' };
      }

      // 2nd: api.Token (wait for it if not done)
      if (!popupApiDone) return { url: null, scheme: 'loading' };
      if (popupApiImg) return { url: popupApiImg, scheme: popupApiScheme || 'api' };

      // 3rd: useNft.icons (fallback after API exhausted)
      if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'useNft.icons' };
      if (da?.collection?.icons?.[0]?.url) return { url: toGatewayUrl(da.collection.icons[0].url)!, scheme: 'useNft.collection.icons' };

      // 4th: ownedToken indexer
      const nftIdx = (selectedOwnedData as any)?.nft;
      if (nftIdx?.icons?.[0]?.url) return { url: toGatewayUrl(nftIdx.icons[0].url)!, scheme: 'ownedToken.nft.icons' };
      if (nftIdx?.images?.[0]?.url) return { url: toGatewayUrl(nftIdx.images[0].url)!, scheme: 'ownedToken.nft.images' };
    }

    // Token / LSP7
    const da = selectedOwnedData?.digitalAsset as any;
    if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'ownedAsset.digitalAsset.icons' };
    if (da?.images?.[0]?.url) return { url: toGatewayUrl(da.images[0].url)!, scheme: 'ownedAsset.digitalAsset.images' };
    if (da?.url?.startsWith('ipfs://')) return { url: toGatewayUrl(da.url)!, scheme: 'ownedAsset.digitalAsset.url' };
    if (popupApiImg) return { url: popupApiImg, scheme: popupApiScheme || 'api' };
    if (popupApiLoading) return { url: null, scheme: 'loading' };
    return { url: null, scheme: 'none' };
  }, [isLsp8Popup, popupNftData, popupNftLoading, popupApiImg, popupApiScheme, popupApiLoading, popupApiDone, selectedOwnedData]);

  // Debug info
  const popupDebug = useMemo(() => {
    const p: string[] = [];
    if (isLsp8Popup) {
      p.push(`[LSP8] selected: ${popupImage.scheme}`);
      const da = popupNftData as any;
      const imgUrls = da?.images ? flattenImages(da) : [];
      p.push(`1st useNft.images: ${imgUrls.length > 0 ? '✓ ' + imgUrls[0] : '(empty)'}`);
      p.push(`2nd api.token: ${popupApiLoading ? '⏳' : popupApiImg ? '✓ ' + popupApiImg : '(empty)'} [${popupApiScheme || '-'}]`);
      p.push(`3rd useNft.icons: ${da?.icons?.[0]?.url || '(empty)'}`);
      p.push(`4th useNft.coll.icons: ${da?.collection?.icons?.[0]?.url || '(empty)'}`);
      const nftIdx = (selectedOwnedData as any)?.nft;
      p.push(`5th idx.nft: ${nftIdx?.icons?.[0]?.url || nftIdx?.images?.[0]?.url || '(empty)'}`);
      p.push(`final: ${popupImage.url || '(null)'}`);
    } else {
      p.push(`[Token/LSP7] selected: ${popupImage.scheme}`);
      const da = selectedOwnedData?.digitalAsset as any;
      p.push(`1st idx.da: ${da?.icons?.[0]?.url || da?.images?.[0]?.url || da?.url || '(empty)'}`);
      p.push(`2nd api: ${popupApiLoading ? '⏳' : popupApiImg ? '✓ ' + popupApiImg : '(empty)'} [${popupApiScheme || '-'}]`);
      p.push(`final: ${popupImage.url || '(null)'}`);
    }
    return p.join('\n');
  }, [isLsp8Popup, popupImage, popupNftData, selectedOwnedData, popupApiLoading, popupApiImg, popupApiScheme]);

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
              <details style={debugStyles.details}><summary style={debugStyles.summary}>🔍 Debug: Image Resolution</summary><div style={debugStyles.content}>{popupDebug}</div></details>
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
  container: { marginBottom: '8px' },
  details: { fontSize: '0.58rem', color: '#6b7280', borderRadius: '6px', border: '1px solid #e5e7eb', overflow: 'hidden' },
  summary: { padding: '4px 8px', background: '#f9fafb', cursor: 'pointer', fontWeight: 600, fontSize: '0.65rem', color: '#374151', userSelect: 'none' },
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
