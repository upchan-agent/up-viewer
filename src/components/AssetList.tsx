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

// Helper to get first icon URL (from digitalAsset or nft)
const getIconUrl = (item: any): string | undefined => {
  if (item.nft?.images?.[0]?.url) return toGatewayUrl(item.nft.images[0].url);
  if (item.nft?.icons?.[0]?.url) return toGatewayUrl(item.nft.icons[0].url);
  if (item.digitalAsset?.images?.[0]?.url) return toGatewayUrl(item.digitalAsset.images[0].url);
  const icons = item.digitalAsset?.icons;
  if (!icons?.[0]?.url) return undefined;
  return toGatewayUrl(icons[0].url);
};

/** Nft.images は2D配列（ZodArray<ZodArray<{url}>>）→ フラット化する */
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

const INDEXER_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

/** Synchronous resolution — only checks fields with per-token images */
function resolveNftImageOnlyToken(nftDetail: any): string | null {
  if (nftDetail?.images) {
    const urls = getNftImageUrls(nftDetail);
    for (const u of urls) {
      const cid = u.replace('ipfs://', '');
      if (cid.startsWith('baf') && !cid.includes('.')) continue;
      return toGatewayUrl(u) ?? null;
    }
  }
  if (nftDetail?.collection?.baseUri) {
    const baseUri = nftDetail.collection.baseUri as string;
    if (baseUri.includes('{id}')) {
      const tokenId = nftDetail.formattedTokenId || nftDetail.tokenId;
      if (tokenId) return toGatewayUrl(baseUri.replace('{id}', tokenId)) ?? null;
    }
  }
  return null;
}

/** Full resolution with ALL fallbacks — used as last resort */
function resolveNftImageFullFallback(nftDetail: any, data?: any, da?: any, daImages?: { url: string }[] | null): string | null {
  if (nftDetail?.collection?.icons?.[0]?.url) return toGatewayUrl(nftDetail.collection.icons[0].url) ?? null;
  const daImgRaw = daImages as any;
  if (daImgRaw?.[0]?.[0]?.url) return toGatewayUrl(daImgRaw[0][0].url) ?? null;
  if (data?.nft?.icons?.[0]?.url) return toGatewayUrl(data.nft.icons[0].url) ?? null;
  if (data?.digitalAsset?.icons?.[0]?.url) return toGatewayUrl(data.digitalAsset.icons[0].url) ?? null;
  if (da?.icons?.[0]?.url) return toGatewayUrl(da.icons[0].url) ?? null;
  return null;
}

