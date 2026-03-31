'use client';

import { Providers } from './providers';
import { ProfileCard } from '@/components/ProfileCard';
import { SocialGraph } from '@/components/SocialGraph';
import { AssetList } from '@/components/AssetList';
import { ActivityList } from '@/components/ActivityList';
import { useState } from 'react';

type TabType = 'assets' | 'social' | 'activity';

function ViewerContent() {
  const [activeTab, setActiveTab] = useState<TabType>('assets');

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={styles.title}>
          <span style={styles.titleEmoji}>🆙</span>
          <span style={styles.titleText}>Viewer</span>
        </h1>
      </header>

      <div style={styles.content}>
        <ProfileCard />

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

        {activeTab === 'assets' && <AssetList />}
        {activeTab === 'social' && <SocialGraph />}
        {activeTab === 'activity' && <ActivityList />}
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
    marginTop: '8px',
    paddingTop: '8px',
    textAlign: 'center',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
  },
  footerText: {
    fontSize: '0.75rem',
    color: 'rgba(255, 255, 255, 0.85)',
  },
  footerHeart: {
    fontSize: '0.85rem',
  },
  footerEmoji: {
    fontSize: '1rem',
  },
  footerLink: {
    color: 'rgba(255, 255, 255, 0.9)',
    textDecoration: 'none',
    fontSize: '0.75rem',
    fontWeight: '600',
  },
  footerSeparator: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: '0.75rem',
  },
  footerX: {
    fontSize: '0.85rem',
    color: 'rgba(255, 255, 255, 0.85)',
  },
};
