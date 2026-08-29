'use client';

import { useUpProvider } from '@/lib/up-provider';
import { getRpcProvider } from '@/lib/rpc';
import { usePopupAssetMeta } from '@/lib/popup-asset-meta';
import { useInfiniteOwnedAssets, useInfiniteOwnedTokens, useNft } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useEffect, useState, useMemo, useCallback, useRef, memo } from 'react';
import { ethers } from 'ethers';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { ErrorImage, ImagePending } from '@/components/ErrorImage';
import {
  useAssetImage,
  apiFetch,
  apiSubscribe,
  fetchAssetImage,
  fetchTokenImage,
  setAssetCachePopupOpen,
  apiCacheGet,
  apiCacheHas,
} from '@/lib/asset-image-cache';
import type { ResolvedIcon, ResolvedAssetImage } from '@/lib/asset-image-cache';
import { traceHit, traceMiss, traceWait, traceSkip, isDebugEnabled, type TraceStep } from '@/lib/debug-trace';

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

const isUsableImageUrl = (url: string): boolean => {
  // CIDv1 does not require a file extension. Rejecting bare `baf…` values
  // caused valid NFT images to trigger an unnecessary Envio fallback query.
  return url.trim().length > 0;
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

// ─── interactive row helpers ────────────────────────────────

function activateRowFromKeyboard(
  event: React.KeyboardEvent<HTMLElement>,
  activate: () => void,
) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  activate();
}

// ─── renderIcon (standalone, no re-creation on each render) ──

