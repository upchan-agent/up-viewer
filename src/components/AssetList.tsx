'use client';

import { useUpProvider } from '@/lib/up-provider';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens, useNft } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useEffect, useState, useMemo, useCallback, useRef, memo } from 'react';
import { ethers } from 'ethers';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { ErrorImage } from '@/components/ErrorImage';
import {
  useAssetImage,
  apiFetch,
  apiSubscribe,
  fetchAssetImage,
  fetchTokenImage,
  setAssetCachePopupOpen,
  _apiCache,
} from '@/lib/asset-image-cache';
import type { ResolvedIcon, ResolvedAssetImage } from '@/lib/asset-image-cache';
import { LazyRow } from '@/components/LazyRow';

interface AssetListProps {
  address?: `0x${string}`;
  active?: boolean;  // true のとき初回フェッチを許可（hasBeenActive パターン）
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
  if (tid.startsWith('0x')) {
    // Already hex — lowercase and pad to 64 chars
    const hex = tid.slice(2).replace(/[^0-9a-fA-F]/g, '').toLowerCase();
    return '0x' + hex.padStart(64, '0');
  }
  // Decimal number — convert to hex and pad
  const digits = tid.replace(/[^0-9]/g, '');
  if (!digits) return '0x' + '0'.repeat(64);
  return '0x' + BigInt(digits).toString(16).padStart(64, '0');
};

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
      {icon
        ? <ErrorImage src={icon.url} style={styles.itemIconImg} fallback={<span>{fallbackEmoji}</span>} />
        : <span>{fallbackEmoji}</span>}
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

