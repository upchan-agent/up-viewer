'use client';

import { Providers } from './providers';
import { ProfileCard } from '@/components/ProfileCard';
import { SocialGraph } from '@/components/SocialGraph';
import { AssetList } from '@/components/AssetList';
import { ActivityList } from '@/components/ActivityList';
import { useState, Suspense, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

type TabType = 'assets' | 'social' | 'activity';

function ViewerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // URL param address
  const urlAddress = searchParams.get('address') as `0x${string}` | null;

  // View mode address (from UI search)
  const viewAddressParam = searchParams.get('view') as `0x${string}` | null;
  const [viewAddress, setViewAddress] = useState<`0x${string}` | null>(viewAddressParam);

  // Active address: view mode > URL param > wallet
  const activeAddress = viewAddress || urlAddress || undefined;
  const isViewMode = !!viewAddress || !!urlAddress;

  // Keep URL synced when view address changes
  useEffect(() => {
    if (viewAddress) {
      router.replace(`?view=${viewAddress}`, { scroll: false });
    }
  }, [viewAddress, router]);

  // Sync viewAddress from URL (e.g. shared link)
  useEffect(() => {
    if (viewAddressParam && viewAddressParam !== viewAddress) {
      setViewAddress(viewAddressParam);
    }
  }, [viewAddressParam]);

  const [activeTab, setActiveTab] = useState<TabType>('assets');
  const [showSearch, setShowSearch] = useState(false);

  const handleSelectAddress = useCallback((addr: `0x${string}`) => {
    setViewAddress(addr);
    setShowSearch(false);
  }, []);

  const handleExitViewMode = useCallback(() => {
    setViewAddress(null);
    router.replace('/', { scroll: false });
  }, [router]);

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleEmoji}>🆙</span>
          <span style={styles.titleText}>Viewer</span>
        </h1>
      </header>

      <div style={styles.content}>
        <ProfileCard
          address={activeAddress}
          isViewMode={isViewMode}
          onExitViewMode={handleExitViewMode}
          onToggleSearch={isViewMode ? undefined : () => setShowSearch(prev => !prev)}
        />

        {showSearch && (
          <div style={{ paddingBottom: '4px' }}>
            {/* Dynamic import to avoid SSR issues */}
            <DynamicProfileSearch
              onSelect={handleSelectAddress}
              onCancel={() => setShowSearch(false)}
            />
          </div>
        )}

        <div style={styles.tabs}>
          <button
            onClick={() => setActiveTab('assets')}
            style={{ ...styles.tab, ...(activeTab === 'assets' ? styles.tabActive : {}) }}
          >
            💎 Assets
          </button>
          <button
            onClick={() => setActiveTab('social')}
            style={{ ...styles.tab, ...(activeTab === 'social' ? styles.tabActive : {}) }}
          >
            🤝 Social
          </button>
          <button
            onClick={() => setActiveTab('activity')}
            style={{ ...styles.tab, ...(activeTab === 'activity' ? styles.tabActive : {}) }}
          >
            ⚡ Activity
          </button>
        </div>

        {activeTab === 'assets' && <AssetList address={activeAddress} />}
        {activeTab === 'social' && <SocialGraph address={activeAddress} />}
        {activeTab === 'activity' && <ActivityList address={activeAddress} />}
      </div>

      <footer style={styles.footer}>
        <span style={styles.footerText}>Made with </span>
        <span style={styles.footerHeart}>❤️</span>
        <span style={styles.footerText}> by </span>
        <a href="https://profile.link/🆙chan@bcA4" target="_blank" rel="noopener noreferrer" style={styles.footerLink}>
          <span style={styles.footerEmoji}>🆙</span>chan
        </a>
        <span style={styles.footerSeparator}>|</span>
        <a href="https://x.com/UPchan_lyx" target="_blank" rel="noopener noreferrer" style={styles.footerLink}>
          <span style={styles.footerX}>𝕏</span>
        </a>
      </footer>
    </div>
  );
}

// Lazy-loaded ProfileSearch to avoid SSR issues
function DynamicProfileSearch(props: { onSelect: (addr: `0x${string}`) => void; onCancel: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [Comp, setComp] = useState<any>(null);

  useEffect(() => {
    import('@/components/ProfileSearch').then(m => setComp(() => m.ProfileSearch));
  }, []);

  if (!Comp) return <div style={{ textAlign: 'center', padding: '12px', color: '#a0aec0', fontSize: '0.8rem' }}>Loading search...</div>;
  return <Comp {...props} />;
}

function ViewerContent() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', color: '#fff' }}>Loading...</div>}>
      <ViewerInner />
    </Suspense>
  );
}

export default function Page() {
  return (
    <Providers>
      <ViewerContent />
    </Providers>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    minHeight: '100vh',
    width: '100%',
    minWidth: '320px',
    padding: '16px',
    fontFamily: 'inherit',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    boxSizing: 'border-box',
  },
  header: {
    textAlign: 'center',
    marginBottom: '6px',
  },
  title: {
    margin: '0',
    fontSize: 'clamp(1.5rem, 5vw, 2rem)',
    fontWeight: '800',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
  },
  titleEmoji: {
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  },
  titleText: {
    background: 'linear-gradient(135deg, #ffffff 0%, #e0e7ff 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    letterSpacing: '-0.02em',
  },
  content: {
    maxWidth: '480px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  tabs: {
    display: 'flex',
    gap: '6px',
    background: 'rgba(255, 255, 255, 0.95)',
    padding: '5px',
    borderRadius: '12px',
  },
  tab: {
    flex: 1,
    padding: '8px 6px',
    background: 'transparent',
    border: 'none',
    borderRadius: '10px',
    color: '#718096',
    fontSize: '0.85rem',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'all 0.2s',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
  },
  tabActive: {
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: '#ffffff',
  },
  footer: {
    marginTop: '6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    flexWrap: 'wrap',
  },
  footerText: {
    fontSize: '0.8rem',
    color: 'rgba(255, 255, 255, 0.9)',
  },
  footerHeart: {
    fontSize: '0.85rem',
  },
  footerEmoji: {
    fontSize: '1rem',
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    fontVariantEmoji: 'emoji',
  },
  footerLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    color: 'rgba(255, 255, 255, 0.95)',
    textDecoration: 'none',
    fontSize: '0.8rem',
    fontWeight: '600',
    transition: 'opacity 0.2s',
  },
  footerSeparator: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: '0.8rem',
  },
  footerX: {
    fontSize: '0.85rem',
    fontFamily: 'inherit',
    color: 'rgba(255, 255, 255, 0.9)',
  },
};
