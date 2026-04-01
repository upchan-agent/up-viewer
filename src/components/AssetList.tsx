'use client';

import { useUpProvider } from '@/lib/up-provider';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens, useDigitalAsset, useProfile } from '@lsp-indexer/react';
import { toGatewayUrl, shortenAddress } from '@/lib/utils';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { ethers } from 'ethers';

interface AssetListProps {
  address?: `0x${string}`;
}

// Helper to get first icon URL (from digitalAsset or nft)
// Priority: nft.images > nft.icons > digitalAsset.images > digitalAsset.icons
const getIconUrl = (item: any): string | undefined => {
  // 1. Try nft images (larger individual NFT image)
  if (item.nft?.images?.[0]?.url) {
    return toGatewayUrl(item.nft.images[0].url);
  }
  // 2. Try nft icons (individual NFT icon)
  if (item.nft?.icons?.[0]?.url) {
    return toGatewayUrl(item.nft.icons[0].url);
  }
  // 3. Fall back to collection images
  if (item.digitalAsset?.images?.[0]?.url) {
    return toGatewayUrl(item.digitalAsset.images[0].url);
  }
  // 4. Fall back to collection icons
  const icons = item.digitalAsset?.icons;
  if (!icons?.[0]?.url) return undefined;
  return toGatewayUrl(icons[0].url);
};

// Format bigint balance to human-readable
const formatBalance = (balance: bigint | null, decimals: number | null | undefined): string => {
  if (!balance) return '0';
  const dec = decimals || 18;
  const divisor = BigInt(10 ** dec);
  const whole = Number(balance / divisor);
  const frac = Number(balance % divisor) / Number(divisor);
  return (whole + frac).toString();
};