/** Fetch individual NFT image from Token table (fallback when useNft has no images) */
async function fetchTokenImage(nftDetail: any): Promise<string | null> {
  const address = nftDetail?.address;
  const tokenIdHex = nftDetail?.tokenId?.startsWith('0x')
    ? nftDetail.tokenId
    : nftDetail?.formattedTokenId
      ? '0x' + BigInt(nftDetail.formattedTokenId).toString(16).padStart(64, '0')
      : null;
  if (!address || !tokenIdHex) return null;

  const fullId = `${address.toLowerCase()}-${tokenIdHex}`;
  const query = `{Token(where:{id:{_eq:"${fullId}"}},limit:1){images{url}icons{url}}}`;
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const json = await res.json();
  const tokens = json.data?.Token || [];
  if (tokens.length > 0 && tokens[0].images?.[0]?.url) return toGatewayUrl(tokens[0].images[0].url) ?? null;
  if (tokens.length > 0 && tokens[0].icons?.[0]?.url) return toGatewayUrl(tokens[0].icons[0].url) ?? null;
  return null;
}

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

  const {
    ownedAssets,
    hasNextPage: hasMoreAssets,
    fetchNextPage: fetchMoreAssets,
    isFetchingNextPage: loadingMoreAssets,
    isLoading: loadingAssets,
  } = useInfiniteOwnedAssets({
    filter: { holderAddress: targetAddress?.toLowerCase() || '' },
    include: { 
      balance: true,
      digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true }
    },
    pageSize: 500,
  });

  const {
    ownedTokens,
    hasNextPage: hasMoreTokens,
    fetchNextPage: fetchMoreTokens,
    isFetchingNextPage: loadingMoreTokens,
    isLoading: loadingTokens,
  } = useInfiniteOwnedTokens({
    filter: { holderAddress: targetAddress?.toLowerCase() || '' },
    include: { 
      digitalAsset: { name: true, symbol: true, tokenType: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true },
      nft: { formattedTokenId: true, name: true, icons: true, description: true, images: true, links: true, attributes: true },
    },
    pageSize: 500,
  });

  useEffect(() => {
    if (hasMoreAssets && !loadingMoreAssets) fetchMoreAssets();
  }, [hasMoreAssets, loadingMoreAssets, fetchMoreAssets]);

  useEffect(() => {
    if (hasMoreTokens && !loadingMoreTokens) fetchMoreTokens();
  }, [hasMoreTokens, loadingMoreTokens, fetchMoreTokens]);

  useEffect(() => {
    if (!targetAddress) return;
    const provider = new ethers.JsonRpcProvider(LUKSO_RPC_URL);
    provider.getBalance(targetAddress).then(balance => {
      setLyxBalance(ethers.formatEther(balance));
    });
  }, [targetAddress]);

  const selectedAssetData = useMemo(() => {
    if (!selectedAsset) return null;
    if (selectedAsset.type === 'token') {
      return (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase());
    }
    const found = (ownedTokens || []).find(t => {
      const tokenIdMatch = selectedAsset.formattedTokenId && (t.nft?.formattedTokenId === selectedAsset.formattedTokenId);
      return t.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase() && tokenIdMatch;
    });
    console.log('[selectedAssetData] selected:', JSON.stringify({
      addr: selectedAsset.address,
      ftId: selectedAsset.formattedTokenId,
      foundOwner: found?.nft?.formattedTokenId,
      ownedCount: ownedTokens?.length,
    }));
    return found;
  }, [selectedAsset, ownedAssets, ownedTokens]);

  // Fetch individual NFT details using useNft
  const hasNftParams = selectedAsset?.type === 'nft' && selectedAsset.address && selectedAsset.formattedTokenId;
  const { nft: nftDetail, isLoading: nftLoading } = useNft(
    hasNftParams
      ? {
          address: selectedAsset!.address.toLowerCase(),
          formattedTokenId: selectedAsset!.formattedTokenId!,
          include: {
            name: true,
            icons: true,
            images: true,
            description: true,
            links: true,
            attributes: true,
            category: true,
            collection: { baseUri: true, icons: true },
          },
        }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  const handleSelectAsset = useCallback((type: 'token' | 'nft', address: string, formattedTokenId?: string, e?: React.MouseEvent) => {
    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPopupPosition({
        top: rect.top + window.scrollY,
        right: window.innerWidth - rect.right + window.scrollX,
      });
    }
    setSelectedAsset({ type, address, formattedTokenId });
  }, []);

  const handleClosePopup = useCallback(() => { setSelectedAsset(null); }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClosePopup();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClosePopup]);

  // Build items
  const tokenItems = useMemo(() => {
    const lyxItem = { id: 'lyx', name: 'LYX', symbol: 'LYX', amount: lyxBalance || '0', type: 'LYX', iconUrl: undefined };
    const items = (ownedAssets || [])
      .filter(item => item.digitalAsset?.tokenType === 'TOKEN')
      .filter(item => !searchQuery || item.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase()))
      .map(item => ({
        id: item.digitalAssetAddress,
        name: item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        amount: formatBalance(item.balance, item.digitalAsset?.decimals),
        contractAddress: item.digitalAssetAddress,
        type: 'LSP7',
        iconUrl: getIconUrl(item),
      }));
    const sorted = [...items].sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
    return [lyxItem, ...sorted];
  }, [lyxBalance, ownedAssets, searchQuery]);

  const nftItems = useMemo(() => {
    return (ownedTokens || [])
      .filter(item => item.digitalAsset?.tokenType !== 'TOKEN')
      .filter(item => !searchQuery || item.nft?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.digitalAsset?.name?.toLowerCase().includes(searchQuery.toLowerCase()) || item.digitalAsset?.symbol?.toLowerCase().includes(searchQuery.toLowerCase()))
      .map(item => ({
        id: item.digitalAssetAddress + '-' + item.tokenId,
        name: item.nft?.name || item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        amount: '',
        tokenId: item.nft?.formattedTokenId || item.tokenId,
        rawTokenId: item.tokenId,
        contractAddress: item.digitalAssetAddress,
        type: 'LSP8' as const,
        iconUrl: getIconUrl(item),
      })).sort((a, b) => (a.name || '').localeCompare(b.name || '') || (a.tokenId || '').localeCompare(b.tokenId || ''));
  }, [ownedTokens, searchQuery]);

  const showPlaceholder = !targetAddress;

  const renderList = (items: typeof tokenItems, _listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={_listRef}>
      {items.length === 0 ? (
        <p style={styles.empty}>No {activeTab === 'tokens' ? 'assets' : 'NFTs'} found</p>
      ) : (
        items.map((item) => (
          <div 
            key={item.id} 
            style={styles.item}
            onClick={(e) => {
              if (item.type !== 'LYX') {
                handleSelectAsset(item.type === 'LSP7' ? 'token' : 'nft', (item as any).contractAddress, (item as any).tokenId, e);
              }
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = '#edf2f7';
              (e.currentTarget as HTMLElement).style.cursor = item.type !== 'LYX' ? 'pointer' : 'default';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = '#f7fafc';
            }}
          >
            <div style={styles.itemIcon}>
              {item.iconUrl ? <img src={item.iconUrl as string} alt="" style={styles.itemIconImg} /> : <span>{item.type === 'LYX' ? '💎' : item.type === 'LSP7' ? '🪙' : '🖼️'}</span>}
            </div>
            <div style={styles.itemInfo}>
              <span style={styles.itemName}>{item.name}</span>
              <span style={styles.itemSymbol}>{item.symbol}</span>
            </div>
            <div style={styles.itemAmount}>
              {item.type === 'LYX' ? `${parseFloat(item.amount || '0').toFixed(4)} LYX`
                : item.type === 'LSP7' ? `${formatTokenAmount(item.amount || '0')} ${item.symbol}`
                : `#${(item as any).tokenId || '?'}`}
            </div>
            {item.type !== 'LYX' && <span style={styles.expandIcon}>›</span>}
          </div>
        ))
      )}
    </div>
  );

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>💎 Assets</h3>

      {showPlaceholder && <p style={styles.empty}>🔌</p>}

      {targetAddress && (
        <div style={{ animation: 'contentReveal 0.25s ease' }}>
          <div style={styles.tabs}>
            <button style={{ ...styles.tab, ...(activeTab === 'tokens' ? styles.tabActive : {}) }} onClick={() => setActiveTab('tokens')}>
              🪙 <span style={styles.tabCount}>{tokenItems.length}</span> Tokens
            </button>
            <button style={{ ...styles.tab, ...(activeTab === 'nfts' ? styles.tabActive : {}) }} onClick={() => setActiveTab('nfts')}>
              🖼️ <span style={styles.tabCount}>{nftItems.length}</span> NFTs
            </button>
          </div>

          <input
            type="text"
            placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={styles.searchInput}
          />
          
          {/* Separate containers preserve scroll position independently */}
          <div style={{ position: 'relative' }}>
            <div style={{ display: activeTab === 'tokens' ? 'block' : 'none' }}>
              {renderList(tokenItems, tokenListRef)}
            </div>
            <div style={{ display: activeTab === 'nfts' ? 'block' : 'none' }}>
              {renderList(nftItems as any, nftListRef)}
            </div>
          </div>
        </div>
      )}

      {selectedAsset && selectedAssetData && (
        <AssetDetailPopup
          data={selectedAssetData as any}
          type={selectedAsset.type}
          onClose={handleClosePopup}
          position={popupPosition}
          nftDetail={nftDetail as any}
          nftLoading={nftLoading}
        />
      )}
    </div>
  );
}

