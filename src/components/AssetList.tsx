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

// ─── Rate limiter: max 3 concurrent fetches to stay under Envio's limit ─
let _activeFetches = 0;
const _fetchQueue: { fn: () => Promise<string | null>; resolve: (v: string | null) => void; reject: () => void }[] = [];

function _drainQueue() {
  while (_activeFetches < 3 && _fetchQueue.length > 0) {
    _activeFetches++;
    const { fn, resolve, reject } = _fetchQueue.shift()!;
    fn().then(resolve).catch(reject).finally(() => { _activeFetches--; _drainQueue(); });
  }
}

function fetchWithLimit(fn: () => Promise<string | null>): Promise<string | null> {
  return new Promise((resolve, reject) => {
    _fetchQueue.push({ fn, resolve, reject });
    _drainQueue();
  });
}

async function fetchAssetImage(addr: string): Promise<string | null> {
  const query = `{Asset(where:{id:{_eq:"${addr.toLowerCase()}"}},limit:1){icons{url}images{url}url}}`;
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
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
  const json = await res.json();
  const t = json.data?.Token?.[0];
  if (t?.images?.[0]?.url) return toGatewayUrl(t.images[0].url) ?? null;
  if (t?.icons?.[0]?.url) return toGatewayUrl(t.icons[0].url) ?? null;
  return null;
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
  collFallback?: CachedIcon; // collection icon from collEntry
  amount?: string;
}

interface NftCollEntry {
  isCollection: true;
  id: string; name: string; symbol: string;
  collectionIcon?: CachedIcon; count: number; children: NftListEntry[];
}

type NftRenderItem = NftListEntry | NftCollEntry;
const isColl = (x: NftRenderItem): x is NftCollEntry => 'isCollection' in x && x.isCollection;

