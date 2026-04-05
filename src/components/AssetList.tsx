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

const getIconUrl = (item: any): string | undefined => {
  if (item.nft?.icons?.[0]?.url) return toGatewayUrl(item.nft.icons[0].url);
  if (item.nft?.images?.[0]?.url) return toGatewayUrl(item.nft.images[0].url);
  if (item.digitalAsset?.icons?.[0]?.url) return toGatewayUrl(item.digitalAsset.icons[0].url);
  if (item.digitalAsset?.images?.[0]?.url) return toGatewayUrl(item.digitalAsset.images[0].url);
  const daUrl = item.digitalAsset?.url;
  if (daUrl && daUrl.startsWith('ipfs://')) return toGatewayUrl(daUrl);
  return undefined;
};

const getNftImageUrls = (nft: any): string[] => {
  if (!nft?.images) return [];
  const images = Array.isArray(nft.images[0]) ? nft.images.flat() : nft.images;
  return images.map((img: any) => img.url).filter(Boolean);
};

const formatBalance = (balance: bigint | null, decimals: number | null | undefined): string => {
  if (!balance) return '0';
  const dec = decimals || 18;
  const divisor = BigInt(10 ** dec);
  const whole = Number(balance / divisor);
  const frac = Number(balance % divisor) / Number(divisor);
  return (whole + frac).toString();
};

const formatTokenAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  if (num >= 1) return num.toFixed(2);
  return num.toFixed(6);
};

const shortenId = (id: string, maxLen = 16): string => {
  if (!id || id.length <= maxLen) return id;
  const half = Math.floor((maxLen - 2) / 2);
  return `${id.slice(0, half + 2)}...${id.slice(-half)}`;
};

const INDEXER_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── image resolution ──────────────────────────────────────

function resolveNftImageFromUseNft(nftData: any): string | null {
  if (nftData?.images) {
    const urls = getNftImageUrls(nftData);
    for (const u of urls) {
      const cid = u.replace('ipfs://', '');
      if (cid.startsWith('baf') && !cid.includes('.')) continue;
      return toGatewayUrl(u) ?? null;
    }
  }
  if (nftData?.collection?.baseUri) {
    const baseUri = nftData.collection.baseUri as string;
    if (baseUri.includes('{id}')) {
      const tokenId = nftData.formattedTokenId || nftData.tokenId;
      if (tokenId) return toGatewayUrl(baseUri.replace('{id}', tokenId)) ?? null;
    }
  }
  return null;
}

function resolveNftImageFullFallback(nftData: any, ownedData?: any, digitalAsset?: any, digitalAssetImages?: { url: string }[] | null): string | null {
  if (nftData?.collection?.icons?.[0]?.url) return toGatewayUrl(nftData.collection.icons[0].url) ?? null;
  const daImgRaw = digitalAssetImages as any;
  if (daImgRaw?.[0]?.[0]?.url) return toGatewayUrl(daImgRaw[0][0].url) ?? null;
  if (ownedData?.nft?.icons?.[0]?.url) return toGatewayUrl(ownedData.nft.icons[0].url) ?? null;
  if (ownedData?.digitalAsset?.icons?.[0]?.url) return toGatewayUrl(ownedData.digitalAsset.icons[0].url) ?? null;
  if (digitalAsset?.icons?.[0]?.url) return toGatewayUrl(digitalAsset.icons[0].url) ?? null;
  return null;
}

async function fetchTokenTableImage(nftData: any): Promise<string | null> {
  const address = nftData?.address;
  const tokenIdHex = nftData?.tokenId?.startsWith('0x')
    ? nftData.tokenId
    : nftData?.formattedTokenId
      ? '0x' + BigInt(nftData.formattedTokenId).toString(16).padStart(64, '0')
      : null;
  if (!address || !tokenIdHex) return null;
  const fullId = `${address.toLowerCase()}-${tokenIdHex}`;
  const query = `{Token(where:{id:{_eq:"${fullId}"}},limit:1){images{url}icons{url}}}`;
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const json = await res.json();
  const tokens = json.data?.Token || [];
  if (tokens.length > 0 && tokens[0].images?.[0]?.url) return toGatewayUrl(tokens[0].images[0].url) ?? null;
  if (tokens.length > 0 && tokens[0].icons?.[0]?.url) return toGatewayUrl(tokens[0].icons[0].url) ?? null;
  return null;
}

