'use client';

import { Providers } from './providers';
import { ProfileCard } from '@/components/ProfileCard';
import { SocialGraph } from '@/components/SocialGraph';
import { AssetList } from '@/components/AssetList';
import { ActivityList } from '@/components/ActivityList';
import { useState, Suspense, useCallback, useEffect, useRef } from 'react';
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
          <DynamicProfileSearch
            onSelect={handleSelectAddress}
            onCancel={() => setShowSearch(false)}
          />
        )}

        {/* ── カテゴリカード（タブ選択） ── */}
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
              {tab === 'assets'   ? '💎 Assets'
               : tab === 'social' ? '🤝 Social'
               : '⚡ Activity'}
            </button>
          ))}
        </div>

        {/* ── コンテンツカード（常時マウント）──────────────────
            display:none を廃止。全タブを常時レイアウトに存在させることで：
            ・virtualizer が常に正しい高さを持つコンテナを参照できる
            ・タブ切り替え時の「高さゼロ → 一気に伸びる」を解消
            ・スクロール位置が DOM 破棄なしで自然に保持される

            非アクティブタブは position:absolute + opacity:0 + pointer-events:none
            で視覚的に隠す。activeタブだけが position:relative でスペースを占有。

            各コンポーネントは active prop で「初回アクティブ化まで
            フェッチしない」を制御する（hasBeenActive パターン）。     */}
        <div style={styles.tabPanel}>
          {(['assets', 'social', 'activity'] as const).map(tab => (
            <div
              key={tab}
              style={{
                ...styles.tabWrapper,
                ...(activeTab === tab ? styles.tabWrapperActive : styles.tabWrapperInactive),
              }}
            >
              {tab === 'assets'   && <AssetList    address={activeAddress} active={activeTab === 'assets'}   />}
              {tab === 'social'   && <SocialGraph  address={activeAddress} active={activeTab === 'social'} onViewMode={(addr) => handleSelectAddress(addr as `0x${string}`)} />}
              {tab === 'activity' && <ActivityList address={activeAddress} active={activeTab === 'activity'} />}
            </div>
          ))}
        </div>
      </div>

      <footer style={styles.footer}>
        <span style={styles.footerText}>Made with </span>
        <span>❤️</span>
        <span style={styles.footerText}> by </span>
        <a
          href="https://profile.link/🆙chan@bcA4"
          target="_blank"
          rel="noopener noreferrer"
          style={styles.footerLink}
        >
          <span style={styles.titleEmoji}>🆙</span>chan
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

// ── Lazy-loaded ProfileSearch ──────────────────────────────
// useRef で import 結果を保持し、再マウントを防ぐ（入力フォーカス維持）

function DynamicProfileSearch(props: {
  onSelect: (addr: `0x${string}`) => void;
  onCancel: () => void;
}) {
  const ref = useRef<{ default?: any; ProfileSearch?: any } | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (ref.current) return;
    import('@/components/ProfileSearch').then(m => {
      ref.current = m;
      setTick(t => t + 1);
    });
  }, []);

  const ProfileSearch = ref.current?.ProfileSearch;
  if (!ProfileSearch) return null;
  return <ProfileSearch {...props} />;
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
// Phase 3:   display:none を廃止、常時マウント + opacity/position 切り替えに変更。
//            virtualizer が常に正しいコンテナ高さを認識し、タブ遷移の伸縮を解消。

const styles: { [key: string]: React.CSSProperties } = {
  // ── ページ全体 ──
  // min-height: 100dvh でモバイルのアドレスバー収縮に追従。
  // flex column でヘッダー・コンテンツ・フッターを縦積みし、
  // コンテンツが残余スペースを占有する。
  container: {
    height: '100dvh',          // minHeight → height に変更。
    overflow: 'hidden',        // container 自体がビューポートを超えない。
    width: '100%',
    minWidth: 'var(--min-width-app)',
    padding: 'var(--space-3)',
    paddingBottom: 'var(--space-2)',
    fontFamily: 'inherit',
    background: 'var(--gradient-brand)',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
  },
  // ── ヘッダー ──
  // タイトルは小さく抑えてコンテンツ優先
  header: {
    textAlign: 'center',
    flexShrink: 0,
    marginBottom: 'var(--space-1)',
  },
  title: {
    margin: '0',
    fontSize: 'clamp(1.2rem, 4vw, 1.6rem)',  // 従来より小さく
    fontWeight: '800',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
  },
  titleEmoji: {
    fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
  },
  titleText: {
    background: 'var(--gradient-title-text)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
    letterSpacing: '-0.02em',
  },
  // ── コンテンツ列 ──
  // flex:1 で container の余白を占有し、内部カードを縦に並べる
  content: {
    maxWidth: 'var(--content-max-width)',
    width: '100%',
    margin: '0 auto',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    minHeight: 0,
  },
  // ── カテゴリカード（タブバー本体） ──
  tabs: {
    display: 'flex',
    gap: 'var(--space-1)',
    background: 'var(--color-surface-card)',
    padding: '4px',
    borderRadius: 'var(--radius-xl)',
    flexShrink: 0,
  },
  tab: {
    flex: 1,
    padding: '7px 6px',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--text-md)',
    fontWeight: '600',
    cursor: 'pointer',
    transition: `all var(--transition-normal)`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1)',
    minHeight: '36px',              // 旧 42px → 36px でモバイル省スペース
  },
  tabActive: {
    background: 'var(--gradient-brand)',
    color: 'var(--color-text-white)',
  },
  // ── コンテンツカード領域 ──
  // flex:1 + min-height:0 で content の残余スペースをすべて占有。
  // position:relative で絶対配置の非アクティブタブを受ける。
  tabPanel: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
  },
  // アクティブタブ: 通常フロー、height:100% で tabPanel を埋める
  tabWrapperActive: {
    position: 'relative',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    opacity: 1,
    pointerEvents: 'auto' as const,
    zIndex: 1,
    transition: 'opacity 0.15s ease',
  },
  // 非アクティブタブ: 絶対配置で視覚的に隠すが DOM には残す
  // opacity:0 + pointer-events:none で完全に非表示
  // virtualizer は DOM に存在するため高さを正しく認識し続ける
  tabWrapperInactive: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    opacity: 0,
    pointerEvents: 'none' as const,
    zIndex: 0,
    transition: 'opacity 0.15s ease',
  },
  // Suspense fallback
  suspenseFallback: {
    height: '100dvh',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--gradient-brand)',
    color: 'var(--color-text-white)',
  },
  // ── フッター ──
  footer: {
    flexShrink: 0,
    marginTop: 'var(--space-1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-1)',
    flexWrap: 'wrap',
  },
  footerText: {
    fontSize: 'var(--text-base)',
    color: 'rgba(255, 255, 255, 0.9)',
  },
  footerLink: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    color: 'rgba(255, 255, 255, 0.95)',
    textDecoration: 'none',
    fontSize: 'var(--text-base)',
    fontWeight: '600',
    transition: `opacity var(--transition-normal)`,
  },
  footerSeparator: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 'var(--text-base)',
  },
  footerX: {
    fontSize: 'var(--text-md)',
    fontFamily: 'inherit',
    color: 'rgba(255, 255, 255, 0.9)',
  },
};