// ResolvedAssetImage は @/lib/asset-image-cache から import 済み
// (旧 ResolvedAssetImage と同一定義)
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
}): ResolvedAssetImage | undefined {
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

  // Per-key subscription — only re-renders when this component's own fetch completes
  const [, setTick] = useState(0);
  useEffect(() => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  // Kick off API fetch once useNft settles
  useEffect(() => {
    if (nftLoadingRaw) return;
    const nftMetadata = nftData as any;
    const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
    if (nftImages.some(isUsableIpfs)) return;
    apiFetch(imageCacheKey, () => fetchTokenImage(contractAddressLower, tokenIdHex), isPopupContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nftLoadingRaw, imageCacheKey]);

  // ── Priority chain — all levels evaluated before returning ─
  // Each level is always checked and logged, so debug[] always shows
  // the complete picture regardless of which level resolved the image.

  if (nftLoadingRaw) return undefined; // waiting for useNft hook

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
  useEffect(() => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  useEffect(() => {
    if (collectionIcon) return;
    apiFetch(imageCacheKey, () => fetchAssetImage(collectionAddress));
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

// ─── TokenListItem ─────────────────────────────────────────
// モジュールレベル定義により、AssetList 再レンダー時の
// 不要なアンマウント→マウントを防ぐ（hooks のステートリセット回避）。

function TokenListItem({ item, onSelect }: {
  item: TokenItem;
  onSelect: (type: 'token' | 'nft', addr: string, tid?: string, e?: React.MouseEvent) => void;
}) {
  const resolved = useAssetImage({
    type: 'token',
    contractAddress: item.contractAddress,
    indexerIcon: item.indexerIcon,
  });
  const displayIcon = resolved?.url ? resolved : undefined;
  return (
    <div
      className="list-item"
      style={styles.item}
      onClick={(e) => onSelect('token', item.contractAddress, undefined, e)}
    >
      {renderIcon(displayIcon, '💎')}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{item.name}</span>
        <span style={styles.itemSymbol}>{item.symbol}</span>
      </div>
      <div style={styles.itemAmount}>{formatTokenAmount(item.amount || '0')} {item.symbol}</div>
      <span style={styles.expandIcon}>›</span>
    </div>
  );
}

// ─── Lsp7SingleNftListItem ──────────────────────────────────

function Lsp7SingleNftListItem({ item, onSelect }: {
  item: NftListEntry;
  onSelect: (type: 'token' | 'nft', addr: string, tid?: string, e?: React.MouseEvent) => void;
}) {
  const resolved = useAssetImage({
    type: 'lsp7nft',
    contractAddress: item.contractAddress,
    indexerIcon: item.collectionFallbackIcon,
  });
  const displayIcon = resolved?.url ? resolved : undefined;
  return (
    <div
      className="list-item"
      style={styles.item}
      onClick={(e) => onSelect('nft', item.contractAddress, item.tokenId, e)}
    >
      {renderIcon(displayIcon, '🖼️')}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{item.name}</span>
        <span style={styles.itemSymbol}>{item.amount ? `${item.amount} ${item.symbol}` : item.symbol}</span>
      </div>
      <span style={styles.expandIcon}>›</span>
    </div>
  );
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
    <div
      className="list-item"
      style={{ ...styles.item, marginLeft: '12px' }}
      onClick={(e) => handleSelectAsset('nft', entry.contractAddress, entry.tokenId, e)}
    >
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
    <div style={{ background: 'var(--color-surface-nft-header)', height: '32px', display: 'flex', alignItems: 'center' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', userSelect: 'none', opacity: 1, transition: `opacity var(--transition-fast)`, width: '100%' }}
        onClick={() => onToggle(sectionKey)}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.7'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
      >
        <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: '700', color: 'var(--color-text-section)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-faint)', fontWeight: '500' }}>{protocol}</span>
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-border-muted)', fontWeight: '600', marginLeft: 'auto' }}>{count}</span>
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
    <div
      className="list-item"
      style={{ ...styles.item, fontWeight: 600 }}
      onClick={() => onToggle(coll.id)}
    >
      {renderIcon(collIcon, '📂')}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{coll.name}</span>
        <span style={styles.itemSymbol}>{coll.count} NFTs</span>
      </div>
      <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
    </div>
  );
}

// ─── NftList ───────────────────────────────────────────────
// displayLimitNfts で表示件数が制御されるため仮想化は不要。
// 通常リストにすることでスクロールバーが安定し縮小しなくなる。
// モジュールレベル定義は維持（AssetList 再レンダー時の scroll-to-top を防ぐ）。

function nftRowKey(row: VirtualRow, i: number): string {
  switch (row.kind) {
    case 'section-header':    return `sh-${row.sectionKey}`;
    case 'divider':           return `div-${i}`;
    case 'collection-header': return `ch-${row.coll.id}`;
    case 'nft-child':         return `nc-${row.child.id}`;
    case 'lsp7-single':       return `l7-${row.item.id}`;
  }
}

const NftVirtualList = memo(function NftVirtualList({
  rows,
  renderRow,
}: {
  rows: VirtualRow[];
  renderRow: (row: VirtualRow) => React.ReactNode;
  initialOffset?: number;
}) {
  if (rows.length === 0) return <p style={styles.empty}>No NFTs found</p>;

  return (
    <div style={styles.list}>
      {rows.map((row, i) => (
        <div key={nftRowKey(row, i)}>
          {renderRow(row)}
        </div>
      ))}
    </div>
  );
});

// ─── component ─────────────────────────────────────────────

export function AssetList({ address, active = true }: AssetListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;

  // ── hasBeenActive: 一度でもアクティブになったか ──────────────
  // 常時マウント環境で、初回タブ訪問まではフェッチを行わない。
  // 一度アクティブになったら以降はタブを離れてもデータを保持する。
  // 将来の prefetch 制御や優先度管理もここを起点に拡張できる。
  const hasBeenActive = useRef(false);
  if (active) hasBeenActive.current = true;
  const shouldFetch = hasBeenActive.current;

  const [lyxBalance, setLyxBalance] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'tokens' | 'nfts'>('tokens');
  const [searchQuery, setSearchQuery] = useState('');

  // 表示件数の制御。Load more = この値を増やすだけ（追加フェッチなし）
  // addressが変わったらリセット
  const DISPLAY_PAGE = 200;
  const [displayLimitTokens, setDisplayLimitTokens] = useState(DISPLAY_PAGE);
  const [displayLimitNfts,   setDisplayLimitNfts]   = useState(DISPLAY_PAGE);
  useEffect(() => {
    setDisplayLimitTokens(DISPLAY_PAGE);
    setDisplayLimitNfts(DISPLAY_PAGE);
  }, [targetAddress]);

  const [selectedAsset, setSelectedAsset] = useState<{ type: 'token' | 'nft'; address: string; formattedTokenId?: string } | null>(null);
  const [popupPosition, setPopupPosition] = useState<{ top: number; right: number }>({ top: 0, right: 0 });
  const [expandedCollections, setExpandedCollections] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['lsp8', 'lsp7']));
  const [nftFilter, setNftFilter] = useState<'all' | 'lsp8' | 'lsp7'>('all');

  const toggleSection = useCallback((key: string) => {
    setExpandedSections(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }, []);

  // ─── Data hooks ──────────────────────────────────────────
  // 取得層: pageSize:500 + 自動フェッチで全件をメモリに保持。
  //         検索・総数表示はこの全件データを対象とする。
  // 表示層: displayLimitAssets / displayLimitTokens で表示件数を制御。
  //         Load more は追加フェッチではなく表示件数の拡張のみ。
  //         DOM に乗るのは displayLimit 件数分のみ → 端末負荷を抑制。

  const fetchAddress = shouldFetch && targetAddress ? targetAddress.toLowerCase() : undefined;

  const {
    ownedAssets, hasNextPage: hasMoreAssets, fetchNextPage: fetchMoreAssets,
    isFetchingNextPage: loadingMoreAssets,
  } = useInfiniteOwnedAssets({
    filter: { holderAddress: fetchAddress },
    include: { balance: true, digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true, url: true } },
    pageSize: 500,
  });

  const {
    ownedTokens, hasNextPage: hasMoreTokens, fetchNextPage: fetchMoreTokens,
    isFetchingNextPage: loadingMoreTokens,
  } = useInfiniteOwnedTokens({
    filter: { holderAddress: fetchAddress },
    include: { digitalAsset: { name: true, symbol: true, tokenType: true, icons: true, description: true, totalSupply: true, holderCount: true, images: true, links: true, attributes: true }, nft: { formattedTokenId: true, name: true, icons: true, description: true, images: true, links: true, attributes: true } },
    pageSize: 500,
  });

  // バックグラウンドで全件フェッチ（ref で安定化）
  const fetchMoreAssetsRef = useRef(fetchMoreAssets);
  fetchMoreAssetsRef.current = fetchMoreAssets;
  
  const fetchMoreTokensRef = useRef(fetchMoreTokens);
  fetchMoreTokensRef.current = fetchMoreTokens;

  useEffect(() => { if (hasMoreAssets && !loadingMoreAssets) fetchMoreAssetsRef.current(); }, [hasMoreAssets, loadingMoreAssets]);
  useEffect(() => { if (hasMoreTokens && !loadingMoreTokens) fetchMoreTokensRef.current(); }, [hasMoreTokens, loadingMoreTokens]);

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
    setAssetCachePopupOpen(true);
    setSelectedAsset({ type, address: addr, formattedTokenId });
  }, []);

  const handleClosePopup = useCallback(() => {
    setAssetCachePopupOpen(false);
    setSelectedAsset(null);
  }, []);
  const toggleCollection = useCallback((id: string) => {
    setExpandedCollections(prev => {
      const n = new Set(prev);
      const k = id.toLowerCase();
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClosePopup(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [handleClosePopup]);

  // ─── Token items ─────────────────────────────────────────
  // tokenItems: 全件（検索対象・総数表示用）
  // displayedTokenItems: displayLimitTokens 件に絞った表示用

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

  const displayedTokenItems = useMemo(
    () => tokenItems.slice(0, displayLimitTokens),
    [tokenItems, displayLimitTokens],
  );

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

  // ─── Token list item / LSP7 Single NFT list item ───────────
  // モジュールレベルに定義済み（コンポーネント内定義を解消）。
  // → TokenListItem / Lsp7SingleNftListItem を参照。

  // ─── Virtual row types ───────────────────────────────────
  // NFT list is flattened into a single array for virtualization.
  // Only rows visible in the viewport are mounted — this is the fix
  // for "300 NftChildItems all mounted at once" causing device heating.

  // ─── Flat virtual rows ───────────────────────────────────
  // displayLimitNfts: nft-child + lsp7-single の表示件数上限。
  // section-header / collection-header / divider はカウント対象外。

  const virtualRows = useMemo((): VirtualRow[] => {
    const showLsp8 = nftFilter !== 'lsp7';
    const showLsp7 = nftFilter !== 'lsp8';
    const rows: VirtualRow[] = [];
    const hasCollections = nftTree.length > 0 && showLsp8;
    const hasSingles = lsp7Nfts.length > 0 && showLsp7;
    if (!hasCollections && !hasSingles) return rows;
    const collTotal = (nftTree as NftCollEntry[]).reduce((s, c) => s + c.count, 0);

    let leafCount = 0;  // nft-child + lsp7-single のカウント

    if (hasCollections) {
      rows.push({ kind: 'section-header', label: 'Collection NFT', protocol: 'LSP8', count: collTotal, sectionKey: 'lsp8' });
      if (expandedSections.has('lsp8')) {
        for (const item of nftTree) {
          if (leafCount >= displayLimitNfts) break;
          const coll = item as NftCollEntry;
          rows.push({ kind: 'collection-header', coll });
          if (expandedCollections.has(coll.id.toLowerCase())) {
            for (const child of coll.children) {
              if (leafCount >= displayLimitNfts) break;
              rows.push({ kind: 'nft-child', child });
              leafCount++;
            }
          }
        }
      }
    }
    if (hasCollections && hasSingles) rows.push({ kind: 'divider' });
    if (hasSingles) {
      rows.push({ kind: 'section-header', label: 'Single NFT', protocol: 'LSP7', count: lsp7Nfts.length, sectionKey: 'lsp7' });
      if (expandedSections.has('lsp7')) {
        for (const item of lsp7Nfts) {
          if (leafCount >= displayLimitNfts) break;
          rows.push({ kind: 'lsp7-single', item });
          leafCount++;
        }
      }
    }
    return rows;
  }, [nftTree, lsp7Nfts, nftFilter, expandedSections, expandedCollections, displayLimitNfts]);

  // scrollOffset: save position before rows change, restore after
  // ─── NFT フィルター切り替え ───────────────────────────────
  // 常時マウント環境では DOM が破棄されないため scrollTop は自然に保持される。
  // 旧来の nftScrollByFilter / nftFilterSwitching / useLayoutEffect による
  // 複雑なスクロール位置管理は不要になった。

  const handleNftFilterChange = useCallback((next: 'all' | 'lsp8' | 'lsp7') => {
    if (next === nftFilter) return;
    setNftFilter(next);
  }, [nftFilter]);

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
        return <div style={{ height: '17px', display: 'flex', alignItems: 'center' }}><div style={{ height: '1px', background: 'var(--color-border-default)', width: '100%' }} /></div>;
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
          <LazyRow>
            <NftChildItem
              entry={row.child}
              collectionFallbackIcon={row.child.collectionFallbackIcon}
              handleSelectAsset={handleSelectAsset}
            />
          </LazyRow>
        );
      case 'lsp7-single':
        return (
          <LazyRow>
            <Lsp7SingleNftListItem item={row.item} onSelect={handleSelectAsset} />
          </LazyRow>
        );
    }
  }, [expandedSections, toggleSection, toggleCollection, handleSelectAsset]);

  // NftVirtualList is defined at module level (below) to prevent
  // useVirtualizer from resetting on every AssetList re-render.

  // ─── Render ──────────────────────────────────────────────

  const showPlaceholder = !targetAddress;

  const renderTokenList = (items: TokenItem[]) => (
    <div style={styles.list}>
      {items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => {
        if (item.type === 'LYX') {
          return (
            <div
              key={item.id}
              className="list-item"
              style={styles.item}
              onClick={(e) => handleSelectAsset('token' as const, item.contractAddress, undefined, e)}
            >
              {renderIcon(undefined, '💎')}
              <div style={styles.itemInfo}>
                <span style={styles.itemName}>{item.name}</span>
                <span style={styles.itemSymbol}>{item.symbol}</span>
              </div>
              <div style={styles.itemAmount}>{parseFloat(item.amount || '0').toFixed(4)} LYX</div>
              <span style={styles.expandIcon}>›</span>
            </div>
          );
        }
        return <TokenListItem key={item.id} item={item} onSelect={handleSelectAsset} />;
      })}
      {/* Load more — displayLimitTokens を拡張するだけ（追加フェッチなし） */}
      {displayedTokenItems.length < tokenItems.length && (
        <div style={styles.showMoreRow}>
          <button
            style={styles.showMoreButton}
            onClick={() => setDisplayLimitTokens(n => n + DISPLAY_PAGE)}
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );

  // ─── Popup ───────────────────────────────────────────────
  // All three asset types resolved via dedicated hooks.
  // isLsp8Popup:    useLsp8ChildImage
  // isTokenPopup:   useAssetImage({ type: 'token' })
  // isLsp7NftPopup: useAssetImage({ type: 'lsp7nft' })

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
  const popupTokenImage = useAssetImage(
    isTokenPopup && popupContractAddress
      ? {
          type: 'token',
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
          isPopupContext: true,
        }
      : { type: 'token', contractAddress: 'skip' }
  );

  // LSP7 Single NFT popup image
  const popupLsp7NftImage = useAssetImage(
    isLsp7NftPopup && popupContractAddress
      ? {
          type: 'lsp7nft',
          contractAddress: popupContractAddress,
          indexerIcon: resolveDaIcon(selectedOwnedData) ?? undefined,
          isPopupContext: true,
        }
      : { type: 'lsp7nft', contractAddress: 'skip' }
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
        // flex:1 でカード残余スペースを占有し、内部でリストが伸長する
        <div className="content-reveal" style={styles.cardBody}>
          <div style={styles.tabs}>
            <button style={{ ...styles.tab, ...(activeTab === 'tokens' ? styles.tabActive : {}) }} onClick={() => setActiveTab('tokens')}>🪙 <span style={styles.tabCount}>{hasMoreAssets ? `${tokenItems.length}+` : tokenItems.length}</span> Tokens</button>
            <button style={{ ...styles.tab, ...(activeTab === 'nfts' ? styles.tabActive : {}) }} onClick={() => setActiveTab('nfts')}>🖼️ <span style={styles.tabCount}>{(nftTree as NftCollEntry[]).reduce((s, i) => s + i.count, 0) + lsp7Nfts.length}</span> NFTs</button>
          </div>
          {/* 検索バー — NFTs タブ時は右端にフィルターボタンを表示 */}
          <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-2)', alignItems: 'center', flexShrink: 0 }}>
            <input
              type="text"
              placeholder={activeTab === 'tokens' ? '🔍 Search tokens...' : '🔍 Search NFTs...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ ...styles.searchInput, flex: 1 }}
            />
            {activeTab === 'nfts' && (
              <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                {(['all', 'lsp8', 'lsp7'] as const).map(f => (
                  <button
                    key={f}
                    onClick={() => handleNftFilterChange(f)}
                    style={{
                      padding: '6px 8px',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: 'var(--text-sm)',
                      fontWeight: '600',
                      lineHeight: 1,
                      background: nftFilter === f ? 'var(--gradient-brand)' : 'var(--color-surface-tab-inactive)',
                      color: nftFilter === f ? 'var(--color-text-white)' : 'var(--color-text-muted)',
                      transition: `all var(--transition-fast)`,
                    }}
                  >
                    {f === 'all' ? 'All' : f.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* リスト領域 — flex:1 で残余スペースを占有 */}
          <div style={styles.listArea}>
            <div style={{ display: activeTab === 'tokens' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              {renderTokenList(displayedTokenItems)}
            </div>
            <div style={{ display: activeTab === 'nfts' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: '60px' }}>
              {!targetAddress ? (
                <p style={styles.empty}>🔌</p>
              ) : virtualRows.length === 0 && ownedTokens.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-faint)', fontSize: 'var(--text-md)' }}>Loading...</div>
              ) : virtualRows.length === 0 ? (
                <p style={styles.empty}>No NFTs found</p>
              ) : (
                <>
                  <NftVirtualList rows={virtualRows} renderRow={renderVirtualRow} />
                  {/* Load more — displayLimitNfts を拡張（追加フェッチなし） */}
                  {(() => {
                    const leafTotal = nftTree.reduce((s, c) => s + (c as NftCollEntry).count, 0) + lsp7Nfts.length;
                    return displayLimitNfts < leafTotal ? (
                      <div style={{ ...styles.showMoreRow, flexShrink: 0 }}>
                        <button
                          style={styles.showMoreButton}
                          onClick={() => setDisplayLimitNfts(n => n + DISPLAY_PAGE)}
                        >
                          Load more
                        </button>
                      </div>
                    ) : null;
                  })()}
                </>
              )}
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
  card: {
    padding: 'var(--card-padding)',
    background: 'var(--color-surface-card)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-card)',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  // card 直下の可変領域 — flex:1 でカード残余スペースを占有
  cardBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  // リスト表示領域 — flex:1 で cardBody 残余を占有
  listArea: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
  title: {
    margin: '0 0 var(--space-2) 0',
    fontSize: 'var(--text-lg)',
    fontWeight: '700',
    color: 'var(--color-text-primary)',
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    gap: 'var(--space-2)',
    marginBottom: 'var(--space-2)',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '10px 12px',
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-surface-tab-inactive)',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--text-md)',
    fontWeight: '600',
    cursor: 'pointer',
    transition: `all var(--transition-slow)`,
    minHeight: 'var(--tab-height)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1)',
  },
  tabActive: {
    background: 'var(--gradient-brand)',
    color: 'var(--color-text-white)',
  },
  tabCount: { fontWeight: '800' },
  searchInput: {
    width: '100%',
    padding: '8px 12px',
    border: `1px solid var(--color-border-default)`,
    borderRadius: 'var(--radius-md)',
    fontSize: '16px',
    outline: 'none',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  list: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--list-item-gap)',
    overflowY: 'scroll',       // auto → scroll: バーを常時表示して消失を防ぐ
    minHeight: 'var(--list-min-height)',
  },
  // item の background / transition は globals.css .list-item クラスで管理
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '0 var(--space-2)',   // 縦 padding は height で制御
    borderRadius: 'var(--radius-md)',
    position: 'relative',
    height: 'var(--item-height)',
    overflow: 'hidden',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  itemIcon: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    overflow: 'hidden',
    flexShrink: 0,
  },
  itemIconWithImg: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    background: 'var(--color-surface-input)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    overflow: 'hidden',
    flexShrink: 0,
  },
  itemIconImg: { width: '100%', height: '100%', objectFit: 'cover' },
  itemInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  itemName: {
    fontSize: 'var(--text-md)',
    fontWeight: '600',
    color: 'var(--color-text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  itemSymbol: {
    fontSize: 'var(--text-base)',
    color: 'var(--color-text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '200px',
    flexShrink: 0,
  },
  itemAmount: {
    fontSize: 'var(--text-base)',
    fontWeight: '600',
    color: 'var(--color-text-muted)',
    textAlign: 'right',
    flexShrink: 0,
    maxWidth: '100px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  expandIcon: {
    fontSize: '1.2rem',
    color: 'var(--color-border-muted)',
    flexShrink: 0,
    marginLeft: '2px',
  },
  empty: {
    margin: 0,
    padding: 'var(--space-4)',
    textAlign: 'center',
    color: 'var(--color-text-faint)',
    fontSize: 'var(--text-md)',
  },
  // ── Show More ──
  // リスト末尾に配置。flexShrink:0 で高さを確保し、
  // リストエリアを圧迫しない。
  showMoreRow: {
    padding: 'var(--space-1) 0',
    display: 'flex',
    justifyContent: 'center',
    flexShrink: 0,
  },
  showMoreButton: {
    padding: '5px 16px',
    border: `1px solid var(--color-border-default)`,
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--text-sm)',
    fontWeight: '600',
    cursor: 'pointer',
    transition: `all var(--transition-fast)`,
  },
  showMoreButtonLoading: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
};