async function fetchAssetTableImage(daAddress: string): Promise<string | null> {
  if (!daAddress) return null;
  const query = `{Asset(where:{id:{_eq:"${daAddress.toLowerCase()}"}},limit:1){icons{url}images{url}url}}`;
  const res = await fetch(INDEXER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  const json = await res.json();
  const assets = json.data?.Asset || [];
  if (assets.length > 0 && assets[0].icons?.[0]?.url) return toGatewayUrl(assets[0].icons[0].url) ?? null;
  if (assets.length > 0 && assets[0].images?.[0]?.url) return toGatewayUrl(assets[0].images[0].url) ?? null;
  if (assets.length > 0 && assets[0].url) return toGatewayUrl(assets[0].url) ?? null;
  return null;
}

// ─── tree item types ───────────────────────────────────────

interface NftListItem {
  isCollection: false;
  id: string; name: string; symbol: string;
  tokenId: string; rawTokenId: string; contractAddress: string;
  iconUrl?: string; amount?: string;
}

interface NftCollectionItem {
  isCollection: true;
  id: string; name: string; symbol: string; iconUrl?: string;
  count: number; items: NftListItem[];
}

type NftRenderItem = NftCollectionItem | NftListItem;

// ─── component ──────────────────────────────────────────────

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
  const [lazyIcons, setLazyIcons] = useState<Map<string, string>>(new Map());

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

  const hasNftParams = selectedAsset?.type === 'nft' && selectedAsset.address && selectedAsset.formattedTokenId;
  const { nft: useNftResult, isLoading: useNftLoading } = useNft(
    hasNftParams ? {
      address: selectedAsset!.address.toLowerCase(),
      formattedTokenId: selectedAsset!.formattedTokenId!,
      include: { name: true, icons: true, images: true, description: true, links: true, attributes: true, category: true, collection: { baseUri: true, icons: true } },
    } : ({ address: '', formattedTokenId: '' } as any)
  );

  const handleSelectAsset = useCallback((type: 'token' | 'nft', addr: string, formattedTokenId?: string, e?: React.MouseEvent) => {
    if (e) { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPopupPosition({ top: r.top + window.scrollY, right: window.innerWidth - r.right + window.scrollX }); }
    setSelectedAsset({ type, address: addr, formattedTokenId });
  }, []);

  const handleClosePopup = useCallback(() => { setSelectedAsset(null); }, []);

  const toggleCollection = useCallback((addr: string) => {
    setExpandedCollections(prev => { const next = new Set(prev); const key = addr.toLowerCase(); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClosePopup(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [handleClosePopup]);

  // ─── Token items ─────────────────────────────────────────

  const tokenItems = useMemo(() => {
    const lyxItem = { id: 'lyx', name: 'LYX', symbol: 'LYX', amount: lyxBalance || '0', type: 'LYX' as const, iconUrl: undefined as string | undefined, contractAddress: '' };
    const items = (ownedAssets || [])
      .filter(item => item.digitalAsset?.tokenType === 'TOKEN')
      .filter(item => !searchQuery || item.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase()))
      .map(item => ({ id: item.digitalAssetAddress, name: item.digitalAsset?.name || 'Unknown', symbol: item.digitalAsset?.symbol || '???', amount: formatBalance(item.balance, item.digitalAsset?.decimals), contractAddress: item.digitalAssetAddress, type: 'LSP7' as const, iconUrl: getIconUrl(item) }));
    return [lyxItem, ...[...items].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))];
  }, [lyxBalance, ownedAssets, searchQuery]);

  // ─── NFT tree items ──────────────────────────────────────

  const nftTree = useMemo((): NftRenderItem[] => {
    const addrMap = new Map<string, NftListItem[]>();
    for (const item of (ownedTokens || [])) {
      const addr = item.digitalAssetAddress?.toLowerCase() || '';
      const nftItem: NftListItem = {
        isCollection: false, id: item.digitalAssetAddress + '-' + item.tokenId,
        name: item.nft?.name || item.digitalAsset?.name || 'Unknown', symbol: item.digitalAsset?.symbol || '???',
        tokenId: item.nft?.formattedTokenId || item.tokenId, rawTokenId: item.tokenId,
        contractAddress: item.digitalAssetAddress, iconUrl: getIconUrl(item),
      };
      if (!addrMap.has(addr)) addrMap.set(addr, []);
      addrMap.get(addr)!.push(nftItem);
    }

    const result: NftRenderItem[] = [];
    for (const [addr, items] of addrMap) {
      const filtered = !searchQuery ? items : items.filter(i =>
        i.name.toLowerCase().includes(searchQuery.toLowerCase()) || i.tokenId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        i.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || i.contractAddress.toLowerCase().includes(searchQuery.toLowerCase()));
      if (filtered.length === 0) continue;

      const first = filtered[0];
      const collEntry = (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === addr && (a.digitalAsset?.tokenType === 'NFT' || a.digitalAsset?.tokenType === 'COLLECTION'));
      const collName = collEntry?.digitalAsset?.name || first.name.replace(/ #\d+$/, '') || first.name;
      const collIcon = collEntry ? getIconUrl(collEntry) : first.iconUrl;

      if (filtered.length === 1) result.push(filtered[0]);
      else result.push({ isCollection: true, id: addr, name: collName, symbol: collEntry?.digitalAsset?.symbol || first.symbol, iconUrl: collIcon, count: filtered.length, items: filtered });
    }

    // LSP7-like NFTs (no tokenId)
    const seenAddrs = new Set(addrMap.keys());
    for (const asset of (ownedAssets || [])) {
      const type = asset.digitalAsset?.tokenType;
      const addr = asset.digitalAssetAddress?.toLowerCase();
      if (addr && seenAddrs.has(addr)) continue;
      if (type !== 'NFT' && type !== 'COLLECTION') continue;
      const matchesSearch = !searchQuery || asset.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || asset.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase());
      if (!matchesSearch) continue;

      const balStr = asset.balance != null ? String(asset.balance) : '';
      result.push({ isCollection: false, id: asset.digitalAssetAddress, name: asset.digitalAsset?.name || 'Unknown', symbol: asset.digitalAsset?.symbol || '???', tokenId: '', rawTokenId: '', contractAddress: asset.digitalAssetAddress, iconUrl: getIconUrl(asset), amount: balStr });
    }

    return result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [ownedTokens, ownedAssets, searchQuery]);

  // ─── Lazy icon loading ──────────────────────────────────
  // For each LSP8-like token, fetch the individual token image from Token table.
  // Cache key = item.id (which is unique: either {addr}-{tokenId} or just {addr}).
  const lazyIconCache = useRef<Set<string>>(new Set());

  const fetchIcon = useCallback(async (key: string, address: string, tokenId?: string) => {
    if (lazyIconCache.current.has(key)) return;
    lazyIconCache.current.add(key);
    let url: string | null = null;
    if (tokenId) {
      const hexId = tokenId.startsWith('0x') ? tokenId : '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
      url = await fetchTokenTableImage({ address, tokenId: hexId });
    } else {
      url = await fetchAssetTableImage(address);
    }
    console.log(`[lazyIcon] key=${key} url=${url || 'null'}`);
    if (url) setLazyIcons(prev => { const n = new Map(prev); n.set(key, url); return n; });
  }, [lazyIcons]);

  useEffect(() => {
    const tasks: { key: string; address: string; tokenId?: string }[] = [];
    for (const item of nftTree) {
      if (item.isCollection) {
        // Always fetch individual LSP8 token images (even if they have collection icon from lsp-indexer)
        for (const child of item.items) {
          if (child.tokenId) {
            tasks.push({ key: child.id.toLowerCase(), address: child.contractAddress.toLowerCase(), tokenId: child.tokenId });
          }
        }
      } else if (item.tokenId) {
        // Single LSP8 — always fetch
        tasks.push({ key: item.id.toLowerCase(), address: item.contractAddress.toLowerCase(), tokenId: item.tokenId });
      } else if (!item.iconUrl) {
        // LSP7-like — only fetch if lsp-indexer has no icon
        tasks.push({ key: item.id.toLowerCase(), address: item.contractAddress.toLowerCase(), tokenId: undefined });
      }
    }
    const filtered = tasks.filter(t => !lazyIcons.has(t.key) && !lazyIconCache.current.has(t.key));
    const CONCURRENCY = 5;
    const chunks = Array.from({ length: Math.min(CONCURRENCY, filtered.length) }, (_, i) => filtered.filter((_, j) => j % CONCURRENCY === i));
    for (const chunk of chunks) Promise.all(chunk.map(t => fetchIcon(t.key, t.address, t.tokenId)));
  }, [nftTree, lazyIcons, fetchIcon]);

  // ─── render ──────────────────────────────────────────────

  const showPlaceholder = !targetAddress;

  const renderTokenList = (items: typeof tokenItems, _listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={_listRef}>
      {items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => (
        <div key={item.id} style={styles.item}
          onClick={(e) => { handleSelectAsset('token' as const, item.contractAddress, undefined, e); }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
          <div style={styles.itemIcon}>{item.iconUrl ? <img src={item.iconUrl as string} alt="" style={styles.itemIconImg} /> : <span>{item.type === 'LYX' ? '💎' : '🪙'}</span>}</div>
          <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.symbol}</span></div>
          <div style={styles.itemAmount}>{item.type === 'LYX' ? `${parseFloat(item.amount || '0').toFixed(4)} LYX` : `${formatTokenAmount(item.amount || '0')} ${item.symbol}`}</div>
          <span style={styles.expandIcon}>›</span>
        </div>
      ))}
    </div>
  );

  const renderNftTree = (tree: NftRenderItem[], _listRef: React.RefObject<HTMLDivElement | null>) => {
    if (tree.length === 0) return <p style={styles.empty}>No NFTs found</p>;
    const collIconMap = new Map<string, string>();
    for (const item of tree) {
      if (item.isCollection && item.iconUrl) collIconMap.set(item.id.toLowerCase(), item.iconUrl);
    }
    const resolveIcon = (addr: string, tokenId: string | undefined, fallback?: string) => {
      const key = tokenId ? `${addr.toLowerCase()}-${tokenId}` : addr.toLowerCase();
      const cached = lazyIcons.get(key.toLowerCase());
      if (cached) return cached;
      // Fallback: collection icon > passed fallback
      const addrOnly = addr.toLowerCase();
      return collIconMap.get(addrOnly) || fallback;
    };

    return (
      <div style={styles.list} ref={_listRef}>
        {tree.map((item) => {
          if (item.isCollection) {
            const isExpanded = expandedCollections.has(item.id.toLowerCase());
            const icon = resolveIcon(item.id, undefined, item.iconUrl);
            return (
              <div key={item.id}>
                <div style={{ ...styles.item, fontWeight: 600 }} onClick={() => toggleCollection(item.id)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                  <div style={styles.itemIcon}>{resolveIcon(item.id, undefined, item.iconUrl) ? <img src={resolveIcon(item.id, undefined, item.iconUrl)!} alt="" style={styles.itemIconImg} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} /> : <span>📂</span>}</div>
                  <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.count} NFTs</span></div>
                  <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                </div>
                {isExpanded && (
                  <div style={{ paddingLeft: '8px' }}>
                    {item.items.map(nftItem => {
                      const nftIcon = resolveIcon(nftItem.contractAddress, nftItem.tokenId, nftItem.iconUrl);
                      return (
                        <div key={nftItem.id} style={{ ...styles.item, marginLeft: '12px' }}
                          onClick={(e) => handleSelectAsset('nft', nftItem.contractAddress, nftItem.tokenId, e)}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
                          <div style={styles.itemIcon}>{nftIcon ? <img src={nftIcon} alt="" style={styles.itemIconImg} /> : <span>🖼️</span>}</div>
                          <div style={styles.itemInfo}><span style={styles.itemName}>{nftItem.name}</span><span style={styles.itemSymbol}>{nftItem.tokenId ? `#${shortenId(nftItem.tokenId, 16)}` : `${nftItem.symbol}${nftItem.amount ? ` (${nftItem.amount})` : ''}`}</span></div>
                          <span style={styles.expandIcon}>›</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          }
          const sIcon = resolveIcon(item.contractAddress, item.tokenId, item.iconUrl);
          return (
            <div key={item.id} style={styles.item}
              onClick={(e) => handleSelectAsset('nft', item.contractAddress, item.tokenId, e)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
              <div style={styles.itemIcon}>{sIcon ? <img src={sIcon} alt="" style={styles.itemIconImg} /> : <span>🖼️</span>}</div>
              <div style={styles.itemInfo}><span style={styles.itemName}>{item.name}</span><span style={styles.itemSymbol}>{item.tokenId ? `#${shortenId(item.tokenId, 16)}` : `${item.symbol}${item.amount ? ` (${item.amount})` : ''}`}</span></div>
              <span style={styles.expandIcon}>›</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>💎 Assets</h3>
      {showPlaceholder && <p style={styles.empty}>🔌</p>}
      {targetAddress && (
        <div style={{ animation: 'contentReveal 0.25s ease' }}>
          <div style={styles.tabs}>
            <button style={{ ...styles.tab, ...(activeTab === 'tokens' ? styles.tabActive : {}) }} onClick={() => setActiveTab('tokens')}>🪙 <span style={styles.tabCount}>{tokenItems.length}</span> Tokens</button>
            <button style={{ ...styles.tab, ...(activeTab === 'nfts' ? styles.tabActive : {}) }} onClick={() => setActiveTab('nfts')}>🖼️ <span style={styles.tabCount}>{nftTree.reduce((s, i) => i.isCollection ? s + i.count : s + 1, 0)}</span> NFTs</button>
          </div>
          <input type="text" placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'} value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} style={styles.searchInput} />
          <div style={{ position: 'relative' }}>
            <div style={{ display: activeTab === 'tokens' ? 'block' : 'none' }}>{renderTokenList(tokenItems, tokenListRef)}</div>
            <div style={{ display: activeTab === 'nfts' ? 'block' : 'none' }}>{renderNftTree(nftTree, nftListRef)}</div>
          </div>
        </div>
      )}
      {selectedAsset && selectedOwnedData && (
        <AssetDetailPopup
          ownedData={selectedOwnedData as any} type={selectedAsset.type}
          onClose={handleClosePopup} position={popupPosition}
          useNftResult={useNftResult as any} useNftLoading={useNftLoading}
          digitalAssetImages={(selectedOwnedData as any).digitalAsset?.images}
        />
      )}
    </div>
  );
}

// ========================
// Asset Detail Popup Component
// ========================

interface AssetOwnedDataShape {
  digitalAssetAddress?: string | null; tokenId?: string | null;
  digitalAsset?: { name?: string | null; symbol?: string | null; tokenType?: string | null; decimals?: number | null; description?: string | null; totalSupply?: string | null; holderCount?: number | null; icons?: { url: string }[] | null; images?: { url: string; name?: string }[] | null; links?: { name?: string; url: string }[] | null; attributes?: { key: string; value: string; type?: string }[] | null; } | null;
  nft?: { name?: string | null; description?: string | null; formattedTokenId?: string | null; icons?: { url: string }[] | null; images?: { url: string; name?: string }[] | null; links?: { name?: string; url: string }[] | null; attributes?: { key: string; value: string; type?: string }[] | null; } | null;
  balance?: bigint | null;
}

interface AssetDetailPopupProps {
  ownedData: AssetOwnedDataShape; type: 'token' | 'nft'; onClose: () => void; position: { top: number; right: number };
  useNftResult?: any; useNftLoading?: boolean; digitalAssetImages?: { url: string }[] | null;
}

function AssetDetailPopup({ ownedData, type, onClose, position, useNftResult, useNftLoading, digitalAssetImages }: AssetDetailPopupProps) {
  const digitalAsset = ownedData.digitalAsset;
  const ownedNft = ownedData.nft;
  const isToken = type === 'token';

  const [tokenImgUrl, setTokenImgUrl] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);

  useEffect(() => {
    if (!isToken) {
      if (!useNftResult?.address && ownedData.digitalAssetAddress) {
        if (digitalAsset?.images?.[0]?.url || digitalAsset?.icons?.[0]?.url) return;
        let cancelled = false; setLoadingToken(true);
        fetchAssetTableImage(ownedData.digitalAssetAddress).then(url => { if (!cancelled && url) setTokenImgUrl(url); }).finally(() => { if (!cancelled) setLoadingToken(false); });
        return () => { cancelled = true; };
      }
      if (!useNftResult?.address) return;
      if (resolveNftImageFromUseNft(useNftResult)) return;
      let cancelled = false; setLoadingToken(true);
      fetchTokenTableImage(useNftResult).then(url => { if (!cancelled && url) setTokenImgUrl(url); }).finally(() => { if (!cancelled) setLoadingToken(false); });
      return () => { cancelled = true; };
    } else {
      if (!ownedData.digitalAssetAddress) return;
      if (digitalAsset?.images?.[0]?.url || digitalAsset?.icons?.[0]?.url) return;
      let cancelled = false; setLoadingToken(true);
      fetchAssetTableImage(ownedData.digitalAssetAddress).then(url => { if (!cancelled && url) setTokenImgUrl(url); }).finally(() => { if (!cancelled) setLoadingToken(false); });
      return () => { cancelled = true; };
    }
  }, [isToken, useNftResult, ownedData, digitalAsset, digitalAssetImages]);

  const mainImageUrl = useMemo(() => {
    if (useNftLoading || loadingToken) return null;
    if (!isToken) {
      const sync = resolveNftImageFromUseNft(useNftResult);
      if (sync) return sync;
      if (tokenImgUrl) return tokenImgUrl;
      if (loadingToken) return null;
      return resolveNftImageFullFallback(useNftResult, ownedData, digitalAsset, digitalAssetImages);
    }
    if (digitalAsset?.icons?.[0]?.url) return toGatewayUrl(digitalAsset.icons[0].url);
    if (digitalAsset?.images?.[0]?.url) return toGatewayUrl(digitalAsset.images[0].url);
    if (tokenImgUrl) return tokenImgUrl;
    return null;
  }, [digitalAsset, ownedNft, useNftResult, isToken, ownedData, useNftLoading, digitalAssetImages, tokenImgUrl, loadingToken]);

  const debugInfo = useMemo(() => {
    if (!isToken) {
      const img1 = useNftResult?.images?.[0];
      const img1url = Array.isArray(img1) ? img1[0]?.url : img1?.url;
      const nftImg1 = ownedData?.nft?.images?.[0]?.url;
      const daImgRaw = digitalAssetImages as any;
      const daImg0 = daImgRaw?.[0]?.[0]?.url;
      return [
        `useNft.nft.images:                      ${img1url || '(empty)'}`,
        `useInfiniteOwnedTokens.nft.images:       ${nftImg1 || '(empty)'}`,
        `useNft.collection.baseUri:              ${useNftResult?.collection?.baseUri || '(empty)'}`,
        `useInfiniteOwnedTokens.digitalAsset.images: ${daImg0 || '(empty)'}`,
        `TokenTable.query:                       ${loadingToken ? '...' : (tokenImgUrl || 'no hit')}`,
        `mainImageUrl:                           ${mainImageUrl || '(null)'}`,
      ].join('\n');
    }
    return [
      `useInfiniteOwnedAssets.digitalAsset.images: ${digitalAsset?.images?.[0]?.url || '(empty)'}`,
      `useInfiniteOwnedAssets.digitalAsset.icons:  ${digitalAsset?.icons?.[0]?.url || '(empty)'}`,
      `AssetTable.query:                          ${loadingToken ? '...' : (tokenImgUrl || 'no hit')}`,
      `mainImageUrl:                              ${mainImageUrl || '(null)'}`,
    ].join('\n');
  }, [isToken, useNftResult, ownedData, digitalAssetImages, mainImageUrl, loadingToken, tokenImgUrl, digitalAsset]);

  const links = isToken ? digitalAsset?.links : (useNftResult?.links || ownedNft?.links);
  const attributes = isToken ? digitalAsset?.attributes : (useNftResult?.attributes || ownedNft?.attributes);
  const contractAddress = ownedData.digitalAssetAddress;
  const displayName = !isToken ? (useNftResult?.name || ownedNft?.name || digitalAsset?.name || 'Unknown') : (digitalAsset?.name || 'Unknown');
  const displaySymbol = !isToken ? `#${useNftResult?.formattedTokenId || ownedNft?.formattedTokenId || ownedData.tokenId || '?'}` : (digitalAsset?.symbol || '');
  const displayDescription = !isToken ? (useNftResult?.description || ownedNft?.description) : digitalAsset?.description;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.popup} onClick={(e) => e.stopPropagation()}>
        <button style={styles.closeButton} onClick={onClose}>×</button>
        {debugInfo && (
          <div style={{ fontSize: '0.58rem', color: '#e74c3c', marginBottom: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.35', padding: '6px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fecaca' }}>{debugInfo}</div>
        )}
        <div style={styles.popupImageWrapper}>
          {mainImageUrl ? <img src={mainImageUrl} alt="" style={styles.popupImage} /> : <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>🖼️</span>}
        </div>
        <div style={styles.popupHeader}>
          <h3 style={styles.popupName}>{displayName}</h3>
          <span style={styles.popupSymbol}>{displaySymbol}</span>
        </div>
        {displayDescription && <p style={styles.popupDescription}>{displayDescription}</p>}
        {isToken && (
          <div style={styles.detailGrid}>
            <div><span style={styles.detailLabel}>Supply</span><span style={styles.detailValue}>{formatBigInt(digitalAsset?.totalSupply, digitalAsset?.decimals)}</span></div>
            <div><span style={styles.detailLabel}>Holders</span><span style={styles.detailValue}>{digitalAsset?.holderCount?.toLocaleString() || '-'}</span></div>
            <div><span style={styles.detailLabel}>Your Balance</span><span style={styles.detailValue}>{formatBalance(ownedData.balance ?? null, digitalAsset?.decimals ?? null)}</span></div>
            {digitalAsset?.decimals != null && <div><span style={styles.detailLabel}>Decimals</span><span style={styles.detailValue}>{digitalAsset.decimals}</span></div>}
          </div>
        )}
        {contractAddress && (
          <div><span style={styles.detailLabel}>Contract</span><span style={styles.detailValue}><a href={`https://explorer.execution.mainnet.lukso.network/address/${contractAddress}`} target="_blank" rel="noopener noreferrer" style={styles.link}>{contractAddress}</a></span></div>
        )}
        {links && links.length > 0 && (
          <div style={{ marginTop: '8px' }}><span style={styles.detailLabel}>Links</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>{links.map((l: { name?: string; url: string }, i: number) => <a key={i} href={l.url} target="_blank" rel="noopener noreferrer" style={styles.outboundLink}>{l.name || l.url} ↗</a>)}</div>
          </div>
        )}
        {attributes && attributes.length > 0 && (
          <div style={{ marginTop: '8px' }}><span style={styles.detailLabel}>Attributes</span>
            <div style={styles.attributesGrid}>{attributes.slice(0, 12).map((a: { key: string; value: string; type?: string }, i: number) => <div key={i} style={styles.attributeItem}>{a.key && <span style={styles.attrKey}>{a.key}</span>}<span style={styles.attrValue}>{a.value}</span></div>)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

const formatBigInt = (raw: string | null | undefined, decimals: number | null | undefined): string => {
  if (!raw) return '-';
  try { return ethers.formatUnits(BigInt(raw), decimals || 18); } catch { return raw; }
};

// ========================
// Styles
// ========================

const styles: { [key: string]: React.CSSProperties } = {
  card: { padding: '8px', background: 'rgba(255,255,255,0.95)', borderRadius: '16px', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' },
  title: { margin: '0 0 8px 0', fontSize: '1rem', fontWeight: '700', color: '#1a202c' },
  tabs: { display: 'flex', gap: '8px', marginBottom: '8px' },
  tab: { flex: 1, padding: '10px 12px', border: 'none', borderRadius: '10px', background: '#f7fafc', color: '#718096', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', transition: 'all 0.25s ease', minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' },
  tabActive: { background: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', color: '#fff' },
  tabCount: { fontWeight: '800' },
  searchInput: { width: '100%', padding: '8px 12px', marginBottom: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '16px', outline: 'none', boxSizing: 'border-box' as const },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '450px', overflowY: 'auto', minHeight: '60px' },
  item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: '#f7fafc', borderRadius: '8px', transition: 'background 0.15s ease', position: 'relative' },
  itemIcon: { width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg,#667eea 0%,#764ba2 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', overflow: 'hidden', flexShrink: 0 },
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
  popupImageWrapper: { width: '100%', height: '200px', borderRadius: '12px', overflow: 'hidden', marginBottom: '12px', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f7fafc', flexShrink: 0, position: 'relative' },
  popupImage: { maxWidth: '100%', maxHeight: '200px', objectFit: 'contain' },
  popupHeader: { marginBottom: '8px' },
  popupName: { fontSize: '1.1rem', fontWeight: '700', color: '#1a202c', margin: 0, lineHeight: 1.3 },
  popupSymbol: { fontSize: '0.8rem', color: '#718096', fontWeight: '500' },
  popupDescription: { fontSize: '0.85rem', color: '#4a5568', lineHeight: 1.5, margin: 0, wordWrap: 'break-word' as const, overflowWrap: 'break-word' as const, whiteSpace: 'pre-wrap' as const },
  detailGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' },
  detailLabel: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '600', textTransform: 'uppercase' as const, letterSpacing: '0.025em' },
  detailValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-all' as const },
  link: { color: '#667eea', textDecoration: 'none', wordBreak: 'break-all' as const },
  outboundLink: { fontSize: '0.8rem', padding: '4px 8px', background: '#edf2f7', borderRadius: '6px', color: '#4a5568', textDecoration: 'none', transition: 'background 0.15s', wordBreak: 'break-all' as const, maxWidth: '100%' },
  attributesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' },
  attributeItem: { padding: '6px 8px', background: '#f7fafc', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden', minWidth: 0 },
  attrKey: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '500' },
  attrValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordWrap: 'break-word' as const, overflowWrap: 'break-word' as const, overflow: 'hidden' },
};

if (typeof document !== 'undefined') {
  if (!document.getElementById('popup-keyframes')) {
    const style = document.createElement('style'); style.id = 'popup-keyframes';
    style.textContent = `@keyframes popupIn{from{opacity:0}to{opacity:1}}`;
    document.head.appendChild(style);
  }
}
