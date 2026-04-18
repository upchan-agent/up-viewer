'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useProfile } from '@lsp-indexer/react';
import { useLsp26Counts } from '@/lib/useLsp26Counts';
import { useLsp26Follows } from '@/lib/useLsp26Follows';
import { toGatewayUrl } from '@/lib/utils';
import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { ErrorImage } from '@/components/ErrorImage';
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
  onViewMode?: (address: string) => void;
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

  return (
    <div className="list-item" style={styles.item} onClick={() => onSelect(address)}>
      {imageUrl ? (
        <ErrorImage src={imageUrl} style={styles.itemAvatar} fallback={<div style={styles.itemAvatarPlaceholder} />} />
      ) : (
        <div style={styles.itemAvatarPlaceholder} />
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
  name: initialName,
  onClose,
  onView,
}: {
  address: string;
  name?: string;
  onClose: () => void;
  onView?: (address: string) => void;
}) {
  const { profile, isLoading } = useProfile({
    address: address.toLowerCase(),
    include: {
      name: true, description: true, tags: true, links: true,
      profileImage: true, backgroundImage: true, avatar: true,
    },
  });

  // LSP26 コントラクトで正確なフォロー数を取得（useProfile の値は不正確）
  const lsp26 = useLsp26Counts(address.toLowerCase());

  // erc725 fallback state — mirrors useProfileImage pattern
  const [, setTick] = useState(0);
  const key = address.toLowerCase();
  useEffect(() => subscribeProfileCache(key, () => setTick(t => t + 1)), [key]);

  useEffect(() => {
    if (isLoading) return;
    // Only skip erc725 when indexer has BOTH images — partial indexer data
    // means we still need erc725 to fill gaps (e.g. profileImage exists but
    // backgroundImage is missing on the indexer).
    const hasBothIndexerUrls = !!(
      profile?.profileImage?.[0]?.url && profile?.backgroundImage?.[0]?.url
    );
    if (hasBothIndexerUrls) return;
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
    { label: 'Following', value: String(lsp26.followingCount || '-') },
    { label: 'Followers', value: String(lsp26.followerCount || '-') },
  ];

  const links: PopupLink[] = (profile?.links ?? []).map((l: any) => ({ title: l.title, url: l.url }));
  const name = profile?.name || initialName || 'Unknown';

  return (
    <Popup
      onClose={onClose}
      image={{ url: isStillLoading ? null : resolvedProfileImageUrl, scheme: imageScheme }}
      backgroundImage={resolvedBackgroundImageUrl ?? undefined}
      useBannerLayout={true}
      name={name}
      isLoading={false}
      subLabel={address}
      description={profile?.description ?? undefined}
      tags={profile?.tags ?? undefined}
      stats={stats}
      links={links}
      externalUrl={{ label: 'Profile', url: `https://universaleverything.io/${address}` }}
      onView={onView ? () => { onView(address); onClose(); } : undefined}
      debugText={debugText}
    />
  );
}

// ─── SocialGraph ───────────────────────────────────────────

export function SocialGraph({ address, active = true, onViewMode }: SocialGraphProps) {
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

  // LSP26 コントラクト直接呼び出しで正確なフォロー数を取得
  const { followerCount, followingCount } = useLsp26Counts(fetchAddress || undefined);

  // LSP26 からアドレス一覧 + lsp-indexer からプロフィールを取得
  const {
    followerAddresses,
    followingAddresses,
    followerProfiles,
    followingProfiles,
    isLoading: isLoadingFollows,
  } = useLsp26Follows(fetchAddress || undefined);

  const followersSet = useMemo(() =>
    new Set(followerAddresses),
    [followerAddresses]
  );

  const followingSet = useMemo(() =>
    new Set(followingAddresses),
    [followingAddresses]
  );

  const mutualSet = useMemo(() => {
    const mutuals = new Set<string>();
    for (const addr of followersSet) {
      if (followingSet.has(addr)) mutuals.add(addr);
    }
    return mutuals;
  }, [followersSet, followingSet]);

  const filteredFollowers = useMemo(() => {
    if (!searchQuery) return followerAddresses;
    const query = searchQuery.toLowerCase();
    return followerAddresses.filter(addr => {
      const name = followerProfiles.get(addr)?.name || 'Unknown';
      return name.toLowerCase().includes(query) || addr.toLowerCase().includes(query);
    });
  }, [followerAddresses, followerProfiles, searchQuery]);

  const filteredFollowing = useMemo(() => {
    if (!searchQuery) return followingAddresses;
    const query = searchQuery.toLowerCase();
    return followingAddresses.filter(addr => {
      const name = followingProfiles.get(addr)?.name || 'Unknown';
      return name.toLowerCase().includes(query) || addr.toLowerCase().includes(query);
    });
  }, [followingAddresses, followingProfiles, searchQuery]);

  const handleSelectProfile = useCallback((addr: string) => {
    _setSocialPopupOpen(true);
    setSelectedAddress(addr);
  }, []);

  const selectedName = useMemo(() => {
    if (!selectedAddress) return undefined;
    const key = selectedAddress.toLowerCase();
    return followingProfiles.get(key)?.name
      ?? followerProfiles.get(key)?.name
      ?? undefined;
  }, [selectedAddress, followingProfiles, followerProfiles]);

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
  const followingRows = useMemo(() => filteredFollowing.map((addr) => {
    const profile = followingProfiles.get(addr);
    return {
      addr,
      name: profile?.name || 'Unknown',
      indexerImageUrl: toGatewayUrl(profile?.profileImage ?? '') ?? undefined,
      isMutual: mutualSet.has(addr),
    };
  }), [filteredFollowing, followingProfiles, mutualSet]);

  const followerRows = useMemo(() => filteredFollowers.map((addr) => {
    const profile = followerProfiles.get(addr);
    return {
      addr,
      name: profile?.name || 'Unknown',
      indexerImageUrl: toGatewayUrl(profile?.profileImage ?? '') ?? undefined,
      isMutual: mutualSet.has(addr),
    };
  }), [filteredFollowers, followerProfiles, mutualSet]);

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
          name={selectedName}
          onClose={handleClosePopup}
          onView={onViewMode}
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
    background: 'var(--color-surface-muted)',
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