export function AssetList({ address }: AssetListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [lyxBalance, setLyxBalance] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tokens' | 'nfts'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');
  
  // === Detail popup state ===
  const [selectedAsset, setSelectedAsset] = useState<{ type: 'token' | 'nft'; address: string; tokenId?: string } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });

  // Fetch owned assets (LSP7 tokens) with infinite scroll
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

  // Fetch owned tokens (LSP8 NFTs) with infinite scroll
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

  // Auto-fetch all pages
  useEffect(() => {
    if (hasMoreAssets && !loadingMoreAssets) {
      fetchMoreAssets();
    }
  }, [hasMoreAssets, loadingMoreAssets, fetchMoreAssets]);

  useEffect(() => {
    if (hasMoreTokens && !loadingMoreTokens) {
      fetchMoreTokens();
    }
  }, [hasMoreTokens, loadingMoreTokens, fetchMoreTokens]);

  // Fetch LYX balance separately
  useEffect(() => {
    if (!targetAddress) return;
    
    const provider = new ethers.JsonRpcProvider(LUKSO_RPC_URL);
    provider.getBalance(targetAddress).then(balance => {
      setLyxBalance(ethers.formatEther(balance));
    });
  }, [targetAddress]);

  const isLoading = loadingAssets || loadingTokens;

  // Find asset data for the selected item
  const selectedAssetData = useMemo(() => {
    if (!selectedAsset) return null;
    
    if (selectedAsset.type === 'token') {
      return (ownedAssets || []).find(a => a.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase());
    }
    return (ownedTokens || []).find(t => {
      const tokenIdMatch = selectedAsset.tokenId && (t.tokenId === selectedAsset.tokenId || t.nft?.formattedTokenId === selectedAsset.tokenId);
      return t.digitalAssetAddress?.toLowerCase() === selectedAsset.address.toLowerCase() && tokenIdMatch;
    });
  }, [selectedAsset, ownedAssets, ownedTokens]);

  // Close popup handler
  const handleSelectAsset = useCallback((type: 'token' | 'nft', address: string, tokenId?: string, e?: React.MouseEvent) => {
    if (e) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setPopupPosition({
        top: rect.top + window.scrollY,
        right: window.innerWidth - rect.right + window.scrollX,
      });
    }
    setSelectedAsset({ type, address, tokenId });
  }, []);

  const handleClosePopup = useCallback(() => {
    setSelectedAsset(null);
  }, []);

  // Close popup on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClosePopup();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleClosePopup]);

  // Build display items
  const displayItems = useMemo(() => {
    // LYX item
    const lyxItem = {
      id: 'lyx',
      name: 'LYX',
      symbol: 'LYX',
      amount: lyxBalance || '0',
      tokenId: undefined,
      contractAddress: undefined,
      type: 'LYX' as const,
      iconUrl: undefined,
    };

    // LSP7 tokens from ownedAssets
    const tokenItems = (ownedAssets || [])
      .filter(item => item.digitalAsset?.tokenType === 'TOKEN')
      .map(item => ({
        id: item.digitalAssetAddress,
        name: item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        amount: formatBalance(item.balance, item.digitalAsset?.decimals),
        tokenId: undefined,
        contractAddress: item.digitalAssetAddress,
        type: 'LSP7' as const,
        iconUrl: getIconUrl(item),
      }));

    // LSP8 NFTs from ownedTokens
    const nftItems = (ownedTokens || [])
      .filter(item => item.digitalAsset?.tokenType !== 'TOKEN')
      .map(item => ({
        id: item.digitalAssetAddress + '-' + item.tokenId,
        name: item.nft?.name || item.digitalAsset?.name || 'Unknown',
        symbol: item.digitalAsset?.symbol || '???',
        amount: undefined,
        tokenId: item.nft?.formattedTokenId || item.tokenId,
        contractAddress: item.digitalAssetAddress,
        type: 'LSP8' as const,
        iconUrl: getIconUrl(item),
      }));

    return [lyxItem, ...tokenItems, ...nftItems];
  }, [lyxBalance, ownedAssets, ownedTokens]);

  // Count for tabs
  const tokenCount = displayItems.filter(item => item.type === 'LYX' || item.type === 'LSP7').length;
  const nftCount = displayItems.filter(item => item.type === 'LSP8').length;

  // Filter by tab and search query
  const filteredItems = useMemo(() => {
    return displayItems.filter(item => {
      // Tab filter
      if (activeTab === 'tokens') {
        if (item.type !== 'LYX' && item.type !== 'LSP7') return false;
      } else {
        if (item.type !== 'LSP8') return false;
      }
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const nameMatch = item.name?.toLowerCase().includes(query);
        const symbolMatch = item.symbol?.toLowerCase().includes(query);
        const addressMatch = item.contractAddress?.toLowerCase().includes(query);
        if (!nameMatch && !symbolMatch && !addressMatch) return false;
      }
      return true;
    });
  }, [displayItems, activeTab, searchQuery]);

  // Sort
  const sortedItems = getSortedItems(displayItems, filteredItems);

  const showPlaceholder = !targetAddress;
  const showContent = !!targetAddress;

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>💎 Assets</h3>

      {showPlaceholder && (
        <p style={styles.empty}>🔌 Connect your wallet to view assets</p>
      )}

      {showContent && (
        <div style={{ animation: 'contentReveal 0.25s ease' }}>
          <div style={styles.tabs}>
            <button 
              style={{ ...styles.tab, ...(activeTab === 'tokens' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('tokens')}
            >
              🪙 <span style={styles.tabCount}>{tokenCount}</span> Tokens
            </button>
            <button 
              style={{ ...styles.tab, ...(activeTab === 'nfts' ? styles.tabActive : {}) }}
              onClick={() => setActiveTab('nfts')}
            >
              🖼️ <span style={styles.tabCount}>{nftCount}</span> NFTs
            </button>
          </div>

          <input
            type="text"
            placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={styles.searchInput}
          />
          
          <div style={styles.list}>
            {sortedItems.length === 0 ? (
              <p style={styles.empty}>No assets found</p>
            ) : (
              sortedItems.map((item) => (
                <div 
                  key={item.id} 
                  style={styles.item}
                  onClick={(e) => {
                    if (item.type === 'LSP7' || item.type === 'LSP8') {
                      handleSelectAsset(item.type === 'LSP7' ? 'token' : 'nft', item.contractAddress!, item.tokenId, e);
                    }
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.background = '#edf2f7';
                    (e.currentTarget as HTMLElement).style.cursor = item.type === 'LSP7' || item.type === 'LSP8' ? 'pointer' : 'default';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = '#f7fafc';
                  }}
                >
                  <div style={styles.itemIcon}>
                    {item.iconUrl ? (
                      <img src={item.iconUrl} alt="" style={styles.itemIconImg} />
                    ) : (
                      <span>
                        {item.type === 'LYX' ? '💎' : item.type === 'LSP7' ? '🪙' : '🖼️'}
                      </span>
                    )}
                  </div>
                  <div style={styles.itemInfo}>
                    <span style={styles.itemName}>{item.name}</span>
                    <span style={styles.itemSymbol}>{item.symbol}</span>
                  </div>
                  <div style={styles.itemAmount}>
                    {item.type === 'LYX'
                      ? `${parseFloat(item.amount || '0').toFixed(4)} LYX`
                      : item.type === 'LSP7'
                      ? `${formatTokenAmount(item.amount || '0')} ${item.symbol}`
                      : `#${item.tokenId || '?'}`}
                  </div>
                  {(item.type === 'LSP7' || item.type === 'LSP8') && (
                    <span style={styles.expandIcon}>›</span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Detail Popup */}
      {selectedAsset && selectedAssetData && (
        <AssetDetailPopup
          data={selectedAssetData as any}
          type={selectedAsset.type}
          onClose={handleClosePopup}
          position={popupPosition}
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
    name?: string | null;
    symbol?: string | null;
    tokenType?: string | null;
    decimals?: number | null;
    description?: string | null;
    totalSupply?: string | null;
    holderCount?: number | null;
    icons?: { url: string }[] | null;
    images?: { url: string; name?: string }[] | null;
    links?: { name?: string; url: string }[] | null;
    attributes?: { key: string; value: string; type?: string }[] | null;
  } | null;
  nft?: {
    name?: string | null;
    description?: string | null;
    formattedTokenId?: string | null;
    icons?: { url: string }[] | null;
    images?: { url: string; name?: string }[] | null;
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
}

function AssetDetailPopup({ data, type, onClose, position }: AssetDetailPopupProps) {
  const da = data.digitalAsset;
  const nft = data.nft;
  const isToken = type === 'token';

  // Get main image (larger for popup)
  // Priority: nft.images > nft.icons > digitalAsset.images > digitalAsset.icons
  const mainImageUrl = useMemo(() => {
    // 1. Try nft images
    if (nft?.images?.[0]?.url) return toGatewayUrl(nft.images[0].url);
    // 2. Try nft icons
    if (nft?.icons?.[0]?.url) return toGatewayUrl(nft.icons[0].url);
    // 3. Fall back to digitalAsset images
    if (da?.images?.[0]?.url) return toGatewayUrl(da.images[0].url);
    // 4. Fall back to digitalAsset icons (collection logo)
    if (da?.icons?.[0]?.url) return toGatewayUrl(da.icons[0].url);
    return null;
  }, [da, nft]);

  const links = isToken ? da?.links : nft?.links;
  const attributes = isToken ? da?.attributes : nft?.attributes;
  const contractAddress = data.digitalAssetAddress;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div 
        style={styles.popup}
        onClick={(e) => e.stopPropagation()}
      >
        <button style={styles.closeButton} onClick={onClose}>×</button>

        {mainImageUrl && (
          <div style={styles.popupImageWrapper}>
            <img src={mainImageUrl} alt="" style={styles.popupImage} />
          </div>
        )}

        <div style={styles.popupHeader}>
          <h3 style={styles.popupName}>{isToken ? da?.name || 'Unknown' : nft?.name || da?.name || 'Unknown'}</h3>
          {isToken ? (
            <span style={styles.popupSymbol}>{da?.symbol}</span>
          ) : (
            <span style={styles.popupSymbol}>#{nft?.formattedTokenId || data.tokenId || '?'}</span>
          )}
        </div>

        {/* Description */}
        {(isToken ? da?.description : nft?.description) && (
          <div style={{ marginBottom: '8px' }}>
            <p style={styles.popupDescription}>{isToken ? da?.description : nft?.description}</p>
          </div>
        )}

        {/* Token details */}
        {isToken && (
          <div style={styles.detailGrid}>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Supply</span>
              <span style={styles.detailValue}>{formatBigInt(da?.totalSupply, da?.decimals)}</span>
            </div>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Holders</span>
              <span style={styles.detailValue}>{da?.holderCount?.toLocaleString() || '-'}</span>
            </div>
            <div style={styles.detailItem}>
              <span style={styles.detailLabel}>Your Balance</span>
              <span style={styles.detailValue}>{formatBalance(data.balance, da?.decimals ?? null)}</span>
            </div>
            {da?.decimals != null && (
              <div style={styles.detailItem}>
                <span style={styles.detailLabel}>Decimals</span>
                <span style={styles.detailValue}>{da.decimals}</span>
              </div>
            )}
          </div>
        )}

        {/* Contract address */}
        {contractAddress && (
          <div style={styles.detailItem}>
            <span style={styles.detailLabel}>Contract</span>
            <span style={styles.detailValue} title={contractAddress}>
              <a 
                href={`https://explorer.execution.mainnet.lukso.network/address/${contractAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.link}
              >
                {shortenAddress(contractAddress)}
              </a>
            </span>
          </div>
        )}

        {/* External links */}
        {links && links.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <span style={styles.detailLabel}>Links</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' }}>
              {links.map((link, idx) => (
                <a
                  key={idx}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.outboundLink}
                >
                  {link.name || link.url} ↗
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Attributes */}
        {attributes && attributes.length > 0 && (
          <div style={{ marginTop: '8px' }}>
            <span style={styles.detailLabel}>Attributes</span>
            <div style={styles.attributesGrid}>
              {attributes.slice(0, 12).map((attr, idx) => (
                <div key={idx} style={styles.attributeItem}>
                  {attr.key && <span style={styles.attrKey}>{attr.key}</span>}
                  <span style={styles.attrValue}>{attr.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ========================
// Utility functions
// ========================

const formatBigInt = (raw: string | null | undefined, decimals: number | null | undefined): string => {
  if (!raw) return '-';
  try {
    return ethers.formatUnits(BigInt(raw), decimals || 18);
  } catch {
    return raw;
  }
};

// Format token amount for display
const formatTokenAmount = (amount: string) => {
  const num = parseFloat(amount);
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'K';
  } else if (num >= 1) {
    return num.toFixed(2);
  } else {
    return num.toFixed(6);
  }
};

// Sort items
const getSortedItems = (items: any[], filteredItems: any[]) => {
  return [...filteredItems].sort((a, b) => {
    if (a.type === 'LYX') return -1;
    if (b.type === 'LYX') return 1;
    
    if (a.type === 'LSP7' && b.type === 'LSP7') {
      const aAmount = parseFloat(a.amount || '0');
      const bAmount = parseFloat(b.amount || '0');
      return bAmount - aAmount;
    }
    
    if (a.type === 'LSP8' && b.type === 'LSP8') {
      const nameCompare = (a.name || '').localeCompare(b.name || '');
      if (nameCompare !== 0) return nameCompare;
      return (a.tokenId || '').localeCompare(b.tokenId || '');
    }
    
    return 0;
  });
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
  tabs: {
    display: 'flex',
    gap: '8px',
    marginBottom: '8px',
  },
  tab: {
    flex: 1,
    padding: '10px 12px',
    border: 'none',
    borderRadius: '10px',
    background: '#f7fafc',
    color: '#718096',
    fontSize: '0.85rem',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.25s ease',
    minHeight: '42px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
  },
  tabActive: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
  },
  tabCount: {
    fontWeight: '800',
  },
  searchInput: {
    width: '100%',
    padding: '8px 12px',
    marginBottom: '8px',
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    fontSize: '16px',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '450px',
    overflowY: 'auto',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 8px',
    background: '#f7fafc',
    borderRadius: '8px',
    transition: 'background 0.15s ease, transform 0.1s ease',
    position: 'relative',
  },
  itemIcon: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    overflow: 'hidden',
    flexShrink: 0,
  },
  itemIconImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  itemInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  itemName: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#2d3748',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemSymbol: {
    fontSize: '0.75rem',
    color: '#718096',
  },
  itemAmount: {
    fontSize: '0.75rem',
    fontWeight: '600',
    color: '#718096',
    textAlign: 'right',
    flexShrink: 0,
    maxWidth: '100px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  expandIcon: {
    fontSize: '1.2rem',
    color: '#cbd5e0',
    flexShrink: 0,
    marginLeft: '2px',
  },
  empty: {
    margin: 0,
    padding: '16px',
    textAlign: 'center',
    color: '#a0aec0',
    fontSize: '0.85rem',
  },

  // === Popup styles ===
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.3)',
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backdropFilter: 'blur(2px)',
  },
  popup: {
    background: '#ffffff',
    borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.15)',
    maxWidth: '420px',
    width: '90%',
    maxHeight: '70vh',
    overflowY: 'auto',
    overflowX: 'hidden',
    position: 'relative',
    padding: '16px',
    animation: 'popupIn 0.2s ease',
    transformOrigin: 'center',
  },
  closeButton: {
    position: 'absolute',
    top: '8px',
    right: '12px',
    background: 'none',
    border: 'none',
    fontSize: '1.5rem',
    cursor: 'pointer',
    color: '#718096',
    lineHeight: 1,
    zIndex: 1,
  },
  popupImageWrapper: {
    width: '100%',
    maxHeight: '200px',
    borderRadius: '12px',
    overflow: 'hidden',
    marginBottom: '12px',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    background: '#f7fafc',
  },
  popupImage: {
    maxWidth: '100%',
    maxHeight: '200px',
    objectFit: 'contain',
  },
  popupHeader: {
    marginBottom: '8px',
  },
  popupName: {
    fontSize: '1.1rem',
    fontWeight: '700',
    color: '#1a202c',
    margin: 0,
    lineHeight: 1.3,
  },
  popupSymbol: {
    fontSize: '0.8rem',
    color: '#718096',
    fontWeight: '500',
  },
  popupDescription: {
    fontSize: '0.85rem',
    color: '#4a5568',
    lineHeight: 1.5,
    margin: 0,
  },
  detailGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '8px',
    marginBottom: '8px',
  },
  detailItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  detailLabel: {
    fontSize: '0.7rem',
    color: '#a0aec0',
    fontWeight: '600',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.025em',
  },
  detailValue: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#2d3748',
    wordBreak: 'break-all' as const,
  },
  link: {
    color: '#667eea',
    textDecoration: 'none',
    wordBreak: 'break-all' as const,
  },
  outboundLink: {
    fontSize: '0.8rem',
    padding: '4px 8px',
    background: '#edf2f7',
    borderRadius: '6px',
    color: '#4a5568',
    textDecoration: 'none',
    transition: 'background 0.15s ease',
  },
  attributesGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '6px',
    marginTop: '4px',
  },
  attributeItem: {
    padding: '6px 8px',
    background: '#f7fafc',
    borderRadius: '8px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  attrKey: {
    fontSize: '0.7rem',
    color: '#a0aec0',
    fontWeight: '500',
  },
  attrValue: {
    fontSize: '0.85rem',
    fontWeight: '600',
    color: '#2d3748',
  },
};

// Global keyframe for popup animation
if (typeof document !== 'undefined') {
  const styleId = 'popup-keyframes';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes popupIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }
}