// ─── Child item component (uses useNft for exact image match with popup) ──

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

  // Resolve image same as popup, with API fallback
  const [childApiImg, setChildApiImg] = useState<string | null>(null);
  const [childApiLoading, setChildApiLoading] = useState(false);

  // API fallback to Token table (runs only if useNft has no images)
  useEffect(() => {
    if (nftLoading) return;
    const da = nftData as any;
    // Check if useNft already provides images/individual icon
    if (da?.images) {
      const imgs = flattenImages(da);
      if (imgs.length > 0) return;
    }
    if (da?.icons?.[0]?.url) return;

    // Fallback to Token table (may have images even when useNft doesn't)
    // Uses rate limiter to avoid Envio GraphQL overload
    let cancelled = false;
    setChildApiLoading(true);
    const hex = toTokenIdHex(entry.tokenId);

    fetchWithLimit(() => fetchTokenImage(entry.contractAddress, hex)).then(url => {
      if (!cancelled && url) setChildApiImg(url);
      if (!cancelled) setChildApiLoading(false);
    }).catch(() => {
      // Silent fail — useNft fallback will handle it
      if (!cancelled) setChildApiLoading(false);
    });

    return () => { cancelled = true; };
  }, [nftData, nftLoading, entry.contractAddress, entry.tokenId]);

  // Resolve image same as popup (including API fallback)
  const resolvedIcon = useMemo((): CachedIcon | undefined => {
    if (nftLoading) return undefined;
    const da = nftData as any;

    // 1st: useNft.images (no isUsableIpfs filter — trust useNft data)
    if (da?.images) {
      const imgs = flattenImages(da);
      if (imgs.length > 0) return { url: toGatewayUrl(imgs[0])!, scheme: 'useNft.images' };
    }

    // If API is loading, show placeholder (don't flash fallback icon)
    if (childApiLoading) return undefined;

    // 2nd: API fallback — Token table (individual token image)
    if (childApiImg) return { url: childApiImg, scheme: 'api.token.images' };

    // 3rd: useNft.icons (per-token icon)
    if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'useNft.icons' };

    // 4th: useNft.collection.icons (collection-level icon)
    if (da?.collection?.icons?.[0]?.url) return { url: toGatewayUrl(da.collection.icons[0].url)!, scheme: 'useNft.collection.icons' };

    // 5th: collFallback (collection icon from ownedAssets)
    return collFallback;
  }, [nftData, nftLoading, childApiImg, childApiLoading, collFallback]);

  return (
    <div style={{ ...styles.item, marginLeft: '12px' }}
      onClick={(e) => handleSelectAsset('nft', entry.contractAddress, entry.tokenId, e)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
      {renderIcon(nftLoading ? undefined : resolvedIcon, nftLoading ? '⏳' : '🖼️')}
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

  const toggleSection = useCallback((key: string) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  // Cached icons from API fallbacks (Token/LSP7 only; LSP8 children use useNft)
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
        // NO indexerIcon — LSP8 children use useNft via NftChildItem
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

      // Set collFallback on children (for when useNft fails)
      for (const e of filtered) {
        if (collIcon) e.collFallback = collIcon;
      }

      result.push({ isCollection: true, id: addr, name: collName, symbol: collEntry?.digitalAsset?.symbol || entries[0].symbol, collectionIcon: collIcon, count: filtered.length, children: filtered });
    }

    // LSP7-like NFTs
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
    const seen = new Set<string>();

    const addFetch = (key: string, fetchFn: () => Promise<string | null>, scheme: string) => {
      if (seen.has(key) || fetchInFlight.current.has(key)) return;
      if (iconCache.has(key)) return;
      seen.add(key);
      keysToFetch.push({ key, fetchFn, scheme });
      fetchInFlight.current.add(key);
    };

    // Token items
    for (const item of tokenItems) {
      if (item.type === 'LYX') continue;
      if (item.indexerIcon) continue;
      const addr = item.contractAddress;
      if (!addr) continue;
      const key = `token:${(addr as string).toLowerCase()}`;
      addFetch(key, () => fetchAssetImage(addr), 'api.asset.icons');
    }

    // LSP7 NFTs
    for (const item of lsp7Nfts) {
      if (item.collFallback) continue;
      const key = `coll:${item.id}`;
      if (fetchInFlight.current.has(key)) continue;
      if (iconCache.has(key)) continue;
      addFetch(key, () => fetchAssetImage(item.contractAddress), 'api.asset.icons');
    }

    // LSP8 Collection headers
    for (const item of nftTree) {
      if (!isColl(item)) continue;
      if (item.collectionIcon) continue;
      const key = `coll:${item.id.toLowerCase()}`;
      if (fetchInFlight.current.has(key) || iconCache.has(key)) continue;
      addFetch(key, () => fetchAssetImage(item.id), 'api.asset.icons');
    }

    // LSP8 Collection headers
    for (const item of nftTree) {
      if (!isColl(item)) continue;
      if (item.collectionIcon) continue;
      const key = `coll:${item.id.toLowerCase()}`;
      if (iconCache.has(key)) continue;
      addFetch(key, () => fetchAssetImage(item.id), 'api.asset.icons');
    }

    for (const { key, fetchFn, scheme } of keysToFetch) {
      fetchFn().then(url => {
        // Remove from in-flight so re-renders can retry on failure
        fetchInFlight.current.delete(key);
        if (url) setIconCache(prev => { const n = new Map(prev); n.set(key, { url, scheme }); return n; });
      }).catch(() => {
        fetchInFlight.current.delete(key);
      });
    }
  }, [tokenItems, lsp7Nfts, nftTree, iconCache]);

  // ─── Icon lookup ─────────────────────────────────────────

  const getCachedIcon = useCallback((key: string, collFallback?: CachedIcon): CachedIcon | undefined => {
    return iconCache.get(key) || collFallback;
  }, [iconCache]);

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
        {/* ─── Collection NFTs (LSP8) ─── */}
        {hasCollections && (
          <>
            <SectionHeader label="Collection NFT" protocol="LSP8" count={collTotal} sectionKey="lsp8" />
            {expandedSections.has('lsp8') && tree.map((item) => {
              const coll = item as NftCollEntry;
              const isExpanded = expandedCollections.has(coll.id.toLowerCase());
              const cIcon = getCachedIcon(`coll:${coll.id.toLowerCase()}`, coll.collectionIcon);
              return (
                <div key={coll.id}>
                  <div style={{ ...styles.item, fontWeight: 600 }} onClick={() => toggleCollection(coll.id)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                    {renderIcon(cIcon, '📂')}
                    <div style={styles.itemInfo}><span style={styles.itemName}>{coll.name}</span><span style={styles.itemSymbol}>{coll.count} NFTs</span></div>
                    <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                  </div>
                  {isExpanded && <div style={{ paddingLeft: '8px' }}>
                    {coll.children.map((child: NftListEntry) => (
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
            })}
          </>
        )}

        {hasCollections && hasSingles && <div style={{ height: '1px', background: '#e2e8f0', margin: '8px 0' }} />}

        {/* ─── Single NFTs (LSP7) ─── */}
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

  // ─── Popup: image resolution by type ─────────────────────

  const isLsp8Popup = selectedAsset?.type === 'nft' && !!selectedAsset?.formattedTokenId;
  const popupNftAddr = isLsp8Popup ? selectedAsset?.address : undefined;
  const popupNftTid = isLsp8Popup ? selectedAsset?.formattedTokenId : undefined;

  const { nft: popupNftData, isLoading: popupNftLoading } = useNft(
    isLsp8Popup && popupNftAddr && popupNftTid
      ? { address: popupNftAddr.toLowerCase(), formattedTokenId: popupNftTid,
          include: { name: true, icons: true, images: true, description: true, links: true, attributes: true, category: true, collection: { baseUri: true, icons: true } } }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  const [popupApiImg, setPopupApiImg] = useState<string | null>(null);
  const [popupApiScheme, setPopupApiScheme] = useState<string | null>(null);
  const [popupApiLoading, setPopupApiLoading] = useState(false);
  const popupApiDone = useRef(false); // true when API attempt has completed (success or fail)
  const popupAssetKey = `${selectedAsset?.type}:${selectedAsset?.address}:${selectedAsset?.formattedTokenId || ''}`;
  const popupPrevKey = useRef('');
  useEffect(() => {
    if (popupPrevKey.current !== popupAssetKey) {
      popupPrevKey.current = popupAssetKey;
      setPopupApiImg(null); setPopupApiScheme(null); setPopupApiLoading(false);
      popupApiDone.current = false; // reset for new asset
    }
  }, [popupAssetKey]);

  // API fallback — LSP8
  useEffect(() => {
    if (!isLsp8Popup) return;
    if (popupPrevKey.current !== popupAssetKey) return;
    if (popupNftLoading) return;
    const da = popupNftData as any;
    // Check if useNft already provides images/individual icon
    if (da?.images) {
      const imgs = flattenImages(da);
      if (imgs.length > 0) return;
    }
    if (da?.icons?.[0]?.url) return;

    const addr = da?.address || selectedOwnedData?.digitalAssetAddress || '';
    if (!addr || !popupNftTid) return;
    let cancelled = false;
    setPopupApiLoading(true);
    const hex = toTokenIdHex(popupNftTid);
    (async () => {
      const tokenUrl = await fetchTokenImage(addr, hex);
      if (!cancelled && tokenUrl) { setPopupApiImg(tokenUrl); setPopupApiScheme('api.token.images'); popupApiDone.current = true; setPopupApiLoading(false); return; }
      const assetUrl = await fetchAssetImage(addr);
      if (!cancelled && assetUrl) { setPopupApiImg(assetUrl); setPopupApiScheme('api.asset.icons'); }
      if (!cancelled) { popupApiDone.current = true; setPopupApiLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [isLsp8Popup, popupNftData, popupNftLoading, popupAssetKey, selectedOwnedData, popupNftTid]);

  // API fallback — Token / LSP7
  useEffect(() => {
    if (isLsp8Popup) return;
    if (popupPrevKey.current !== popupAssetKey) return;
    if (!selectedAsset) return;
    const da = selectedOwnedData?.digitalAsset as any;
    if (da?.icons?.[0]?.url || da?.images?.[0]?.url) return;
    const addr = selectedOwnedData?.digitalAssetAddress || '';
    if (!addr) return;
    let cancelled = false;
    setPopupApiLoading(true);
    fetchAssetImage(addr).then(url => {
      if (!cancelled && url) { setPopupApiImg(url); setPopupApiScheme('api.asset.icons'); }
      if (!cancelled) { popupApiDone.current = true; setPopupApiLoading(false); }
    });
    return () => { cancelled = true; };
  }, [isLsp8Popup, popupAssetKey, selectedAsset, selectedOwnedData]);

  const popupImage = useMemo((): { url: string | null; scheme: string } => {
    if (popupNftLoading) return { url: null, scheme: 'loading' };
    if (isLsp8Popup) {
      const da = popupNftData as any;
      // 1st: useNft.images (available immediately from useNft hook)
      if (da?.images) {
        const imgs = flattenImages(da);
        if (imgs.length > 0) return { url: toGatewayUrl(imgs[0])!, scheme: 'useNft.images' };
      }

      // FIXED: Check if asset key changed (useEffect hasn't reset popupApiDone yet!)
      const isNewAsset = popupPrevKey.current !== popupAssetKey;
      const apiDone = isNewAsset ? false : popupApiDone.current;

      // useNft.images unavailable → need API fallback
      // While API hasn't completed, show loading to prevent 🖼️ flicker
      if (!apiDone) return { url: null, scheme: 'loading' };

      // API completed — check if it found an image
      if (popupApiImg && popupApiScheme === 'api.token.images') return { url: popupApiImg, scheme: popupApiScheme };
      if (popupApiImg && popupApiScheme === 'api.asset.icons') return { url: popupApiImg, scheme: popupApiScheme };

      // API returned nothing → fallback to icons (these are from useNft, safe to show)
      if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'useNft.icons' };
      if (da?.collection?.icons?.[0]?.url) return { url: toGatewayUrl(da.collection.icons[0].url)!, scheme: 'useNft.collection.icons' };
      const nftIdx = (selectedOwnedData as any)?.nft;
      if (nftIdx?.icons?.[0]?.url) return { url: toGatewayUrl(nftIdx.icons[0].url)!, scheme: 'ownedToken.nft.icons' };
      if (nftIdx?.images?.[0]?.url) return { url: toGatewayUrl(nftIdx.images[0].url)!, scheme: 'ownedToken.nft.images' };
    }
    // Token / LSP7 path
    const da = selectedOwnedData?.digitalAsset as any;
    if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'ownedAsset.digitalAsset.icons' };
    if (da?.images?.[0]?.url) return { url: toGatewayUrl(da.images[0].url)!, scheme: 'ownedAsset.digitalAsset.images' };
    if (da?.url?.startsWith('ipfs://')) return { url: toGatewayUrl(da.url)!, scheme: 'ownedAsset.digitalAsset.url' };
    if (popupApiImg) return { url: popupApiImg, scheme: popupApiScheme || 'api' };
    return { url: null, scheme: 'none' };
  }, [isLsp8Popup, popupNftData, popupNftLoading, popupApiLoading, popupApiImg, popupApiScheme, selectedOwnedData]);

  const popupDebug = useMemo(() => {
    const p: string[] = [];
    const scheme = popupImage.scheme;

    if (isLsp8Popup) {
      p.push(`[LSP8] selected: ${scheme}`);
      const reasons: string[] = [];
      const da = popupNftData as any;

      // 1st: useNft.images
      const imgUrls = da?.images ? flattenImages(da) : [];
      if (imgUrls.length > 0) {
        reasons.push(`1st: useNft.images ✓` + imgUrls.map((u: string) => `\n${u}`).join(''));
      } else {
        reasons.push(`1st: useNft.images (empty)`);
      }

      // 2nd: api.token.images
      if (popupApiScheme === 'api.token.images' && popupApiImg) reasons.push(`2nd: api.token.images ✓\n${popupApiImg}`);
      else if (popupApiLoading) reasons.push(`2nd: api.token.images (loading)`);
      else reasons.push(`2nd: api.token.images (not fetched)`);

      // 3rd: useNft.icons
      const nIconUrl = da?.icons?.[0]?.url;
      if (nIconUrl) reasons.push(`3rd: useNft.icons\n${nIconUrl}`);
      else reasons.push(`3rd: useNft.icons (empty)`);

      // 4th: useNft.collection.icons
      const cIconUrl = da?.collection?.icons?.[0]?.url;
      if (cIconUrl) reasons.push(`4th: useNft.collection.icons\n${cIconUrl}`);
      else reasons.push(`4th: useNft.collection.icons (empty)`);

      // 5th: api.asset.icons
      if (popupApiScheme === 'api.asset.icons' && popupApiImg) reasons.push(`5th: api.asset.icons ✓\n${popupApiImg}`);
      else if (popupApiLoading && popupApiScheme === null) reasons.push(`5th: api.asset.icons (loading)`);
      else reasons.push(`5th: api.asset.icons (not fetched)`);

      // 6th: ownedToken indexer fallback
      const nftIdx = (selectedOwnedData as any)?.nft;
      if (nftIdx?.images?.[0]?.url) reasons.push(`6th: ownedToken.nft.images\n${nftIdx.images[0].url}`);
      else if (nftIdx?.icons?.[0]?.url) reasons.push(`6th: ownedToken.nft.icons\n${nftIdx.icons[0].url}`);
      else reasons.push(`6th: ownedToken.nft (empty)`);

      p.push(reasons.join('\n'));
      if (scheme === 'loading') p.push(`\n→ waiting for API response… (⌛️ shown)`);
      else if (scheme === 'none') p.push(`\n→ no image found, showing 🖼️`);
      else {
        const sel = reasons.find(r => r.includes('✓'));
        if (sel) p.push(`\n→ using: ${sel.split(':')[1]?.trim().replace(' ✓', '')}`);
        else p.push(`\n→ no image found, showing 🖼️`);
      }
    } else {
      p.push(`[Token/LSP7] selected: ${scheme}`);
      const da = selectedOwnedData?.digitalAsset as any;
      const reasons: string[] = [];
      if (da?.icons?.[0]?.url) reasons.push(`1st: ownedAsset.digitalAsset.icons ✓\n${da.icons[0].url}`);
      else if (da?.images?.[0]?.url) reasons.push(`1st: ownedAsset.digitalAsset.images ✓\n${da.images[0].url}`);
      else if (da?.url?.startsWith('ipfs://')) reasons.push(`1st: ownedAsset.digitalAsset.url ✓\n${da.url}`);
      else reasons.push(`1st: ownedAsset.digitalAsset (empty)`);
      if (popupApiLoading) reasons.push(`2nd: api.asset.icons (loading)`);
      else if (popupApiScheme === 'api.asset.icons' && popupApiImg) reasons.push(`2nd: api.asset.icons ✓\n${popupApiImg}`);
      else reasons.push(`2nd: api.asset.icons (empty or not fetched)`);
      p.push(reasons.join('\n'));
      const sel = reasons.find(r => r.includes('✓'));
      if (sel) p.push(`\n→ using: ${sel.split(':')[1]?.trim().replace(' ✓', '')}`);
      else p.push(`→ no image found, showing 🖼️`);
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
  itemIcon: { width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', overflow: 'hidden', flexShrink: 0 },
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
