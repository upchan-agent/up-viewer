'use client';

import { useUpProvider } from '@/lib/up-provider';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useEffect, useState, useMemo } from 'react';
import { ethers } from 'ethers';

interface AssetListProps {
  address?: `0x${string}`;
}

// Helper to get first icon URL (from digitalAsset or nft)
const getIconUrl = (item: { digitalAsset?: { icons?: { url: string }[] | null } | null; nft?: { icons?: { url: string }[] | null } | null }): string | undefined => {
  // Try nft icons first (specific NFT image)
  if (item.nft?.icons?.[0]?.url) {
    return toGatewayUrl(item.nft.icons[0].url);
  }
  // Fall back to collection icons
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

export function AssetList({ address }: AssetListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [lyxBalance, setLyxBalance] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tokens' | 'nfts'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');

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
      digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true } 
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
      digitalAsset: { name: true, symbol: true, tokenType: true, icons: true },
      nft: { formattedTokenId: true, name: true, icons: true },
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

  // Build display items
  const displayItems = useMemo(() => {
    // LYX item
    const lyxItem = {
      id: 'lyx',
      name: 'LYX',
      symbol: 'LYX',
      amount: lyxBalance || '0',
      tokenId: undefined,
      type: 'LYX',
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
        type: 'LSP7',
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
        type: 'LSP8',
        iconUrl: getIconUrl(item),
      }));

    return [lyxItem, ...tokenItems, ...nftItems];
  }, [lyxBalance, ownedAssets, ownedTokens]);

  // Filter based on tab and search
  const filteredItems = useMemo(() => {
    let filtered = displayItems.filter(item => {
      if (activeTab === 'tokens') {
        return item.type === 'LYX' || item.type === 'LSP7';
      } else {
        return item.type === 'LSP8';
      }
    });

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(item => 
        item.name.toLowerCase().includes(query) || 
        item.symbol.toLowerCase().includes(query) ||
        (item.tokenId && item.tokenId.toLowerCase().includes(query))
      );
    }

    return filtered;
  }, [displayItems, activeTab, searchQuery]);

  // Sort
  const sortedItems = useMemo(() => {
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
  }, [filteredItems]);

  // Count for tabs
  const tokenCount = displayItems.filter(item => item.type === 'LYX' || item.type === 'LSP7').length;
  const nftCount = displayItems.filter(item => item.type === 'LSP8').length;

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
                <div key={item.id} style={styles.item}>
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
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

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
  empty: {
    margin: 0,
    padding: '16px',
    textAlign: 'center',
    color: '#a0aec0',
    fontSize: '0.85rem',
  },
};