'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useInfiniteFollows, useFollowCount, useProfile } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useState, useMemo, useEffect, useRef, useCallback, memo } from 'react';
import { Popup } from '@/components/Popup';
import type { PopupLink } from '@/components/Popup';
import { useVirtualizer } from '@tanstack/react-virtual';
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
    <div style={styles.item} onClick={() => onSelect(address)}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#edf2f7'; (e.currentTarget as HTMLElement).style.cursor = 'pointer'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#f7fafc'; }}>
      {imageUrl ? (
        <img src={imageUrl} alt="" style={styles.itemAvatar}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      ) : (
        <div style={styles.itemAvatarPlaceholder}>{name.charAt(0).toUpperCase()}</div>
      )}
      <div style={styles.itemInfo}>
        <span style={styles.itemName}>{name}{isMutual && ' 🤝'}</span>
        <span style={styles.itemAddress}>{address}</span>
      </div>
      <span style={{ fontSize: '1.2rem', color: '#cbd5e0', flexShrink: 0 }}>›</span>
    </div>
  );
});

// ─── ProfileVirtualList ────────────────────────────────────
// Virtualizes the profile list — only visible rows are mounted.
// Defined at module level so useVirtualizer is stable across re-renders.

interface ProfileRow {
  addr: string;
  name: string;
  indexerImageUrl?: string;
  isMutual: boolean;
}

const ProfileVirtualList = memo(function ProfileVirtualList({
  rows,
  listRef,
  onSelect,
  emptyLabel,
}: {
  rows: ProfileRow[];
  listRef: React.RefObject<HTMLDivElement | null>;
  onSelect: (addr: string) => void;
  emptyLabel: string;
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 44,
    overscan: 5,
  });

  if (rows.length === 0) return <p style={styles.empty}>{emptyLabel}</p>;

  return (
    <div style={styles.list} ref={listRef}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => {
          const row = rows[virtualItem.index];
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <ProfileListItem
                name={row.name}
                address={row.addr}
                indexerImageUrl={row.indexerImageUrl}
                isMutual={row.isMutual}
                onSelect={onSelect}
              />
            </div>
          );
        })}
      </div>
    </div>
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

export function SocialGraph({ address }: SocialGraphProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);

  const followingListRef = useRef<HTMLDivElement>(null);
  const followersListRef = useRef<HTMLDivElement>(null);

  const { followerCount, followingCount } = useFollowCount({
    address: targetAddress?.toLowerCase() || '',
  });

  const {
    follows: followers,
    hasNextPage: hasMoreFollowers,
    fetchNextPage: fetchMoreFollowers,
    isFetchingNextPage: loadingMoreFollowers,
  } = useInfiniteFollows({
    filter: { followedAddress: targetAddress?.toLowerCase() || '' },
    include: { followerProfile: { name: true, profileImage: true } },
    pageSize: 500,
  });

  const {
    follows: following,
    hasNextPage: hasMoreFollowing,
    fetchNextPage: fetchMoreFollowing,
    isFetchingNextPage: loadingMoreFollowing,
  } = useInfiniteFollows({
    filter: { followerAddress: targetAddress?.toLowerCase() || '' },
    include: { followedProfile: { name: true, profileImage: true } },
    pageSize: 500,
  });

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

  // Prepare row data for virtualizer
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

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>🤝 Social Graph</h3>

      {showPlaceholder && <p style={styles.empty}>🔌</p>}

      {targetAddress && (
        <div style={{ animation: 'contentReveal 0.25s ease' }}>
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

          {/* Separate containers preserve scroll position independently */}
          <div style={{ position: 'relative' }}>
            <div style={{ display: activeTab === 'following' ? 'block' : 'none' }}>
              <ProfileVirtualList rows={followingRows} listRef={followingListRef} onSelect={handleSelectProfile} emptyLabel="No following found" />
            </div>
            <div style={{ display: activeTab === 'followers' ? 'block' : 'none' }}>
              <ProfileVirtualList rows={followerRows} listRef={followersListRef} onSelect={handleSelectProfile} emptyLabel="No followers found" />
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
  card: { padding: '8px', background: 'rgba(255, 255, 255, 0.95)', borderRadius: '16px', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)', minHeight: '600px' },
  title: { margin: '0 0 8px 0', fontSize: '1rem', fontWeight: '700', color: '#1a202c' },
  tabs: { display: 'flex', gap: '8px', marginBottom: '8px' },
  tab: { flex: 1, padding: '10px 12px', border: 'none', borderRadius: '10px', background: '#f7fafc', color: '#718096', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', transition: 'all 0.25s ease', minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' },
  tabActive: { background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white' },
  tabCount: { fontWeight: '800' },
  searchInput: { width: '100%', padding: '8px 12px', marginBottom: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '16px', outline: 'none', boxSizing: 'border-box' as const },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '450px', overflowY: 'auto', minHeight: '60px' },
  item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: '#f7fafc', borderRadius: '8px', transition: 'background 0.15s ease' },
  itemAvatar: { width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 },
  itemAvatarPlaceholder: { width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 'bold', color: '#ffffff', flexShrink: 0 },
  itemInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  itemName: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-word', lineHeight: 1.3 },
  itemAddress: { fontSize: '0.7rem', color: '#718096', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { margin: 0, padding: '16px', textAlign: 'center', color: '#a0aec0', fontSize: '0.85rem' },
};
