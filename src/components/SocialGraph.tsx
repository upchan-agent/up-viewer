'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useInfiniteFollows, useFollowCount, useProfile } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';

// ─── TimeoutImage ────────────────────────────────────────

const SOCIAL_IMG_TIMEOUT_MS = 10000;

function TimeoutImage({ src, alt, style, fallback, }: {
  src: string; alt?: string; style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    setFailed(false);
    loadedRef.current = false;
    const timer = setTimeout(() => {
      if (!loadedRef.current) setFailed(true);
    }, SOCIAL_IMG_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [src]);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <img
      src={src}
      alt={alt ?? ''}
      style={style}
      onLoad={() => { loadedRef.current = true; }}
      onError={() => setFailed(true)}
    />
  );
}
import {
  subscribeProfileCache,
  fetchProfileCache,
  setProfileCachePopupOpen as _setSocialPopupOpen,
  useResolvedProfileImage,
  getProfileCacheEntry,
  isProfileCacheSettled,
} from '@/lib/profile-image-cache';

interface SocialGraphProps {
  address?: `0x${string}`;
  active?: boolean;
}

// ─── ProfileListItem ───────────────────────────────────────
// List row component. Delegates image resolution to useProfileImage.
// Defined at module level to prevent re-mount on parent re-render.

const ProfileListItem = memo(function ProfileListItem({
  name,
  address,
  indexerImageUrl,
  isMutual,
  onSelect,
}: {
  name: string;
  address: string;
  indexerImageUrl?: string;
  isMutual: boolean;
  onSelect: (address: string) => void;
}) {
  const resolved = useResolvedProfileImage({ address, indexerImageUrl });
  const imageUrl = resolved?.profileImageUrl || undefined;

  const initialsFallback = <div style={styles.itemAvatarPlaceholder}>{name.charAt(0).toUpperCase()}</div>;

  return (
    <div className="list-item" style={styles.item} onClick={() => onSelect(address)}>
      {imageUrl ? (
        <TimeoutImage src={imageUrl} style={styles.itemAvatar} fallback={initialsFallback} />
      ) : (
        initialsFallback
      )}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{name}{isMutual && ' 🤝'}</span>
        <span style={styles.itemAddress}>{address}</span>
      </div>
      <span style={{ fontSize: '1.2rem', color: 'var(--color-border-muted)', flexShrink: 0 }}>›</span>
    </div>
  );
});

// ─── ProfileVirtualList ────────────────────────────────────
// ─── ProfileList ────────────────────────────────────────────
// displayLimit で件数が制御されるため仮想化は不要。
// 通常の overflowY:auto リストにすることで、スクロールバーが
// 実測値に基づいて正確に表示され、縮小しない。

interface ProfileRow {
  addr: string;
  name: string;
  indexerImageUrl?: string;
  isMutual: boolean;
}

const ProfileVirtualList = memo(function ProfileVirtualList({
  rows,
  onSelect,
  emptyLabel,
  hasMore,
  onLoadMore,
}: {
  rows: ProfileRow[];
  onSelect: (addr: string) => void;
  emptyLabel: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  listRef?: React.RefObject<HTMLDivElement | null>;  // 後方互換のため残す
}) {
  if (rows.length === 0) return <p style={styles.empty}>{emptyLabel}</p>;

  return (
    <>
      <div style={styles.list}>
        {rows.map(row => (
          <ProfileListItem
            key={row.addr}
            name={row.name}
            address={row.addr}
            indexerImageUrl={row.indexerImageUrl}
            isMutual={row.isMutual}
            onSelect={onSelect}
          />
        ))}
      </div>
      {hasMore && onLoadMore && (
        <div style={styles.showMoreRow}>
          <button style={styles.showMoreButton} onClick={onLoadMore}>
            Load more
          </button>
        </div>
      )}
    </>
  );
});

// ─── ProfilePopupContent ───────────────────────────────────
// Image resolution mirrors useProfileImage:
//   1. useProfile (lsp-indexer) for profileImage/backgroundImage
//   2. _profileCache (erc725) fallback — shared with list items