// ========================
// Asset Detail Popup Component
// ========================

interface AssetDataShape {
  digitalAssetAddress?: string | null;
  tokenId?: string | null;
  digitalAsset?: {
    name?: string | null; symbol?: string | null; tokenType?: string | null;
    decimals?: number | null; description?: string | null; totalSupply?: string | null;
    holderCount?: number | null; icons?: { url: string }[] | null;
    images?: { url: string; name?: string }[] | null;
    links?: { name?: string; url: string }[] | null;
    attributes?: { key: string; value: string; type?: string }[] | null;
  } | null;
  nft?: { name?: string | null; description?: string | null; formattedTokenId?: string | null;
    icons?: { url: string }[] | null; images?: { url: string; name?: string }[] | null;
    links?: { name?: string; url: string }[] | null;
    attributes?: { key: string; value: string; type?: string }[] | null;
  } | null;
  balance?: bigint | null;
}

interface AssetDetailPopupProps {
  data: AssetDataShape;
  type: 'token' | 'nft';
  onClose: () => void;
  position: { top: number; right: number };
  nftDetail?: any;
  nftLoading?: boolean;
  daImages?: { url: string }[] | null;
}

function AssetDetailPopup({ data, type, onClose, position, nftDetail, nftLoading, daImages }: AssetDetailPopupProps) {
  const da = data.digitalAsset;
  const nft = data.nft;
  const isToken = type === 'token';

  const [tokenImgUrl, setTokenImgUrl] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);

  // Async fallback: Token table
  useEffect(() => {
    if (isToken || !nftDetail?.address) return;
    if (resolveNftImageOnlyToken(nftDetail)) return;
    let cancelled = false;
    setLoadingToken(true);
    fetchTokenImage(nftDetail).then(url => { if (!cancelled && url) setTokenImgUrl(url); }).finally(() => { if (!cancelled) setLoadingToken(false); });
    return () => { cancelled = true; };
  }, [isToken, nftDetail, data, da, daImages]);

  const mainImageUrl = useMemo(() => {
    if (nftLoading || loadingToken) return null;
    if (!isToken) {
      const sync = resolveNftImageOnlyToken(nftDetail);
      if (sync) return sync;
      if (tokenImgUrl) return tokenImgUrl;
      return resolveNftImageFullFallback(nftDetail, data, da, daImages);
    }
    if (da?.images?.[0]?.url) return toGatewayUrl(da.images[0].url);
    if (da?.icons?.[0]?.url) return toGatewayUrl(da.icons[0].url);
    return null;
  }, [da, nft, nftDetail, isToken, data, nftLoading, daImages, tokenImgUrl, loadingToken]);

  // Debug info
  const debugInfo = useMemo(() => {
    if (isToken) return null;
    const img1 = nftDetail?.images?.[0];
    const img1url = Array.isArray(img1) ? img1[0]?.url : img1?.url;
    const nftImg1 = data?.nft?.images?.[0]?.url;
    const daImgRaw = daImages as any;
    const daImg0 = daImgRaw?.[0]?.[0]?.url;
    return [
      `useNft: ${img1url || '(empty)'}`,
      `nftImg: ${nftImg1 || '(empty)'}`,
      `baseUri: ${nftDetail?.collection?.baseUri || '(empty)'}`,
      `daImg:  ${daImg0 || '(empty)'}`,
      `tokenApi: ${loadingToken ? '...' : (tokenImgUrl || 'no hit')}`,
      `final:  ${mainImageUrl || '(null)'}`,
    ].join('\n');
  }, [isToken, nftDetail, data, daImages, mainImageUrl, loadingToken, tokenImgUrl]);

  const links = isToken ? da?.links : (nftDetail?.links || nft?.links);
  const attributes = isToken ? da?.attributes : (nftDetail?.attributes || nft?.attributes);
  const contractAddress = data.digitalAssetAddress;
  const displayName = !isToken ? (nftDetail?.name || nft?.name || da?.name || 'Unknown') : (da?.name || 'Unknown');
  const displaySymbol = !isToken ? `#${nftDetail?.formattedTokenId || nft?.formattedTokenId || data.tokenId || '?'}` : (da?.symbol || '');
  const displayDescription = !isToken ? (nftDetail?.description || nft?.description) : da?.description;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.popup} onClick={(e) => e.stopPropagation()}>
        <button style={styles.closeButton} onClick={onClose}>×</button>

        {/* Debug */}
        {debugInfo && (
          <div style={{ fontSize: '0.58rem', color: '#e74c3c', marginBottom: '8px', whiteSpace: 'pre-wrap', lineHeight: '1.35', padding: '6px', background: '#fef2f2', borderRadius: '6px', border: '1px solid #fecaca' }}>
            {debugInfo}
          </div>
        )}

        {/* Image — always render wrapper to prevent layout shift */}
        <div style={styles.popupImageWrapper}>
          {mainImageUrl
            ? <img src={mainImageUrl} alt="" style={styles.popupImage} />
            : <span style={{ color: '#a0aec0', fontSize: '0.85rem' }}>🖼️</span>}
        </div>
        <div style={styles.popupHeader}>
          <h3 style={styles.popupName}>{displayName}</h3>
          <span style={styles.popupSymbol}>{displaySymbol}</span>
        </div>
        {displayDescription && <p style={styles.popupDescription}>{displayDescription}</p>}
        {isToken && (
          <div style={styles.detailGrid}>
            <div><span style={styles.detailLabel}>Supply</span><span style={styles.detailValue}>{formatBigInt(da?.totalSupply, da?.decimals)}</span></div>
            <div><span style={styles.detailLabel}>Holders</span><span style={styles.detailValue}>{da?.holderCount?.toLocaleString() || '-'}</span></div>
            <div><span style={styles.detailLabel}>Your Balance</span><span style={styles.detailValue}>{formatBalance(data.balance ?? null, da?.decimals ?? null)}</span></div>
            {da?.decimals != null && <div><span style={styles.detailLabel}>Decimals</span><span style={styles.detailValue}>{da.decimals}</span></div>}
          </div>
        )}
        {contractAddress && (
          <div><span style={styles.detailLabel}>Contract</span><span style={styles.detailValue}><a href={`https://explorer.execution.mainnet.lukso.network/address/${contractAddress}`} target="_blank" rel="noopener noreferrer" style={styles.link}>{contractAddress.slice(0,6)}...{contractAddress.slice(-4)}</a></span></div>
        )}
        {links && links.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <span style={styles.detailLabel}>Links</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              {links.map((link: { name?: string; url: string }, idx: number) => (<a key={idx} href={link.url} target="_blank" rel="noopener noreferrer" style={styles.outboundLink}>{link.name || link.url} ↗</a>))}
            </div>
          </div>
        )}
        {attributes && attributes.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <span style={styles.detailLabel}>Attributes</span>
            <div style={styles.attributesGrid}>
              {attributes.slice(0, 12).map((attr: { key: string; value: string; type?: string }, idx: number) => (<div key={idx} style={styles.attributeItem}>{attr.key && <span style={styles.attrKey}>{attr.key}</span>}<span style={styles.attrValue}>{attr.value}</span></div>))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ========================
// Utilities
// ========================

const formatBigInt = (raw: string | null | undefined, decimals: number | null | undefined): string => {
  if (!raw) return '-';
  try { return ethers.formatUnits(BigInt(raw), decimals || 18); } catch { return raw; }
};

const formatTokenAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
  if (num >= 1) return num.toFixed(2);
  return num.toFixed(6);
};

// ========================
// Styles
// ========================

const styles: { [key: string]: React.CSSProperties } = {
  card: {
    padding: '8px',
    background: 'rgba(255, 255, 255, 0.95)',
    borderRadius: '16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
  },
  title: {
    margin: '0 0 8px 0',
    fontSize: '1rem',
    fontWeight: '700',
    color: '#1a202c',
  },
  tabs: { display: 'flex', gap: '8px', marginBottom: '8px' },
  tab: {
    flex: 1, padding: '10px 12px', border: 'none', borderRadius: '10px',
    background: '#f7fafc', color: '#718096', fontSize: '0.85rem', fontWeight: '600',
    cursor: 'pointer', transition: 'all 0.25s ease', minHeight: '42px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
  },
  tabActive: { background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white' },
  tabCount: { fontWeight: '800' },
  searchInput: {
    width: '100%', padding: '8px 12px', marginBottom: '8px',
    border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '16px',
    outline: 'none', boxSizing: 'border-box' as const,
  },
  list: {
    display: 'flex', flexDirection: 'column', gap: '4px',
    maxHeight: '450px', overflowY: 'auto', minHeight: '60px',
  },
  item: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px',
    background: '#f7fafc', borderRadius: '8px',
    transition: 'background 0.15s ease, transform 0.1s ease', position: 'relative',
  },
  itemIcon: {
    width: '28px', height: '28px', borderRadius: '50%',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: '1rem', overflow: 'hidden', flexShrink: 0,
  },
  itemIconImg: { width: '100%', height: '100%', objectFit: 'cover' },
  itemInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  itemName: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemSymbol: { fontSize: '0.75rem', color: '#718096' },
  itemAmount: { fontSize: '0.75rem', fontWeight: '600', color: '#718096', textAlign: 'right', flexShrink: 0, maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  expandIcon: { fontSize: '1.2rem', color: '#cbd5e0', flexShrink: 0, marginLeft: '2px' },
  empty: { margin: 0, padding: '16px', textAlign: 'center', color: '#a0aec0', fontSize: '0.85rem' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0, 0, 0, 0.3)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(2px)' },
  popup: { background: '#ffffff', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)', maxWidth: '420px', width: '90%', maxHeight: '70vh', overflowY: 'auto', overflowX: 'hidden', position: 'relative', padding: '16px', animation: 'popupIn 0.2s ease', transformOrigin: 'center' },
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
  outboundLink: { fontSize: '0.8rem', padding: '4px 8px', background: '#edf2f7', borderRadius: '6px', color: '#4a5568', textDecoration: 'none', transition: 'background 0.15s ease', wordBreak: 'break-all' as const, maxWidth: '100%' },
  attributesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' },
  attributeItem: { padding: '6px 8px', background: '#f7fafc', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden', minWidth: 0 },
  attrKey: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '500' },
  attrValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordWrap: 'break-word' as const, overflowWrap: 'break-word' as const, overflow: 'hidden' },
};

if (typeof document !== 'undefined') {
  const styleId = 'popup-keyframes';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `@keyframes popupIn { from { opacity: 0; } to { opacity: 1; } }`;
    document.head.appendChild(style);
  }
}
