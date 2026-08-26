'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useProfile } from '@lsp-indexer/react';
import { useLsp26Counts } from '@/lib/useLsp26Counts';
import { useLsp26Follows } from '@/lib/useLsp26Follows';
import { toGatewayUrl, shortenAddress } from '@/lib/utils';
import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { ErrorImage } from '@/components/ErrorImage';
import { traceHit, traceMiss, traceWait, isDebugEnabled, type TraceStep } from '@/lib/debug-trace';
import {
  useResolvedProfileImage,
  subscribeProfileCache,
  fetchProfileCache,
  setProfileCachePopupOpen as _setSocialPopupOpen,
  resolveFromSources,
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

// ─── ProfileListItem ───────────────────────────────────────
// List row component. Delegates image resolution to useProfileImage.
// Defined at module level to prevent re-mount on parent re-render.
//
// 相互フォローの表現: 🤝 を名前の後ろに置く。
// 名前と別要素にすることで、長い名前の ellipsis に巻き込まれない。

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
    <div
      className="list-item"
      style={styles.item}
      onClick={() => onSelect(address)}
      title={isMutual ? 'Mutual follow' : undefined}
    >
      {imageUrl ? (
        <ErrorImage src={imageUrl} style={styles.itemAvatar} fallback={<div style={styles.itemAvatarPlaceholder} />} />
      ) : (
        <div style={styles.itemAvatarPlaceholder} />
      )}
      <div style={styles.itemInfo}>
        <div style={styles.itemNameRow}>
          <span style={styles.itemName} title={name}>{name}</span>
          {isMutual && <span style={styles.mutualMark}>🤝</span>}
        </div>
        <span style={styles.itemAddress} title={address}>{shortenAddress(address)}</span>
      </div>
      <span style={{ fontSize: '1.2rem', color: 'var(--color-border-muted)', flexShrink: 0 }}>›</span>
    </div>
  );
});

