'use client';

import { Providers } from './providers';
import { ProfileCard } from '@/components/ProfileCard';
import { SocialGraph } from '@/components/SocialGraph';
import { AssetList } from '@/components/AssetList';
import { ActivityList } from '@/components/ActivityList';
import { ProfileSearch } from '@/components/ProfileSearch';
import { useState, Suspense, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

type TabType = 'assets' | 'social' | 'activity';

function ViewerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const urlAddress = searchParams.get('address') as `0x${string}` | null;
  const viewAddressParam = searchParams.get('view') as `0x${string}` | null;
  const [viewAddress, setViewAddress] = useState<`0x${string}` | null>(viewAddressParam);

  const activeAddress = viewAddress || urlAddress || undefined;
  const isViewMode = !!viewAddress || !!urlAddress;

  useEffect(() => {
    if (viewAddress) {
      router.replace(`?view=${viewAddress}`, { scroll: false });
    }
  }, [viewAddress, router]);

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
      <div style={styles.content}>
        <ProfileCard
          address={activeAddress}
          isViewMode={isViewMode}
          onExitViewMode={handleExitViewMode}
          onToggleSearch={() => setShowSearch(prev => !prev)}
        />

        {showSearch && (
          <div style={styles.searchSlot}>
            <ProfileSearch
              onSelect={handleSelectAddress}
              onCancel={() => setShowSearch(false)}
            />
          </div>
        )}

        <div style={styles.tabs}>
          {(['assets', 'social', 'activity'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                ...styles.tab,
                ...(activeTab === tab ? styles.tabActive : {}),
              }}
            >
              {tab === 'assets' ? 'Assets' : tab === 'social' ? 'Social' : 'Activity'}
            </button>
          ))}
        </div>

        <div style={styles.tabPanel}>
          {(['assets', 'social', 'activity'] as const).map(tab => (
            <div
              key={tab}
              style={activeTab === tab ? styles.tabWrapperActive : styles.tabWrapperInactive}
            >
              {tab === 'assets'   && <AssetList    address={activeAddress} active={activeTab === 'assets'}   />}
              {tab === 'social'   && <SocialGraph  address={activeAddress} active={activeTab === 'social'} onViewMode={(addr) => handleSelectAddress(addr as `0x${string}`)} />}
              {tab === 'activity' && <ActivityList address={activeAddress} active={activeTab === 'activity'} />}
            </div>
          ))}
        </div>
      </div>

      <footer style={styles.footer}>
        <span style={styles.footerText}>Made with</span>
        <span style={styles.footerEmoji}>❤️</span>
        <span style={styles.footerText}>by</span>
        <a
          href="https://profile.link/🆙chan@bcA4"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.footerLink}
        >
          <span style={styles.footerEmoji}>🆙</span>chan
        </a>
        <span style={styles.footerSeparator}>|</span>
        <a
          href="https://x.com/UPchan_lyx"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.footerLink}
        >
          <span style={styles.footerX}>𝕏</span>
        </a>
      </footer>
    </div>
  );
}

function ViewerContent() {
  return (
    <Suspense
      fallback={
        <div style={styles.suspenseFallback}>Loading...</div>
      }
    >
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

// ─── Styles ──────────────────────────────────────────────────
// Phase 2-1: container を flex column にしてビューポート全体を占有。
//            content が flex:1 で伸長し、tabPanel がその余白を埋める。
// Tab panels: 非アクティブタブは display:none。
//   - React コンポーネントはマウントされたまま（状態・スクロール位置・
//     フェッチ済みデータは保持される）
//   - 描画はされないため合成レイヤーが残らず、デスクトップ Chrome で
//     タブ切替時に黒い焼き付き（コンポジティング残像）が出ない
//   - 旧「常時マウント + opacity 切替」は virtualizer 用だったが、
//     virtualizer は廃止済みのため不要になった

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    height: '100dvh',
    overflow: 'hidden',
    width: '100%',
    minWidth: 'var(--min-width-app)',
    fontFamily: 'inherit',
    background: 'radial-gradient(120% 42% at 50% 0%, rgba(120, 164, 230, 0.22), transparent 58%), var(--paper)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
  },
  content: {
    maxWidth: 'var(--content-max-width)',
    width: '100%',
    margin: '0 auto',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  searchSlot: {
    padding: '0 16px',
    flexShrink: 0,
  },
  tabs: {
    display: 'flex',
    padding: '0 8px',
    borderBottom: '1px solid var(--line)',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '8px 0 6px',
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    color: 'var(--mute)',
    fontSize: '13px',
    fontWeight: '600',
    cursor: 'pointer',
  },
  tabActive: {
    color: 'var(--ink)',
    borderBottomColor: 'var(--accent)',
  },
  tabPanel: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  tabWrapperActive: {
    position: 'relative',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
  tabWrapperInactive: {
    display: 'none',
  },
  suspenseFallback: {
    height: '100dvh',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--paper)',
    color: 'var(--ink)',
  },
  footer: {
    flexShrink: 0,
    padding: '4px 16px 5px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '4px',
    flexWrap: 'nowrap',
    whiteSpace: 'nowrap',
    borderTop: '1px solid var(--line)',
    lineHeight: 1.2,
  },
  footerText: {
    fontSize: '11px',
    lineHeight: 1.2,
    color: 'var(--mute)',
  },
  footerEmoji: {
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
    fontSize: '13px',
    lineHeight: 1,
  },
  footerLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '2px',
    color: 'var(--accent)',
    textDecoration: 'none',
    fontSize: '11px',
    lineHeight: 1.2,
    fontWeight: '650',
  },
  footerSeparator: {
    color: '#9aa8bc',
    fontSize: '11px',
    lineHeight: 1.2,
  },
  footerX: {
    fontSize: '12px',
    lineHeight: 1,
    fontFamily: 'inherit',
    color: 'var(--accent)',
  },
};