function ProfilePopupContent({
  address,
  onClose,
}: {
  address: string;
  onClose: () => void;
}) {
  const { profile, isLoading } = useProfile({
    address: address.toLowerCase(),
    include: {
      name: true, description: true, tags: true, links: true,
      profileImage: true, backgroundImage: true, avatar: true,
      followerCount: true, followingCount: true,
    },
  });

  // erc725 fallback state — mirrors useProfileImage pattern
  const [, setTick] = useState(0);
  const key = address.toLowerCase();
  useEffect(() => subscribeProfileCache(key, () => setTick(t => t + 1)), [key]);

  useEffect(() => {
    if (isLoading) return;
    const hasIndexerUrl = profile?.profileImage?.[0]?.url || profile?.backgroundImage?.[0]?.url;
    if (hasIndexerUrl) return;
    fetchProfileCache(key, true); // priority=true — bypasses popup defer gate
  }, [isLoading, key]);

  // Image resolution — indexer first, erc725 fallback
  const indexerProfileImageUrl = toGatewayUrl(profile?.profileImage?.[0]?.url ?? '') ?? undefined;
  const indexerBackgroundImageUrl = toGatewayUrl(profile?.backgroundImage?.[0]?.url ?? '') ?? undefined;
  const indexerAvatarUrl = toGatewayUrl(profile?.avatar?.[0]?.url ?? '') ?? undefined;

  const cached = getProfileCacheEntry(key);
  const isCacheSettled = isProfileCacheSettled(key);
  const hasIndexerImage = !!(indexerProfileImageUrl || indexerBackgroundImageUrl);

  const resolvedProfileImageUrl = indexerProfileImageUrl
    ?? cached?.profileImageUrl
    ?? indexerAvatarUrl
    ?? null;
  const resolvedBackgroundImageUrl = indexerBackgroundImageUrl
    ?? cached?.backgroundImageUrl
    ?? null;

  const isStillLoading = isLoading || (!hasIndexerImage && !isCacheSettled);
  const imageScheme = isStillLoading ? 'loading'
    : indexerProfileImageUrl ? 'useProfile.profileImage'
    : cached?.profileImageUrl ? 'erc725.profileImage'
    : indexerAvatarUrl ? 'useProfile.avatar'
    : 'none';

  const debugText = [
    `[Profile] selected: ${imageScheme}`,
    `1st useProfile.profileImage: ${indexerProfileImageUrl ? '✓ ' + indexerProfileImageUrl : '(none)'}`,
    `1st useProfile.backgroundImage: ${indexerBackgroundImageUrl ? '✓ ' + indexerBackgroundImageUrl : '(none)'}`,
    `2nd erc725.profileImage: ${!isCacheSettled ? '(pending...)' : cached?.profileImageUrl ? '✓ ' + cached.profileImageUrl : '(null)'}`,
    `2nd erc725.backgroundImage: ${!isCacheSettled ? '(pending...)' : cached?.backgroundImageUrl ? '✓ ' + cached.backgroundImageUrl : '(null)'}`,
    `3rd useProfile.avatar: ${indexerAvatarUrl ? '✓ ' + indexerAvatarUrl : '(none)'}`,
    `final profileImage: ${resolvedProfileImageUrl ?? '(null)'}`,
    `final backgroundImage: ${resolvedBackgroundImageUrl ?? '(null)'}`,
  ].join('\n');

  const stats = [
    { label: 'Following', value: String(profile?.followingCount ?? '-') },
    { label: 'Followers', value: String(profile?.followerCount ?? '-') },
  ];

  const links: PopupLink[] = (profile?.links ?? []).map((l: any) => ({ title: l.title, url: l.url }));
  const name = profile?.name || 'Unknown';

  return (
    <Popup
      onClose={onClose}
      image={{ url: isStillLoading ? null : resolvedProfileImageUrl, scheme: imageScheme }}
      backgroundImage={resolvedBackgroundImageUrl ?? undefined}
      useBannerLayout={true}
      placeholderInitial={name.charAt(0).toUpperCase()}
      name={name}
      subLabel={address}
      description={profile?.description ?? undefined}
      tags={profile?.tags ?? undefined}
      stats={stats}
      links={links}
      externalUrl={{ label: 'Profile', url: `https://universaleverything.io/${address}` }}
      debugText={debugText}
    />
  );
}

// ─── SocialGraph ───────────────────────────────────────────

