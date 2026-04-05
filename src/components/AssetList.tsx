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

const INDEXER_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── API fallback fetchers ──────────────────────────────────

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

const toTokenIdHex = (tid: string): string => {
  if (tid.startsWith('0x')) return tid;
  const digits = tid.replace(/[^0-9]/g, '');
  if (!digits) return '0x' + tid.padStart(64, '0').slice(-64);
  return '0x' + BigInt(digits).toString(16).padStart(64, '0');
};

// ─── Cached icon type ──────────────────────────────────────

interface CachedIcon {
  url: string;
  scheme: string;
}

// Token-level indexer image resolution (sync)
function resolveTokenIndexerIcon(item: any): CachedIcon | null {
  if (!item) return null;
  const da = item.digitalAsset;
  if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'indexer.da.icons' };
  if (da?.images?.[0]?.url) return { url: toGatewayUrl(da.images[0].url)!, scheme: 'indexer.da.images' };
  const daUrl = da?.url;
  if (daUrl?.startsWith('ipfs://')) return { url: toGatewayUrl(daUrl)!, scheme: 'indexer.da.url' };
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
  indexerIcon?: CachedIcon; amount?: string;
}

interface NftCollEntry {
  isCollection: true;
  id: string; name: string; symbol: string;
  collectionIcon?: CachedIcon; count: number; children: NftListEntry[];
}