function renderIcon(icon: ResolvedIcon | undefined, fallback: string, isLoading = false) {
  const label = fallback.slice(0, 3);
  const fallbackNode = <span style={styles.iconInitial}>{label}</span>;
  const frameStyle = isLoading
    ? styles.itemIconPending
    : icon ? styles.itemIconWithImg : styles.itemIcon;
  return (
    <div style={frameStyle}>
      {isLoading
        ? <ImagePending />
        : icon
          ? (
            <ErrorImage
              src={icon.url}
              style={styles.itemIconImg}
              loading="lazy"
              fetchPriority="low"
              pendingFallback={<ImagePending />}
              fallback={fallbackNode}
            />
          )
          : fallbackNode}
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
//   1. useNft.images              (flattenImages + isUsableImageUrl)
//   2. api.Token                  (fetchTokenImage — covers non-standard NFTs)
//   3. useNft.icons
//   4. useNft.collection.icons
//   5. ownedToken.nft icons/images (passed as nftIndexerData — popup only)
//   6. collectionFallbackIcon      (parent collection icon)
//
// Return value:
//   undefined           → still resolving (caller shows placeholder)
//   { url: '', ... }    → confirmed no image (caller shows emoji)
//   { url: '...', ... } → resolved (caller shows image)
//

// ResolvedAssetImage は @/lib/asset-image-cache から import 済み
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
}): (ResolvedAssetImage & { trace?: TraceStep[] }) | undefined {
  const contractAddressLower = contractAddress.toLowerCase();
  const shouldResolve = !!contractAddress && formattedTokenId !== 'skip';
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

  // Per-key subscription — only re-renders when this component's own fetch completes
  const [, setTick] = useState(0);
  useEffect(() => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  // Kick off API fetch once useNft settles
  useEffect(() => {
    if (!shouldResolve || nftLoadingRaw) return;
    const nftMetadata = nftData as any;
    const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
    if (nftImages.some(isUsableImageUrl)) return;
    apiFetch(imageCacheKey, () => fetchTokenImage(contractAddressLower, tokenIdHex), isPopupContext);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nftLoadingRaw, imageCacheKey, shouldResolve]);

  if (!shouldResolve) return { url: '', scheme: 'none', trace: [] };
  if (nftLoadingRaw) return undefined; // waiting for useNft hook

  const nftMetadata = nftData as any;

  // Priority chain levels
  const nftImages = nftMetadata ? flattenImages(nftMetadata) : [];
  const usableImageUrl = nftImages.find(isUsableImageUrl);

  const cachedImageUrl = apiCacheGet(imageCacheKey) ?? undefined;
  const isCacheSettled = apiCacheHas(imageCacheKey);

  const nftIconUrl = nftMetadata?.icons?.[0]?.url;
  const collectionIconUrl = nftMetadata?.collection?.icons?.[0]?.url;
  const indexerImageUrl = nftIndexerData?.icons?.[0]?.url || nftIndexerData?.images?.[0]?.url;

  // ── Select winner in priority order ─────────────────────
  // Every candidate source is recorded as a TraceStep so the popup
  // debug panel can show WHY this image resolved the way it did.
  if (usableImageUrl) {
    const url = toGatewayUrl(usableImageUrl)!;
    return {
      url, scheme: 'useNft.images',
      trace: [
        traceHit('1. useNft.images', url),
        traceSkip('2. api.Token'), traceSkip('3. useNft.icons'),
        traceSkip('4. useNft.collection.icons'), traceSkip('5. ownedToken.nft'),
        traceSkip('6. collectionFallbackIcon'),
      ],
    };
  }
  if (!isCacheSettled) {
    return {
      url: '', scheme: 'loading',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceWait('2. api.Token'),
        traceWait('3. useNft.icons'),
        traceWait('4. useNft.collection.icons'),
        indexerImageUrl ? traceHit('5. ownedToken.nft', toGatewayUrl(indexerImageUrl)!) : traceMiss('5. ownedToken.nft'),
        collectionFallbackIcon?.url ? traceHit('6. collectionFallbackIcon', collectionFallbackIcon.url) : traceMiss('6. collectionFallbackIcon'),
      ],
    }; // still waiting for API
  }
  if (cachedImageUrl) {
    const url = cachedImageUrl;
    return {
      url, scheme: 'api.Token',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceHit('2. api.Token', url),
        traceSkip('3. useNft.icons'), traceSkip('4. useNft.collection.icons'),
        traceSkip('5. ownedToken.nft'), traceSkip('6. collectionFallbackIcon'),
      ],
    };
  }
  if (nftIconUrl) {
    const url = toGatewayUrl(nftIconUrl)!;
    return {
      url, scheme: 'useNft.icons',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceMiss('2. api.Token', '(null)'),
        traceHit('3. useNft.icons', url),
        traceSkip('4. useNft.collection.icons'), traceSkip('5. ownedToken.nft'),
        traceSkip('6. collectionFallbackIcon'),
      ],
    };
  }
  if (collectionIconUrl) {
    const url = toGatewayUrl(collectionIconUrl)!;
    return {
      url, scheme: 'useNft.collection.icons',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceMiss('2. api.Token', '(null)'),
        traceMiss('3. useNft.icons', '(none)'),
        traceHit('4. useNft.collection.icons', url),
        traceSkip('5. ownedToken.nft'), traceSkip('6. collectionFallbackIcon'),
      ],
    };
  }
  if (indexerImageUrl) {
    const url = toGatewayUrl(indexerImageUrl)!;
    return {
      url, scheme: 'ownedToken.nft',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceMiss('2. api.Token', '(null)'),
        traceMiss('3. useNft.icons', '(none)'),
        traceMiss('4. useNft.collection.icons', '(none)'),
        traceHit('5. ownedToken.nft', url),
        traceSkip('6. collectionFallbackIcon'),
      ],
    };
  }
  if (collectionFallbackIcon?.url) {
    const url = collectionFallbackIcon.url;
    return {
      url, scheme: 'collectionFallbackIcon',
      trace: [
        traceMiss('1. useNft.images', 'no usable image'),
        traceMiss('2. api.Token', '(null)'),
        traceMiss('3. useNft.icons', '(none)'),
        traceMiss('4. useNft.collection.icons', '(none)'),
        traceMiss('5. ownedToken.nft', '(none)'),
        traceHit('6. collectionFallbackIcon', url),
      ],
    };
  }

  // Confirmed: no image from any source.
  return {
    url: '', scheme: 'none',
    trace: [
      traceMiss('1. useNft.images', 'no usable image'),
      traceMiss('2. api.Token', '(null)'),
      traceMiss('3. useNft.icons', nftIconUrl ? 'unusable' : '(none)'),
      traceMiss('4. useNft.collection.icons', collectionIconUrl ? 'unusable' : '(none)'),
      traceMiss('5. ownedToken.nft', indexerImageUrl ? 'unusable' : '(none)'),
      traceMiss('6. collectionFallbackIcon', '(none)'),
    ],
  };
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
}): { icon: ResolvedIcon | undefined; isLoading: boolean } {
  const imageCacheKey = `lsp8coll:${collectionAddress.toLowerCase()}`;

  const [, setTick] = useState(0);
  useEffect(() => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)), [imageCacheKey]);

  useEffect(() => {
    if (collectionIcon) return;
    apiFetch(imageCacheKey, () => fetchAssetImage(collectionAddress));
  }, [imageCacheKey, collectionAddress, collectionIcon]);

  const cachedImageUrl = apiCacheGet(imageCacheKey) ?? undefined;
  const isCacheSettled = apiCacheHas(imageCacheKey);

  if (collectionIcon?.url) return { icon: collectionIcon, isLoading: false };
  if (isCacheSettled && cachedImageUrl) {
    return { icon: { url: cachedImageUrl, scheme: 'api.Asset' }, isLoading: false };
  }
  return { icon: undefined, isLoading: !isCacheSettled };
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
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.name} details`}
      onClick={(e) => onSelect('token', item.contractAddress, undefined, e)}
      onKeyDown={(e) => activateRowFromKeyboard(e, () => onSelect('token', item.contractAddress))}
    >
      {renderIcon(
        displayIcon,
        item.symbol || item.name || 'T',
        resolved === undefined || resolved?.scheme === 'loading',
      )}
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
      role="button"
      tabIndex={0}
      aria-label={`Open ${item.name} details`}
      onClick={(e) => onSelect('nft', item.contractAddress, item.tokenId, e)}
      onKeyDown={(e) => activateRowFromKeyboard(e, () => onSelect('nft', item.contractAddress, item.tokenId))}
    >
      {renderIcon(
        displayIcon,
        item.name || item.symbol || 'N',
        resolved === undefined || resolved?.scheme === 'loading',
      )}
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
      role="button"
      tabIndex={0}
      aria-label={`Open ${entry.name} details`}
      onClick={(e) => handleSelectAsset('nft', entry.contractAddress, entry.tokenId, e)}
      onKeyDown={(e) => activateRowFromKeyboard(e, () => handleSelectAsset('nft', entry.contractAddress, entry.tokenId))}
    >
      {renderIcon(
        displayIcon,
        entry.name || entry.symbol || 'N',
        resolved === undefined || resolved?.scheme === 'loading',
      )}
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
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => onToggle(sectionKey)}
        onKeyDown={(e) => activateRowFromKeyboard(e, () => onToggle(sectionKey))}
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
  renderIcon: (icon: ResolvedIcon | undefined, fallback: string, isLoading?: boolean) => React.ReactNode;
}) {
  const { icon: collIcon, isLoading: isCollectionIconLoading } = useLsp8CollectionImage({
    collectionAddress: coll.id,
    collectionIcon: coll.collectionIcon,
  });
  return (
    <div
      className="list-item"
      style={{ ...styles.item, fontWeight: 600 }}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-label={`Toggle ${coll.name}`}
      onClick={() => onToggle(coll.id)}
      onKeyDown={(e) => activateRowFromKeyboard(e, () => onToggle(coll.id))}
    >
      {renderIcon(collIcon, coll.symbol || coll.name || 'C', isCollectionIconLoading)}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{coll.name}</span>
        <span style={styles.itemSymbol}>{coll.count} NFTs</span>
      </div>
      <span style={{ ...styles.expandIcon, transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
    </div>
  );
}

// ─── AssetListSkeleton ───────────────────────────────────────
// ローディング中に行形状のスケルトンを出し、
// 「No tokens found」フラッシュとデータ到着時のレイアウトジャンプを防ぐ。
function AssetListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={styles.item}>
          <div style={styles.itemIconPending}><ImagePending /></div>
          <div style={styles.itemInfo}>
            <div className="skim" style={{ width: 110, height: 13, borderRadius: 4 }} />
            <div className="skim" style={{ width: 64, height: 11, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </>
  );
}

// ─── NftList ─────────────────────────────────────────────────
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
    <div className="uv-scroll" style={styles.list}>
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
  //
  // include はリスト表示に必要なフィールドのみ（Phase 2 性能改善）。
  // description/links/attributes 等のポップアップ専用メタデータは、
  // useInfinite* の全件フェッチには含めない（ホェール地址で数MBになるため）。
  // ポップアップは選択時に lsp-indexer useNft / Envio Asset クエリで
  // 必要な分だけ個別取得する。

  const fetchAddress = shouldFetch && targetAddress ? targetAddress.toLowerCase() : undefined;

  const {
    ownedAssets, hasNextPage: hasMoreAssets, fetchNextPage: fetchMoreAssets,
    isFetchingNextPage: loadingMoreAssets,
    isLoading: isLoadingAssets,
  } = useInfiniteOwnedAssets({
    filter: { holderAddress: fetchAddress },
    include: { balance: true, digitalAsset: { name: true, symbol: true, tokenType: true, decimals: true, icons: true, images: true } },
    pageSize: 500,
  });

  const {
    ownedTokens, hasNextPage: hasMoreTokens, fetchNextPage: fetchMoreTokens,
    isFetchingNextPage: loadingMoreTokens,
    isLoading: isLoadingTokens,
  } = useInfiniteOwnedTokens({
    filter: { holderAddress: fetchAddress },
    include: { digitalAsset: { name: true, symbol: true, tokenType: true, icons: true }, nft: { formattedTokenId: true, name: true, icons: true, images: true } },
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
    let cancelled = false;
    getRpcProvider().getBalance(targetAddress).then(b => {
      if (!cancelled) setLyxBalance(ethers.formatEther(b));
    }).catch(() => {});
    return () => { cancelled = true; };
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
            <NftChildItem
              entry={row.child}
              collectionFallbackIcon={row.child.collectionFallbackIcon}
              handleSelectAsset={handleSelectAsset}
            />
        );
      case 'lsp7-single':
        return (
            <Lsp7SingleNftListItem item={row.item} onSelect={handleSelectAsset} />
        );
    }
  }, [expandedSections, toggleSection, toggleCollection, handleSelectAsset]);

  // NftVirtualList is defined at module level (below) to prevent
  // useVirtualizer from resetting on every AssetList re-render.

  // ─── Render ──────────────────────────────────────────────

  const showPlaceholder = !targetAddress;

  const renderTokenList = (items: TokenItem[]) => (
    <div className="uv-scroll" style={styles.list}>
      {isLoadingAssets ? (
        <AssetListSkeleton />
      ) : items.length === 0 ? <p style={styles.empty}>No tokens found</p> : items.map((item) => {
        if (item.type === 'LYX') {
          return (
            <div
              key={item.id}
              className="list-item"
              style={styles.item}
              role="button"
              tabIndex={0}
              aria-label="Open LYX details"
              onClick={(e) => handleSelectAsset('token' as const, item.contractAddress, undefined, e)}
              onKeyDown={(e) => activateRowFromKeyboard(e, () => handleSelectAsset('token', item.contractAddress))}
            >
              {renderIcon(undefined, 'LYX')}
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

  const isNativeLyx    = selectedAsset?.type === 'token' && selectedAsset.address === '';
  const isLsp8Popup    = selectedAsset?.type === 'nft' && !!selectedAsset?.formattedTokenId;
  const isTokenPopup   = selectedAsset?.type === 'token' && !isNativeLyx;
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
    if (isNativeLyx) return { url: null, scheme: 'none' };
    const activeResolved = isLsp8Popup ? popupLsp8Image
      : isTokenPopup   ? popupTokenImage
      : isLsp7NftPopup ? popupLsp7NftImage
      : undefined;
    if (activeResolved === undefined) return { url: null, scheme: 'loading' };
    if (activeResolved.url) return { url: activeResolved.url, scheme: activeResolved.scheme };
    return { url: null, scheme: 'none' };
  }, [isNativeLyx, isLsp8Popup, isTokenPopup, isLsp7NftPopup, popupLsp8Image, popupTokenImage, popupLsp7NftImage]);

  // Image diagnostics are always available and collapsed by default.
  const debugEnabled = isDebugEnabled();
  const popupDebugSteps = useMemo((): TraceStep[] | undefined => {
    if (!debugEnabled) return undefined;
    if (isNativeLyx) {
      return [
        traceSkip('1. native asset metadata', 'LYX has no contract image metadata'),
        traceMiss('final: no image URL', 'native asset placeholder'),
      ];
    }
    const activeResolved = isLsp8Popup ? popupLsp8Image
      : isTokenPopup   ? popupTokenImage
      : isLsp7NftPopup ? popupLsp7NftImage
      : undefined;
    if (!activeResolved) return [traceWait('image source resolution')];
    return activeResolved.trace ?? [traceWait('image resolution trace')];
  }, [debugEnabled, isNativeLyx, isLsp8Popup, isTokenPopup, isLsp7NftPopup, popupLsp8Image, popupTokenImage, popupLsp7NftImage]);

  // useNft for popup text metadata (name, description, links, attributes)
  // Image resolution is handled separately by useLsp8ChildImage above.
  const { nft: popupNftData, isLoading: popupNftLoading } = useNft(
    isLsp8Popup && popupNftAddr && popupNftTid
      ? { address: popupNftAddr.toLowerCase(), formattedTokenId: popupNftTid,
          include: { name: true, description: true, links: true, attributes: true } }
      : ({ address: '', formattedTokenId: '' } as any)
  );

  const popupDa = selectedOwnedData?.digitalAsset;
  // On-demand metadata (description/links/attributes/supply) — fetched per
  // selection instead of included in the whole-list query (Phase 2).
  const popupMeta = usePopupAssetMeta(isNativeLyx ? null : selectedAsset?.address ?? null);
  const popupDisplayName = isNativeLyx
    ? 'LYX'
    : isLsp8Popup
      ? ((popupNftData as any)?.name || (selectedOwnedData as any)?.nft?.name || popupMeta?.name || popupDa?.name || 'Unknown')
      : (popupMeta?.name || popupDa?.name || 'Unknown');
  const popupDisplaySymbol = isNativeLyx
    ? 'LUKSO native token'
    : isLsp8Popup
      ? `#${(popupNftData as any)?.formattedTokenId || (selectedOwnedData as any)?.nft?.formattedTokenId || selectedAsset?.formattedTokenId || '?'}`
      : (popupMeta?.symbol || popupDa?.symbol || '');
  const popupDesc = isNativeLyx
    ? 'Native currency of the LUKSO network.'
    : isLsp8Popup
      ? ((popupNftData as any)?.description || (selectedOwnedData as any)?.nft?.description)
      : (popupMeta?.description ?? (popupDa as any)?.description ?? null);
  const popupLinks = !isLsp8Popup
    ? (popupMeta?.links.length ? popupMeta.links : ((popupDa as any)?.links || []))
    : (((popupNftData as any)?.links || (selectedOwnedData as any)?.nft?.links) || []);
  const popupAttrs = !isLsp8Popup
    ? (popupMeta?.attributes.length ? popupMeta.attributes : ((popupDa as any)?.attributes || []))
    : (((popupNftData as any)?.attributes || (selectedOwnedData as any)?.nft?.attributes) || []);

  // ── Assemble Popup props ─────────────────────────────────

  const popupStats = useMemo((): { label: string; value: string }[] => {
    if (isNativeLyx) {
      return [{ label: 'Balance', value: `${parseFloat(lyxBalance || '0').toFixed(4)} LYX` }];
    }
    if (!selectedOwnedData) return [];
    const da = popupDa as any;
    const totalSupply = popupMeta?.totalSupply ?? da?.totalSupply;
    const holderCount = da?.holderCount;
    const decimals = popupMeta?.decimals ?? da?.decimals ?? null;
    if (isTokenPopup) return [
      { label: 'Supply',   value: formatBigInt(totalSupply, decimals) },
      { label: 'Holders',  value: holderCount != null ? Number(holderCount).toLocaleString() : '-' },
      { label: 'Balance',  value: formatBalance((selectedOwnedData as any)?.balance ?? null, decimals) },
      { label: 'Decimals', value: decimals != null ? String(decimals) : '-' },
    ];
    if (isLsp7NftPopup) return [
      { label: 'Supply',   value: formatBigInt(popupMeta?.totalSupply ?? totalSupply, 0) },
      { label: 'Holders',  value: holderCount != null ? Number(holderCount).toLocaleString() : '-' },
      { label: 'Balance',  value: formatBalance((selectedOwnedData as any)?.balance ?? null, 0) },
      { label: 'Decimals', value: decimals != null ? String(decimals) : '-' },
    ];
    return [];
  }, [isNativeLyx, lyxBalance, isTokenPopup, isLsp7NftPopup, selectedOwnedData, popupDa, popupMeta]);

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
      {showPlaceholder && <p style={styles.empty}>No profile connected</p>}
      {targetAddress && (
        <div style={styles.cardBody}>
          <div style={styles.toolbar}>
            <div style={styles.segGroup}>
              <button style={{ ...styles.seg, ...(activeTab === 'tokens' ? styles.segActive : {}) }} onClick={() => setActiveTab('tokens')}>
                <span style={styles.tabCount}>{hasMoreAssets ? `${tokenItems.length}+` : tokenItems.length}</span> tokens
              </button>
              <button style={{ ...styles.seg, ...(activeTab === 'nfts' ? styles.segActive : {}) }} onClick={() => setActiveTab('nfts')}>
                <span style={styles.tabCount}>{(nftTree as NftCollEntry[]).reduce((s, i) => s + i.count, 0) + lsp7Nfts.length}</span> NFTs
              </button>
            </div>
            <input
              type="text"
              placeholder="Search holdings"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={styles.searchInput}
            />
            <div style={{ ...styles.filterGroup, visibility: activeTab === 'nfts' ? 'visible' : 'hidden' }}>
              {(['all', 'lsp8', 'lsp7'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => handleNftFilterChange(f)}
                  style={{
                    ...styles.filterBtn,
                    color: nftFilter === f ? 'var(--ink)' : 'var(--mute)',
                  }}
                >
                  {f === 'all' ? 'All' : f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {/* リスト領域 — flex:1 で残余スペースを占有 */}
          <div style={styles.listArea}>
            <div style={{ display: activeTab === 'tokens' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              {renderTokenList(displayedTokenItems)}
            </div>
            <div style={{ display: activeTab === 'nfts' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: '60px' }}>
              {!targetAddress ? (
                <p style={styles.empty}>No profile connected</p>
              ) : isLoadingTokens ? (
                <div className="uv-scroll" style={styles.list}>
                  <AssetListSkeleton />
                </div>
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
      {selectedAsset && (selectedOwnedData || isNativeLyx) && (
        <Popup
          onClose={handleClosePopup}
          image={popupImage}
          placeholderInitials={(popupDisplayName || popupDisplaySymbol || 'A').charAt(0)}
          name={popupDisplayName === 'Unknown' && (isLsp8Popup ? popupNftLoading : popupMeta === undefined) ? undefined : popupDisplayName}
          isLoading={isNativeLyx ? false : isLsp8Popup ? popupNftLoading : popupMeta === undefined}
          subLabel={popupDisplaySymbol}
          description={popupDesc}
          stats={popupStats}
          links={popupNormalizedLinks}
          attributes={popupAttrs}
          externalUrl={popupExternalUrl}
          debugSteps={popupDebugSteps}
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
    padding: '8px 16px 0',
    background: 'transparent',
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
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
    flexShrink: 0,
    minHeight: 28,
  },
  segGroup: {
    display: 'flex',
    gap: 12,
    flex: '0 0 168px',
    minWidth: 168,
  },
  seg: {
    flex: '0 0 auto',
    padding: '0 0 2px',
    border: 'none',
    borderBottom: '2px solid transparent',
    background: 'transparent',
    color: 'var(--mute)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  segActive: {
    color: 'var(--ink)',
    borderBottomColor: 'var(--accent)',
  },
  tabCount: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  filterGroup: {
    display: 'flex',
    gap: 6,
    flex: '0 0 92px',
    justifyContent: 'flex-end',
  },
  filterBtn: {
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: '4px 0',
    border: 'none',
    borderBottom: '1px solid var(--line)',
    borderRadius: 0,
    fontSize: 13,
    outline: 'none',
    background: 'transparent',
    color: 'var(--ink)',
  },
  list: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--list-item-gap)',
    overflowY: 'auto',         // gutter は html の scrollbar-gutter:stable で確保
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
    background: 'var(--accent-soft)',
  },
  itemIconPending: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1rem',
    overflow: 'hidden',
    flexShrink: 0,
    background: 'var(--color-state-resolving)',
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
  iconInitial: { fontSize: 10, fontWeight: 700, color: 'var(--accent)', letterSpacing: 0 },
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
};