export function SocialGraph({ address, active = true }: SocialGraphProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  // ── hasBeenActive: 一度でもアクティブになったかを記録 ──
  const hasBeenActive = useRef(false);
  if (active) hasBeenActive.current = true;
  const fetchAddress = hasBeenActive.current ? (targetAddress?.toLowerCase() || '') : '';

  // 表示件数制御（AssetList と同じパターン）
  const DISPLAY_PAGE = 200;
  const [displayLimitFollowing, setDisplayLimitFollowing] = useState(DISPLAY_PAGE);
  const [displayLimitFollowers, setDisplayLimitFollowers] = useState(DISPLAY_PAGE);
  useEffect(() => {
    setDisplayLimitFollowing(DISPLAY_PAGE);
    setDisplayLimitFollowers(DISPLAY_PAGE);
  }, [targetAddress]);

  // useFollowCount で総数を取得（表示件数とは独立）
  const { followerCount, followingCount } = useFollowCount({
    address: fetchAddress,
  });

  const {
    follows: followers,
    hasNextPage: hasMoreFollowers,
    fetchNextPage: fetchMoreFollowers,
    isFetchingNextPage: loadingMoreFollowers,
  } = useInfiniteFollows({
    filter: { followedAddress: fetchAddress },
    include: { followerProfile: { name: true, profileImage: true } },
    pageSize: 500,
  });

  const {
    follows: following,
    hasNextPage: hasMoreFollowing,
    fetchNextPage: fetchMoreFollowing,
    isFetchingNextPage: loadingMoreFollowing,
  } = useInfiniteFollows({
    filter: { followerAddress: fetchAddress },
    include: { followedProfile: { name: true, profileImage: true } },
    pageSize: 500,
  });

  // バックグラウンドで全件フェッチ
  useEffect(() => {
    if (hasMoreFollowers && !loadingMoreFollowers) fetchMoreFollowers();
  }, [hasMoreFollowers, loadingMoreFollowers, fetchMoreFollowers]);

  useEffect(() => {
    if (hasMoreFollowing && !loadingMoreFollowing) fetchMoreFollowing();
  }, [hasMoreFollowing, loadingMoreFollowing, fetchMoreFollowing]);

  const followersSet = useMemo(() =>
    new Set((followers || []).map(f => f.followerAddress.toLowerCase())),
    [followers]
  );

  const followingSet = useMemo(() =>
    new Set((following || []).map(f => f.followedAddress.toLowerCase())),
    [following]
  );

  const mutualSet = useMemo(() => {
    const mutuals = new Set<string>();
    for (const addr of followersSet) {
      if (followingSet.has(addr)) mutuals.add(addr);
    }
    return mutuals;
  }, [followersSet, followingSet]);

  const filteredFollowers = useMemo(() => {
    if (!searchQuery) return followers || [];
    const query = searchQuery.toLowerCase();
    return (followers || []).filter(f => {
      const name = f.followerProfile?.name || 'Unknown';
      return name.toLowerCase().includes(query) || f.followerAddress.toLowerCase().includes(query);
    });
  }, [followers, searchQuery]);

  const filteredFollowing = useMemo(() => {
    if (!searchQuery) return following || [];
    const query = searchQuery.toLowerCase();
    return (following || []).filter(f => {
      const name = f.followedProfile?.name || 'Unknown';
      return name.toLowerCase().includes(query) || f.followedAddress.toLowerCase().includes(query);
    });
  }, [following, searchQuery]);

  const handleSelectProfile = useCallback((addr: string) => {
    _setSocialPopupOpen(true);
    setSelectedAddress(addr);
  }, []);

  const handleClosePopup = useCallback(() => {
    _setSocialPopupOpen(false);
    setSelectedAddress(null);
  }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClosePopup(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [handleClosePopup]);

  const showPlaceholder = !targetAddress;

  // Prepare row data for virtualizer（全件 — 検索対象）
  const followingRows = useMemo(() => filteredFollowing.map((item: any) => ({
    addr: item.followedAddress,
    name: item.followedProfile?.name || 'Unknown',
    indexerImageUrl: toGatewayUrl(item.followedProfile?.profileImage?.[0]?.url ?? '') ?? undefined,
    isMutual: mutualSet.has(item.followedAddress.toLowerCase()),
  })), [filteredFollowing, mutualSet]);

  const followerRows = useMemo(() => filteredFollowers.map((item: any) => ({
    addr: item.followerAddress,
    name: item.followerProfile?.name || 'Unknown',
    indexerImageUrl: toGatewayUrl(item.followerProfile?.profileImage?.[0]?.url ?? '') ?? undefined,
    isMutual: mutualSet.has(item.followerAddress.toLowerCase()),
  })), [filteredFollowers, mutualSet]);

  // 表示件数で切り出し（Load more = displayLimit を増やすだけ）
  const displayedFollowingRows = useMemo(
    () => followingRows.slice(0, displayLimitFollowing),
    [followingRows, displayLimitFollowing],
  );
  const displayedFollowerRows = useMemo(
    () => followerRows.slice(0, displayLimitFollowers),
    [followerRows, displayLimitFollowers],
  );

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>🤝 Social Graph</h3>

      {showPlaceholder && <p style={styles.empty}>🔌</p>}

      {targetAddress && (
        <div className="content-reveal" style={styles.cardBody}>
          <div style={styles.tabs}>
            <button onClick={() => setActiveTab('following')} style={{ ...styles.tab, ...(activeTab === 'following' ? styles.tabActive : {}) }}>
              <span style={styles.tabCount}>{followingCount || 0}</span> Following
            </button>
            <button onClick={() => setActiveTab('followers')} style={{ ...styles.tab, ...(activeTab === 'followers' ? styles.tabActive : {}) }}>
              <span style={styles.tabCount}>{followerCount || 0}</span> Followers
            </button>
          </div>

          <input
            type="text"
            placeholder="🔍 Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={styles.searchInput}
          />

          {/* 各タブのリスト */}
          <div style={styles.listArea}>
            <div style={{ display: activeTab === 'following' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <ProfileVirtualList
                rows={displayedFollowingRows}
                onSelect={handleSelectProfile}
                emptyLabel="No following found"
                hasMore={displayLimitFollowing < followingRows.length}
                onLoadMore={() => setDisplayLimitFollowing(n => n + DISPLAY_PAGE)}
              />
            </div>
            <div style={{ display: activeTab === 'followers' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <ProfileVirtualList
                rows={displayedFollowerRows}
                onSelect={handleSelectProfile}
                emptyLabel="No followers found"
                hasMore={displayLimitFollowers < followerRows.length}
                onLoadMore={() => setDisplayLimitFollowers(n => n + DISPLAY_PAGE)}
              />
            </div>
          </div>
        </div>
      )}

      {selectedAddress && (
        <ProfilePopupContent
          address={selectedAddress}
          onClose={handleClosePopup}
        />
      )}
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────

const styles: { [key: string]: React.CSSProperties } = {
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
  cardBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
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
    marginBottom: 'var(--space-2)',
    border: `1px solid var(--color-border-default)`,
    borderRadius: 'var(--radius-md)',
    fontSize: '16px',
    outline: 'none',
    boxSizing: 'border-box' as const,
    flexShrink: 0,
  },
  list: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--list-item-gap)',
    overflowY: 'scroll',
    minHeight: 'var(--list-min-height)',
  },
  // item の background / transition は .list-item CSS クラスで管理
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '0 var(--space-2)',
    borderRadius: 'var(--radius-md)',
    height: 'var(--item-height)',   // AssetList と高さを統一
    overflow: 'hidden',
    boxSizing: 'border-box',
    flexShrink: 0,
  },
  itemAvatar: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    objectFit: 'cover',
    flexShrink: 0,
  },
  itemAvatarPlaceholder: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    background: 'var(--gradient-brand)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--text-xs)',
    fontWeight: 'bold',
    color: 'var(--color-text-white)',
    flexShrink: 0,
  },
  itemInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  itemName: {
    fontSize: 'var(--text-md)',
    fontWeight: '600',
    color: 'var(--color-text-secondary)',
    wordBreak: 'break-word',
    lineHeight: 1.3,
  },
  itemAddress: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-muted)',
    fontFamily: 'monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  empty: {
    margin: 0,
    padding: 'var(--space-4)',
    textAlign: 'center',
    color: 'var(--color-text-faint)',
    fontSize: 'var(--text-md)',
  },
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
