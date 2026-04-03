'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useInfiniteFollows, useFollowCount } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useState, useMemo, useEffect, useRef } from 'react';

interface SocialGraphProps {
  address?: `0x${string}`;
}

const getProfileImage = (f: { followerProfile?: { profileImage?: { url: string }[] | null } | null; followedProfile?: { profileImage?: { url: string }[] | null } | null }, direction: 'follower' | 'followed'): string | undefined => {
  const profile = direction === 'follower' ? f.followerProfile : f.followedProfile;
  if (!profile?.profileImage?.[0]?.url) return undefined;
  return toGatewayUrl(profile.profileImage[0].url);
};

const getName = (f: { followerProfile?: { name?: string | null } | null; followedProfile?: { name?: string | null } | null }, direction: 'follower' | 'followed'): string => {
  const profile = direction === 'follower' ? f.followerProfile : f.followedProfile;
  return profile?.name || 'Unknown';
};

const getAddress = (f: { followerAddress: string; followedAddress: string }, direction: 'follower' | 'followed'): string => {
  return direction === 'follower' ? f.followerAddress : f.followedAddress;
};

export function SocialGraph({ address }: SocialGraphProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress = address || displayAddress;
  const [activeTab, setActiveTab] = useState<'following' | 'followers'>('following');
  const [searchQuery, setSearchQuery] = useState('');

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
      const name = getName(f, 'follower');
      const addr = getAddress(f, 'follower');
      return name.toLowerCase().includes(query) || addr.toLowerCase().includes(query);
    });
  }, [followers, searchQuery]);

  const filteredFollowing = useMemo(() => {
    if (!searchQuery) return following || [];
    const query = searchQuery.toLowerCase();
    return (following || []).filter(f => {
      const name = getName(f, 'followed');
      const addr = getAddress(f, 'followed');
      return name.toLowerCase().includes(query) || addr.toLowerCase().includes(query);
    });
  }, [following, searchQuery]);

  const showPlaceholder = !targetAddress;

  const renderList = (items: any, activeTab: 'following' | 'followers', listRef: React.RefObject<HTMLDivElement | null>) => (
    <div style={styles.list} ref={listRef}>
      {items.length === 0 ? (
        <p style={styles.empty}>No {activeTab} found</p>
      ) : (
        items.map((item: any) => {
          const direction = activeTab === 'followers' ? 'follower' : 'followed';
          const name = getName(item, direction);
          const addr = getAddress(item, direction);
          const imageUrl = getProfileImage(item, direction);
          return (
            <div key={addr} style={styles.item}>
              {imageUrl ? (
                <img src={imageUrl} alt="" style={styles.itemAvatar} />
              ) : (
                <div style={styles.itemAvatarPlaceholder}>{name.charAt(0).toUpperCase()}</div>
              )}
              <div style={styles.itemInfo}>
                <span style={styles.itemName}>{name}{mutualSet.has(addr) && ' 🤝'}</span>
                <span style={styles.itemAddress}>{addr}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

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
              {renderList(filteredFollowing, 'following', followingListRef)}
            </div>
            <div style={{ display: activeTab === 'followers' ? 'block' : 'none' }}>
              {renderList(filteredFollowers, 'followers', followersListRef)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  card: { padding: '8px', background: 'rgba(255, 255, 255, 0.95)', borderRadius: '16px', boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)' },
  title: { margin: '0 0 8px 0', fontSize: '1rem', fontWeight: '700', color: '#1a202c' },
  tabs: { display: 'flex', gap: '8px', marginBottom: '8px' },
  tab: { flex: 1, padding: '10px 12px', border: 'none', borderRadius: '10px', background: '#f7fafc', color: '#718096', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer', transition: 'all 0.25s ease', minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' },
  tabActive: { background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: 'white' },
  tabCount: { fontWeight: '800' },
  searchInput: { width: '100%', padding: '8px 12px', marginBottom: '8px', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '16px', outline: 'none', boxSizing: 'border-box' as const },
  list: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '450px', overflowY: 'auto', minHeight: '60px' },
  item: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: '#f7fafc', borderRadius: '8px' },
  itemAvatar: { width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', flexShrink: 0 },
  itemAvatarPlaceholder: { width: '28px', height: '28px', borderRadius: '50%', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 'bold', color: '#ffffff', flexShrink: 0 },
  itemInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  itemName: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-word', lineHeight: 1.3 },
  itemAddress: { fontSize: '0.7rem', color: '#718096', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  empty: { margin: 0, padding: '16px', textAlign: 'center', color: '#a0aec0', fontSize: '0.85rem' },
};