type NftRenderItem = NftListEntry | NftCollEntry;
const isColl = (x: NftRenderItem): x is NftCollEntry => 'isCollection' in x && x.isCollection;

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
    setExpandedSections(prev => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }, []);

  // Cached icons from API fallbacks
  const [iconCache, setIconCache] = useState<Map<string, CachedIcon>>(new Map());
  const fetchDone = useRef<Set<string>>(new Set());

  const {
    ownedAssets, hasNextPage: hasMoreAssets, fetchNextPage: fetchMoreAssets,
    isFetchingNextPage: loadingMoreAssets, isLoading: loadingAssets,
  } = useInfiniteOwnedAssets({
    filter: { holderAddress: targetAddress?.toLowerCase() || '' },
    include: { balance: true, digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true, url: true } },
    pageSize: 500,
  });

  const {
    ownedTokens, hasNextPage: hasMoreTokens, fetchNextPage: fetchMoreTokens,
    isFetchingNextPage: loadingMoreTokens, isLoading: loadingTokens,
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
    setExpandedCollections(prev => { const n = new Set(prev); const k = id.toLowerCase(); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClosePopup(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [handleClosePopup]);

  // ─── Token items (with indexer icon data) ────────────────

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
        indexerIcon: resolveTokenIndexerIcon(item) || undefined,
      }));
    return [lyxItem, ...[...items].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))];
  }, [lyxBalance, ownedAssets, searchQuery]);

  // ─── NFT tree ────────────────────────────────────────────

  const { nftTree, lsp7Nfts } = useMemo(() => {
    const addrMap = new Map<string, NftListEntry[]>();

    for (const item of (ownedTokens || [])) {
      const addr = item.digitalAssetAddress?.toLowerCase() || '';
      const nftIcon = item.nft?.icons?.[0]?.url ? { url: toGatewayUrl(item.nft.icons[0].url)!, scheme: 'indexer.nft.icons' } : undefined;
      const entry: NftListEntry = {
        id: `${addr}-${item.tokenId}`,
        name: item.nft?.name || item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        tokenId: item.nft?.formattedTokenId || item.tokenId,
        rawTokenId: item.tokenId,
        contractAddress: item.digitalAssetAddress,
        indexerIcon: nftIcon,
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

      const collEntry = (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === addr && (a.digitalAsset?.tokenType === 'NFT' || a.digitalAsset?.tokenType === 'COLLECTION'));
      const collName = collEntry?.digitalAsset?.name || filtered[0].name.replace(/ #\d+$/, '') || filtered[0].name;
      const collIcon = resolveTokenIndexerIcon(collEntry) || undefined;

      // Always treat as collection (even with 1 NFT) for UX consistency
      result.push({ isCollection: true, id: addr, name: collName, symbol: collEntry?.digitalAsset?.symbol || entries[0].symbol, collectionIcon: collIcon, count: filtered.length, children: filtered });
    }

    // LSP7-like NFTs (tokenType NFT/COLLECTION but no ownedTokens entries)
    // These are single NFT items without tokenId — rendered separately
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
        indexerIcon: resolveTokenIndexerIcon(asset) || undefined,
        amount: asset.balance != null ? String(asset.balance) : '',
      });
    }

    return { nftTree: result.sort((a, b) => (a.name || '').localeCompare(b.name || '')), lsp7Nfts };
  }, [ownedTokens, ownedAssets, searchQuery]);

  // Track which keys have been fetched or are currently fetching (persists across re-renders)
  const fetchInFlight = useRef<Set<string>>(new Set());

  // ─── Lazy icon loading (API fallback) ────────────────────

  useEffect(() => {
    // Collect all keys that need fetching
    const keysToFetch: { key: string; fetchFn: () => Promise<string | null>; scheme: string }[] = [];
    const seen = new Set<string>();

    // Helper to add a fetch job
    const addFetch = (key: string, fetchFn: () => Promise<string | null>, scheme: string) => {
      if (seen.has(key) || fetchInFlight.current.has(key)) return;
      if (iconCache.has(key)) return;  // already cached
      seen.add(key);
      keysToFetch.push({ key, fetchFn, scheme });
      fetchInFlight.current.add(key);
    };

    // --- Token items ---
    for (const item of tokenItems) {
      if (item.type === 'LYX') continue;
      if (item.indexerIcon) continue;
      const addr = (item as TokenItem).contractAddress;
      if (!addr) continue;
      const key = `token:${addr.toLowerCase() || item.id}`;
      addFetch(key, () => fetchAssetImage(addr), 'api.Asset');
    }

    // --- NFT collections and children ---
    for (const item of nftTree) {
      if (isColl(item)) {
        // Collection header
        if (!item.collectionIcon) {
          const key = `coll:${item.id.toLowerCase()}`;
          addFetch(key, () => fetchAssetImage(item.id), 'api.Asset');
        }
        // Children
        for (const c of item.children) {
          if (c.indexerIcon) continue;
          const key = `nft:${c.id}`;
          const addr = c.contractAddress;
          const tid = c.tokenId;
          if (tid) {
            const hex = toTokenIdHex(tid);
            addFetch(key, () => fetchTokenImage(addr, hex), 'api.Token');
          } else {
            addFetch(key, () => fetchAssetImage(addr), 'api.Asset');
          }
        }
      } else if (!item.indexerIcon) {
        // Single NFT / LSP7-like
        if (item.tokenId) {
          const key = `nft:${item.id}`;
          const hex = toTokenIdHex(item.tokenId);
          addFetch(key, () => fetchTokenImage(item.contractAddress, hex), 'api.Token');
        } else {
          const key = `coll:${item.id}`;
          addFetch(key, () => fetchAssetImage(item.contractAddress), 'api.Asset');
        }
      }
    }

    // Execute all fetches (fire-and-forget, results always cached)
    for (const { key, fetchFn, scheme } of keysToFetch) {
      fetchFn().then(url => {
        if (url) {
          setIconCache(prev => { const n = new Map(prev); n.set(key, { url, scheme }); return n; });
        }
      }).catch(() => { /* ignore network errors */ });
    }

    // No cleanup — we want fetch results to persist
  }, [tokenItems, nftTree]);

  // Section header component
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

  // ─── Icon lookup helper ──────────────────────────────────

  const getCachedIcon = useCallback((key: string, indexerIcon?: CachedIcon): CachedIcon | undefined => {
    return indexerIcon || iconCache.get(key);
  }, [iconCache]);

  const renderIcon = (icon: CachedIcon | undefined, fallbackEmoji: string) => (
    <div style={icon ? styles.itemIconWithImg : styles.itemIcon}>
      {icon ? <img src={icon.url} alt="" style={styles.itemIconImg} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span>{fallbackEmoji}</span>}
    </div>
  );

  // ─── render ──────────────────────────────────────────────

  const showPlaceholder = !targetAddress;

  const renderTokenList = (items: TokenItem[], _listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={_listRef}>
      {items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => {
        const icon = item.type === 'LYX'
          ? undefined
          : getCachedIcon(`token:${item.contractAddress?.toLowerCase() || item.id}`, (item as TokenItem).indexerIcon);
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

  // Auto-expand single-item collections (but don't auto-expand sections)
  useEffect(() => {
    setExpandedCollections(prev => {
      const updated = new Set(prev);
      for (const item of nftTree) {
        const isAlreadyIn = updated.has(item.id.toLowerCase());
        if (isAlreadyIn) continue;
        const coll = item as NftCollEntry;
        if (coll.count === 1) updated.add(coll.id.toLowerCase());
      }
      return updated;
    });
  }, [nftTree]);

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
                    {coll.children.map((child: NftListEntry) => {
                      const icon = getCachedIcon(`nft:${child.id}`, child.indexerIcon);
                      return (
                        <div key={child.id} style={{ ...styles.item, marginLeft: '12px' }}
                          onClick={(e) => handleSelectAsset('nft', child.contractAddress, child.tokenId, e)}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                          {renderIcon(icon, '🖼️')}
                          <div style={styles.itemInfo}><span style={styles.itemName}>{child.name}</span><span style={styles.itemSymbol}>{child.tokenId ? `#${shortenId(child.tokenId, 16)}` : `${child.symbol}${child.amount ? ` (${child.amount})` : ''}`}</span></div>
                          <span style={styles.expandIcon}>›</span>
                        </div>
                      );
                    })}
                  </div>}
                </div>
              );
            })}
          </>
        )}

        {/* ─── Separator ─── */}
        {hasCollections && hasSingles && (
          <div style={{ height: '1px', background: '#e2e8f0', margin: '8px 0' }} />
        )}

        {/* ─── Single NFTs (LSP7) ─── */}
        {hasSingles && (
          <>
            <SectionHeader label="Single NFT" protocol="LSP7" count={singleNfts.length} sectionKey="lsp7" />
            {expandedSections.has('lsp7') && singleNfts.map((item) => {
              const icon = getCachedIcon(`coll:${item.id}`, item.indexerIcon);
              return (
                <div key={item.id} style={styles.item}
                  onClick={(e) => handleSelectAsset('nft', item.contractAddress, item.tokenId, e)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                  {renderIcon(icon, '🖼️')}
                  <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.symbol}{item.amount ? ` (${item.amount})` : ''}</span></div>
                  <span style={styles.expandIcon}>›</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    );
  };

  // ─── Popup: useNft for rich data ─────────────────────────

  const isNftPopup = selectedAsset?.type === 'nft';
  const popupNftAddr = isNftPopup ? selectedAsset?.address : undefined;
  const popupNftTid = isNftPopup ? selectedAsset?.formattedTokenId : undefined;
  const { nft: popupNftData, isLoading: popupNftLoading } = useNft(
    popupNftAddr && popupNftTid
      ? { address: popupNftAddr.toLowerCase(), formattedTokenId: popupNftTid,
          include: { name: true, icons: true, images: true, description: true, links: true, attributes: true, category: true, collection: { baseUri: true, icons: true } } }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  // API fallback for popup
  const [popupApiImg, setPopupApiImg] = useState<string | null>(null);
  const [popupApiScheme, setPopupApiScheme] = useState<string | null>(null);
  const [popupApiLoading, setPopupApiLoading] = useState(false);
  const popupAssetKey = `${selectedAsset?.type}:${selectedAsset?.address}:${selectedAsset?.formattedTokenId || ''}`;
  const popupPrevKey = useRef('');
  useEffect(() => {
    if (popupPrevKey.current !== popupAssetKey) {
      popupPrevKey.current = popupAssetKey;
      setPopupApiImg(null);
      setPopupApiScheme(null);
      setPopupApiLoading(false);
    }
  }, [popupAssetKey]);

  useEffect(() => {
    if (popupPrevKey.current !== popupAssetKey) return;
    if (!selectedAsset) return;
    if (popupNftLoading) return;

    // Check if we already have image from useNft or indexer
    if ((popupNftData as any)?.images) {
      const imgs = flattenImages( (popupNftData as any));
      for (const u of imgs) { if (isUsableIpfs(u)) return; }
    }
    if ((popupNftData as any)?.icons?.[0]?.url) return;
    if ((popupNftData as any)?.collection?.icons?.[0]?.url) return;

    const da = selectedOwnedData?.digitalAsset as any;
    if (da?.icons?.[0]?.url || da?.images?.[0]?.url) return;
    const nftIdx = (selectedOwnedData as any)?.nft;
    if (nftIdx?.icons?.[0]?.url || nftIdx?.images?.[0]?.url) return;

    const addr = (popupNftData as any)?.address || selectedOwnedData?.digitalAssetAddress || '';
    if (!addr) return;

    let cancelled = false;
    setPopupApiLoading(true);

    // For NFT popup: resolve image via API as fallback
    const doFetch = async () => {
      if (isNftPopup && selectedAsset?.formattedTokenId) {
        const hex = toTokenIdHex(selectedAsset.formattedTokenId);
        const url = await fetchTokenImage(addr, hex);
        if (!cancelled && url) { setPopupApiImg(url); setPopupApiScheme('api.Token'); setPopupApiLoading(false); return; }
      }
      // Try asset-level
      const url = await fetchAssetImage(addr);
      if (!cancelled && url) { setPopupApiImg(url); setPopupApiScheme('api.Asset'); }
      if (!cancelled) setPopupApiLoading(false);
    };
    // For token popup
    if (!isNftPopup) {
      fetchAssetImage(addr).then(url => {
        if (!cancelled && url) { setPopupApiImg(url); setPopupApiScheme('api.Asset'); }
        if (!cancelled) setPopupApiLoading(false);
      });
      return () => { cancelled = true; };
    }
    doFetch();
    return () => { cancelled = true; };
  }, [selectedAsset, popupNftData, popupNftLoading, selectedOwnedData, isNftPopup]);

  // Resolve final popup image
  const popupImage = useMemo((): { url: string | null; scheme: string } => {
    if (popupNftLoading || popupApiLoading) return { url: null, scheme: 'loading' };

    // useNft
    if (isNftPopup &&  (popupNftData as any)) {
      const imgs = flattenImages(popupNftData as any);
      for (const u of imgs) { if (isUsableIpfs(u)) return { url: toGatewayUrl(u)!, scheme: 'useNft.images' }; }
      if ((popupNftData as any)?.icons?.[0]?.url) return { url: toGatewayUrl((popupNftData as any).icons[0].url)!, scheme: 'useNft.icons' };
      if ((popupNftData as any)?.collection?.icons?.[0]?.url) return { url: toGatewayUrl((popupNftData as any).collection.icons[0].url)!, scheme: 'useNft.collection.icons' };
    }

    // Indexer
    const da = selectedOwnedData?.digitalAsset as any;
    const nftIdx = (selectedOwnedData as any)?.nft;
    if (nftIdx?.icons?.[0]?.url) return { url: toGatewayUrl(nftIdx.icons[0].url)!, scheme: 'indexer.nft.icons' };
    if (nftIdx?.images?.[0]?.url) return { url: toGatewayUrl(nftIdx.images[0].url)!, scheme: 'indexer.nft.images' };
    if (da?.icons?.[0]?.url) return { url: toGatewayUrl(da.icons[0].url)!, scheme: 'indexer.da.icons' };
    if (da?.images?.[0]?.url) return { url: toGatewayUrl(da.images[0].url)!, scheme: 'indexer.da.images' };
    if ((da as any)?.url?.startsWith('ipfs://')) return { url: toGatewayUrl((da as any).url)!, scheme: 'indexer.da.url' };

    // API fallback
    if (popupApiImg) return { url: popupApiImg, scheme: popupApiScheme || 'api' };

    return { url: null, scheme: 'none' };
  }, [isNftPopup, popupNftData, popupNftLoading, popupApiLoading, popupApiImg, popupApiScheme, selectedOwnedData]);

  // Debug
  const popupDebug = useMemo(() => {
    const p: string[] = [];
    p.push(`[${isNftPopup ? 'NFT' : 'TOKEN'}] scheme: ${popupImage.scheme}`);
    if (isNftPopup) {
      const img1 = (popupNftData as any)?.images?.[0];
      p.push(`useNft.img: ${Array.isArray(img1) ? img1[0]?.url : img1?.url || '(empty)'}`);
      p.push(`useNft.icon: ${(popupNftData as any)?.icons?.[0]?.url || '(empty)'}`);
      p.push(`useNft.coll.icon: ${(popupNftData as any)?.collection?.icons?.[0]?.url || '(empty)'}`);
    }
    const da = selectedOwnedData?.digitalAsset as any;
    const nftIdx = (selectedOwnedData as any)?.nft;
    p.push(`idx.nft.icon: ${nftIdx?.icons?.[0]?.url || '(empty)'}`);
    p.push(`idx.nft.img: ${nftIdx?.images?.[0]?.url || '(empty)'}`);
    p.push(`idx.da.icon: ${da?.icons?.[0]?.url || '(empty)'}`);
    p.push(`idx.da.img: ${da?.images?.[0]?.url || '(empty)'}`);
    p.push(`api: ${popupApiLoading ? '...' : (popupApiImg || 'no hit')} [${popupApiScheme || '-'}]`);
    p.push(`final: ${popupImage.url || '(null)'}`);
    return p.join('\n');
  }, [isNftPopup, popupImage, popupNftData, selectedOwnedData, popupApiLoading, popupApiImg, popupApiScheme]);

  const popupDa = selectedOwnedData?.digitalAsset;
  const popupDisplayName = isNftPopup
    ? ((popupNftData as any)?.name || (selectedOwnedData as any)?.nft?.name || popupDa?.name || 'Unknown')
    : (popupDa?.name || 'Unknown');
  const popupDisplaySymbol = isNftPopup
    ? `#${(popupNftData as any)?.formattedTokenId || (selectedOwnedData as any)?.nft?.formattedTokenId || selectedAsset?.formattedTokenId || '?'}`
    : (popupDa?.symbol || '');
  const popupDesc = isNftPopup
    ? ((popupNftData as any)?.description || (selectedOwnedData as any)?.nft?.description || popupDa?.description)
    : popupDa?.description;
  const popupLinks = !isNftPopup ? popupDa?.links : ((popupNftData as any)?.links || (selectedOwnedData as any)?.nft?.links);
  const popupAttrs = !isNftPopup ? popupDa?.attributes : ((popupNftData as any)?.attributes || (selectedOwnedData as any)?.nft?.attributes);

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
        // ─── Popup ────────────────────────────────────────
        <div style={styles.overlay} onClick={() => setSelectedAsset(null)}>
          <div style={styles.popup} onClick={(e) => e.stopPropagation()}>
            <button style={styles.closeButton} onClick={() => setSelectedAsset(null)}>×</button>
            <div style={debugStyles.container}>
              <details style={debugStyles.details}>
                <summary style={debugStyles.summary}>🔍 Debug: Image Resolution</summary>
                <div style={debugStyles.content}>{popupDebug}</div>
              </details>
            </div>
            <div style={styles.popupImageWrapper}>
              {(popupNftLoading || popupApiLoading) ? (
                <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>⏳ Loading...</span>
              ) : popupImage.url ? (
                <img src={popupImage.url} alt="" style={styles.popupImage} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              ) : (
                <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>🖼️</span>
              )}
            </div>
            <div style={styles.popupHeader}>
              <h3 style={styles.popupName}>{popupDisplayName}</h3>
              <span style={styles.popupSymbol}>{popupDisplaySymbol}</span>
            </div>
            {popupDesc && <p style={styles.popupDescription}>{popupDesc}</p>}
            {!isNftPopup && (
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
  content: { padding: '6px 8px', background: '#fef2f2', whiteSpace: 'pre-wrap', lineHeight: '1.4', color: '#e74c3c', fontFamily: 'monospace' },
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