// ─── ListSkeleton ────────────────────────────────────────────
// ローディング中に行形状のスケルトンを表示し、
// 「No ... found」のフラッシュとデータ到着時のレイアウトジャンプを防ぐ。
function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="uv-scroll" style={styles.list}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={styles.item}>
          <div className="skim" style={styles.itemAvatarPlaceholder} />
          <div style={styles.itemInfo}>
            <div className="skim" style={{ width: 120, height: 13, borderRadius: 4 }} />
            <div className="skim" style={{ width: 76, height: 10, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

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
  isLoading,
}: {
  rows: ProfileRow[];
  onSelect: (addr: string) => void;
  emptyLabel: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoading?: boolean;
  listRef?: React.RefObject<HTMLDivElement | null>;  // 後方互換のため残す
}) {
  // ローディング中は「No ... found」ではなく行スケルトンを出し、
  // データ到着時のレイアウトジャンプを防ぐ
  if (isLoading) return <ListSkeleton />;
  if (rows.length === 0) return <p style={styles.empty}>{emptyLabel}</p>;

  return (
    <>
      <div className="uv-scroll" style={styles.list}>
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

  // Shared resolution chain — identical to list rows (single source of truth)
  const resolved = resolveFromSources({
    indexerImageUrl: indexerProfileImageUrl,
    indexerBackgroundImageUrl,
    indexerAvatarUrl,
    cacheSettled: isCacheSettled,
    cached,
  });
  const isStillLoading = isLoading || resolved.scheme === 'loading';
  const resolvedProfileImageUrl = resolved.profileImageUrl;
  const resolvedBackgroundImageUrl = resolved.backgroundImageUrl;
  const imageScheme = isStillLoading ? 'loading' : resolved.scheme;

  // Debug panel: shown always in dev, opt-in in prod via ?debug=1.
  const debugEnabled = isDebugEnabled();
  const debugSteps = useMemo((): TraceStep[] | undefined => {
    if (!debugEnabled) return undefined;
    if (isStillLoading) {
      return [
        indexerProfileImageUrl ? traceHit('1. useProfile.profileImage', indexerProfileImageUrl) : traceMiss('1. useProfile.profileImage', '(none)'),
        indexerBackgroundImageUrl ? traceHit('1b. useProfile.backgroundImage', indexerBackgroundImageUrl) : traceMiss('1b. useProfile.backgroundImage', '(none)'),
        traceWait('2. erc725.profileImage / backgroundImage'),
        indexerAvatarUrl ? traceHit('3. useProfile.avatar', indexerAvatarUrl) : traceMiss('3. useProfile.avatar', '(none)'),
      ];
    }
    return [
      indexerProfileImageUrl ? traceHit('1. useProfile.profileImage', indexerProfileImageUrl) : traceMiss('1. useProfile.profileImage', '(none)'),
      indexerBackgroundImageUrl ? traceHit('1b. useProfile.backgroundImage', indexerBackgroundImageUrl) : traceMiss('1b. useProfile.backgroundImage', '(none)'),
      !isCacheSettled
        ? traceWait('2. erc725.profileImage / backgroundImage')
        : cached?.profileImageUrl || cached?.backgroundImageUrl
          ? traceHit('2. erc725.profileImage / backgroundImage',
              cached.profileImageUrl ?? cached.backgroundImageUrl ?? undefined)
          : traceMiss('2. erc725.profileImage / backgroundImage', 'settled (null)'),
      indexerAvatarUrl ? traceHit('3. useProfile.avatar', indexerAvatarUrl) : traceMiss('3. useProfile.avatar', '(none)'),
      resolved.scheme !== 'none'
        ? traceHit(`final: ${resolved.scheme}`, resolvedProfileImageUrl ?? undefined)
        : traceMiss('final: no image'),
    ];
  }, [debugEnabled, isStillLoading, indexerProfileImageUrl, indexerBackgroundImageUrl,
      indexerAvatarUrl, isCacheSettled, cached, resolved]);

  if (process.env.NODE_ENV === 'development') {
    console.debug('[ProfilePopup]', key, {
      indexer: { profileImage: indexerProfileImageUrl, backgroundImage: indexerBackgroundImageUrl, avatar: indexerAvatarUrl },
      erc725: cached,
      scheme: imageScheme,
    });
  }

  const stats = [
    { label: 'Following', value: String(lsp26.followingCount || '-') },
    { label: 'Followers', value: String(lsp26.followerCount || '-') },
  ];

  const links: PopupLink[] = (profile?.links ?? []).map((l: any) => ({ title: l.title, url: l.url }));

  return (
    <Popup
      onClose={onClose}
      image={{ url: isStillLoading ? null : resolvedProfileImageUrl, scheme: imageScheme }}
      backgroundImage={resolvedBackgroundImageUrl ?? undefined}
      useBannerLayout={true}
      name={profile?.name || initialName || undefined}
      isLoading={isLoading}
      subLabel={address}
      description={profile?.description ?? undefined}
      tags={profile?.tags ?? undefined}
      stats={stats}
      links={links}
      externalUrl={{ label: 'Profile', url: `https://universaleverything.io/${address}` }}
      onView={onView ? () => { onView(address); onClose(); } : undefined}
      debugSteps={debugSteps}
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
      {showPlaceholder && <p style={styles.empty}>No profile connected</p>}

      {targetAddress && (
        <div style={styles.cardBody}>
          <div style={styles.toolbar}>
            <div style={styles.segGroup}>
              <button onClick={() => setActiveTab('following')} style={{ ...styles.seg, ...(activeTab === 'following' ? styles.segActive : {}) }}>
                <span style={styles.tabCount}>{followingCount || 0}</span> following
              </button>
              <button onClick={() => setActiveTab('followers')} style={{ ...styles.seg, ...(activeTab === 'followers' ? styles.segActive : {}) }}>
                <span style={styles.tabCount}>{followerCount || 0}</span> followers
              </button>
            </div>
            <input
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={styles.searchInput}
            />
          </div>

          {/* 各タブのリスト */}
          <div style={styles.listArea}>
            <div style={{ display: activeTab === 'following' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <ProfileVirtualList
                rows={displayedFollowingRows}
                onSelect={handleSelectProfile}
                emptyLabel="No following found"
                hasMore={displayLimitFollowing < followingRows.length}
                onLoadMore={() => setDisplayLimitFollowing(n => n + DISPLAY_PAGE)}
                isLoading={isLoadingFollows}
              />
            </div>
            <div style={{ display: activeTab === 'followers' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
              <ProfileVirtualList
                rows={displayedFollowerRows}
                onSelect={handleSelectProfile}
                emptyLabel="No followers found"
                hasMore={displayLimitFollowers < followerRows.length}
                onLoadMore={() => setDisplayLimitFollowers(n => n + DISPLAY_PAGE)}
                isLoading={isLoadingFollows}
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
    padding: '8px 16px 0',
    background: 'transparent',
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
    flex: '0 0 196px',
    minWidth: 196,
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
    overflowY: 'auto',
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
    background: 'var(--color-state-resolving)',
    border: '1px solid var(--color-state-empty)',
    flexShrink: 0,
  },
  itemInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  // 名前行: 名前 + 🤝（mutual のみ）。別要素なので長い名前の
  // ellipsis に絵文字が巻き込まれない。
  itemNameRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 'var(--space-1)',
    minWidth: 0,
  },
  mutualMark: {
    flexShrink: 0,
    fontSize: 13,
    lineHeight: 1,
  },
  itemName: {
    fontSize: 'var(--text-md)',
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    lineHeight: 1.3,
  },
  itemAddress: {
    fontSize: 'var(--text-xs)',
    color: 'var(--color-text-faint)',
    fontFamily: 'var(--font-stack-mono)',
    fontVariantNumeric: 'tabular-nums',
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
};
