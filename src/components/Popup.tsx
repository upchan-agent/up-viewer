'use client';

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { ErrorImage } from '@/components/ErrorImage';

// ─── Props ────────────────────────────────────────────────────
//
// Popup is a pure display component — it knows nothing about LSP standards,
// indexer data structures, or image resolution logic.
// Callers (AssetList, SocialGraph, etc.) are responsible for assembling
// the props from their own data sources.
//
// image.url === null && image.scheme === 'loading' → show spinner
// image.url === null && image.scheme !== 'loading' → show placeholder emoji
// image.url !== null                               → show image
//
// backgroundImage: shown as a banner behind the avatar image (Social profiles).
//   When present, the image area switches from a centered square to an
//   overlapping banner+avatar layout.
//
// stats: generic key-value pairs shown in a 2-column grid.
//   Callers decide which stats to include and how to format the values.
//   An even number of items fills the grid cleanly; odd numbers leave one cell empty.
//
// links: { title, url } — note "title" to match LSP3 profile schema.
//   Asset links use "name" — callers should normalize to "title" before passing.
//
// attributes: shown as a 2-column grid, max 12 items.
//
// externalUrl: single "View on Explorer" style link shown below the stats.
//
// debugText: raw string rendered in a collapsible monospace panel.
//   Pass undefined to hide the debug section entirely.

export interface PopupImage {
  url: string | null;
  scheme: string;
}

export interface PopupLink {
  title?: string;
  url: string;
}

export interface PopupStat {
  label: string;
  value: string;
}

export interface PopupAttribute {
  key: string;
  value: string;
}

export interface PopupExternalUrl {
  label: string;
  url: string;
}

export interface PopupProps {
  onClose: () => void;

  // Image
  image?: PopupImage;
  backgroundImage?: string;       // banner background image
  useBannerLayout?: boolean;      // always use banner+avatar layout (Social profiles)
  placeholderEmoji?: string;      // shown when no image — defaults to '🖼️'

  // Header
  name?: string;
  isLoading?: boolean;            // show skeleton for name
  subLabel?: string;              // symbol, token ID, address, etc.

  // Body
  description?: string;
  tags?: string[];

  // Data grid
  stats?: PopupStat[];

  // Links and attributes
  links?: PopupLink[];
  attributes?: PopupAttribute[];

  // External URL (Contract, Profile page, etc.)
  externalUrl?: PopupExternalUrl;

  // Inline action button (shown next to externalUrl)
  onView?: () => void;
  viewLabel?: string;

  // Debug
  debugText?: string;
}

// ─── Component ────────────────────────────────────────────────

export const Popup = memo(function Popup({
  onClose,
  image,
  backgroundImage,
  useBannerLayout = false,
  placeholderEmoji = '🖼️',
  name,
  isLoading,
  subLabel,
  description,
  tags,
  stats,
  links,
  attributes,
  externalUrl,
  onView,
  viewLabel = '👀 View',
  debugText,
}: PopupProps) {
  const [debugOpen, setDebugOpen] = useState(false);

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Reset debug panel when popup content changes
  useEffect(() => { setDebugOpen(false); }, [name, subLabel]);

  const handleDebugToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDebugOpen(open => !open);
  }, []);

  // Banner avatar fallback (timeout時 / ローディング中 / 画像なし)
  // Banner avatar content — what to show inside the circular avatar
  const avatarContent = image?.url
    ? <ErrorImage src={image.url} style={styles.bannerAvatar} fallback={<div style={styles.bannerAvatarPlaceholder} />} />
    : <div style={styles.bannerAvatarPlaceholder} />;

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.popup} onClick={(e) => e.stopPropagation()}>

        {/* Close button — always on top */}
        <button style={styles.closeButton} onClick={onClose}>×</button>

        {/* ── Image area ──────────────────────────────────────
            useBannerLayout: always banner+avatar (Social).
              backgroundImage present → show image, absent → show gradient placeholder.
            Standard layout: fixed-height centered image box (Asset).
            Both layouts reserve a fixed height so the popup never shifts size.
        */}
        {useBannerLayout ? (
          <div style={styles.bannerWrapper}>
            {/* Banner background: img tag (not CSS background-image) so we can
                fade in after load and avoid the "wrong crop on first open" bug
                caused by browser applying default background-position before
                the image bytes arrive. No image → grey placeholder. */}
            <div style={{
              ...styles.bannerBackground,
              background: backgroundImage ? 'transparent' : 'var(--color-border-default)',
            }}>
              {backgroundImage && (
                <ErrorImage
                  src={backgroundImage}
                  style={styles.bannerBgImg}
                  onLoad={(e) => { (e.target as HTMLImageElement).style.opacity = '1'; }}
                />
              )}
            </div>
            <div style={{
              ...styles.bannerAvatarWrapper,
              background: 'var(--color-border-default)',
            }}>
              {avatarContent}
            </div>
          </div>
        ) : (
          <div style={styles.imageWrapper}>
            {isLoading
              ? <span style={styles.loadingText}>⏳ Loading...</span>
              : image?.url
                ? <ErrorImage src={image.url} style={styles.image} fallback={<span style={styles.placeholderEmoji}>{placeholderEmoji}</span>} />
                : <span style={styles.placeholderEmoji}>{placeholderEmoji}</span>}
          </div>
        )}

        {/* ── Header ──────────────────────────────────────── */}
        <div style={{ ...styles.header, ...(useBannerLayout ? { marginTop: '36px' } : {}) }}>
          {isLoading
            ? <div className="skim" style={{ width: '120px', height: '22px', borderRadius: 'var(--radius-xs)' }} />
            : name && <h3 style={styles.name}>{name}</h3>}
          {subLabel && <span style={styles.subLabel}>{subLabel}</span>}
          {onView && (
            <button
              style={styles.viewButton}
              onClick={(e) => { e.stopPropagation(); onView(); }}
            >
              {viewLabel}
            </button>
          )}
        </div>

        {/* ── Tags ────────────────────────────────────────── */}
        {!!(tags?.length) && (
          <div style={styles.tagsRow}>
            {tags.map((tag, i) => (
              <span key={i} style={styles.tag}>{tag}</span>
            ))}
          </div>
        )}

        {/* ── Description ─────────────────────────────────── */}
        {description && <p style={styles.description}>{description}</p>}

        {/* ── Stats grid ──────────────────────────────────── */}
        {!!(stats?.length) && (
          <div style={styles.statsGrid}>
            {stats.map((stat, i) => (
              <div key={i}>
                <span style={styles.statLabel}>{stat.label}</span>
                <span style={styles.statValue}>{stat.value}</span>
              </div>
            ))}
          </div>
        )}

        {/* ── External URL ────────────────────────────────── */}
        {externalUrl && (
          <div style={{ marginBottom: '8px' }}>
            <span style={styles.statLabel}>{externalUrl.label}</span>
            <span style={styles.statValue}>
              <a
                href={externalUrl.url}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.link}
              >
                {externalUrl.url}
              </a>
            </span>
          </div>
        )}

        {/* ── Links ───────────────────────────────────────── */}
        {!!(links?.length) && (
          <div style={{ marginBottom: '8px' }}>
            <span style={styles.statLabel}>Links</span>
            <div style={styles.linksRow}>
              {links.map((l, i) => (
                <a
                  key={i}
                  href={l.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.outboundLink}
                >
                  {l.title || l.url} ↗
                </a>
              ))}
            </div>
          </div>
        )}

        {/* ── Attributes ──────────────────────────────────── */}
        {!!(attributes?.length) && (
          <div style={{ marginBottom: '8px' }}>
            <span style={styles.statLabel}>Attributes</span>
            <div style={styles.attributesGrid}>
              {attributes.slice(0, 12).map((a, i) => (
                <div key={i} style={styles.attributeItem}>
                  {a.key && <span style={styles.attrKey}>{a.key}</span>}
                  <span style={styles.attrValue}>{a.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Debug ───────────────────────────────────────── */}
        {debugText !== undefined && (
          <div style={debugStyles.container}>
            <button
              style={debugStyles.toggle}
              onClick={handleDebugToggle}
            >
              🔍 Debug: Image Resolution {debugOpen ? '▲' : '▼'}
            </button>
            {debugOpen && (
              <div style={debugStyles.content}>{debugText}</div>
            )}
          </div>
        )}

      </div>
    </div>
  );
});

// ─── Styles ──────────────────────────────────────────────────

// ─── Styles ──────────────────────────────────────────────────
// popupIn keyframes は globals.css で定義済み。
// document.createElement('style') による注入は不要。

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.3)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(2px)',
  },
  popup: {
    background: 'var(--color-surface-input)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-popup)',
    maxWidth: '420px', width: '90%',
    height: '70vh',     // 固定高さでコンテンツロード時のサイズシフトを防ぐ
    overflowY: 'auto', overflowX: 'hidden',
    position: 'relative', padding: 'var(--space-4)',
    animation: 'popupIn 0.2s ease', transformOrigin: 'center',
    boxSizing: 'border-box',
  },
  closeButton: {
    position: 'absolute', top: 'var(--space-2)', right: 'var(--space-3)',
    background: 'none', border: 'none', fontSize: '1.5rem',
    cursor: 'pointer', color: 'var(--color-text-muted)', lineHeight: 1, zIndex: 2,
  },

  // 標準画像エリア（Asset）— 固定高さでレイアウトシフトを防ぐ
  imageWrapper: {
    width: '100%', height: '160px',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden', marginBottom: 'var(--space-3)',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    background: 'var(--color-surface-muted)', flexShrink: 0,
  },
  image: { maxWidth: '100%', maxHeight: '160px', objectFit: 'contain' },
  loadingText: { color: 'var(--color-text-faint)', fontSize: 'var(--text-md)' },
  placeholderEmoji: { color: 'var(--color-text-faint)', fontSize: '2rem' },

  // バナー＋アバターレイアウト（Social）
  bannerWrapper: {
    width: '100%', marginBottom: 'var(--space-3)', position: 'relative',
    borderRadius: 'var(--radius-xl)', overflow: 'visible',
  },
  bannerBackground: {
    width: '100%', height: '100px',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden', position: 'relative',
  },
  bannerBgImg: {
    width: '100%', height: '100%',
    objectFit: 'cover', objectPosition: 'center',
    opacity: 0, transition: `opacity var(--transition-normal)`,
    display: 'block',
  },
  bannerAvatarWrapper: {
    position: 'absolute', bottom: '-28px', left: 'var(--space-4)',
    width: '64px', height: '64px',
    borderRadius: 'var(--radius-full)',
    border: '3px solid var(--color-surface-input)',
    overflow: 'hidden',
    background: 'var(--color-surface-muted)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: 'var(--shadow-avatar)',
  },
  bannerAvatar: { width: '100%', height: '100%', objectFit: 'cover' },
  bannerAvatarPlaceholder: { width: '100%', height: '100%', borderRadius: 'var(--radius-full)', background: 'var(--color-surface-muted)' },

  // ヘッダー
  header: { marginBottom: 'var(--space-2)', marginTop: '0' },
  name: {
    fontSize: 'var(--text-xl)', fontWeight: '700',
    color: 'var(--color-text-primary)', margin: 0, lineHeight: 1.3,
  },
  subLabel: {
    fontSize: '0.8rem', color: 'var(--color-text-muted)', fontWeight: '500',
  },

  // タグ
  tagsRow: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginBottom: 'var(--space-2)' },
  tag: {
    fontSize: 'var(--text-sm)', padding: '2px 8px',
    background: 'var(--color-surface-tag)',
    borderRadius: 'var(--radius-full)',
    color: 'var(--color-text-tag)', fontWeight: '500',
  },

  // 説明文
  description: {
    fontSize: 'var(--text-md)', color: 'var(--color-text-secondary)', lineHeight: 1.5,
    margin: '0 0 var(--space-2) 0', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
  },

  // Stats グリッド
  statsGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-2)', marginBottom: 'var(--space-2)',
  },
  statLabel: {
    display: 'block', fontSize: 'var(--text-sm)', color: 'var(--color-text-faint)',
    fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.025em',
  },
  statValue: {
    fontSize: 'var(--text-md)', fontWeight: '600',
    color: 'var(--color-text-secondary)', wordBreak: 'break-all',
  },

  // リンク
  link: { color: 'var(--color-text-link)', textDecoration: 'none', wordBreak: 'break-all' },

  // View ボタン
  viewButton: {
    marginTop: 'var(--space-1)',
    padding: '4px 12px',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    background: 'var(--gradient-brand)',
    color: 'var(--color-text-white)',
    fontSize: 'var(--text-sm)',
    fontWeight: '600',
    cursor: 'pointer',
    transition: 'opacity var(--transition-fast)',
  },
  linksRow: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginTop: 'var(--space-1)' },
  outboundLink: {
    fontSize: '0.8rem', padding: '4px 8px',
    background: 'var(--color-surface-tag)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-secondary)', textDecoration: 'none',
    transition: `background var(--transition-fast)`, wordBreak: 'break-all',
  },

  // Attributes
  attributesGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-1)', marginTop: 'var(--space-1)',
  },
  attributeItem: {
    padding: '6px 8px',
    background: 'var(--color-surface-attr)',
    borderRadius: 'var(--radius-md)',
    display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden',
  },
  attrKey: { fontSize: 'var(--text-sm)', color: 'var(--color-text-faint)', fontWeight: '500' },
  attrValue: {
    fontSize: 'var(--text-md)', fontWeight: '600',
    color: 'var(--color-text-secondary)', wordBreak: 'break-word',
  },
};

const debugStyles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: 'var(--space-2)', fontSize: '0.58rem', color: 'var(--color-text-muted)',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid var(--color-border-debug)`, overflow: 'hidden',
  },
  toggle: {
    width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
    padding: '4px var(--space-2)',
    background: 'var(--color-surface-debug)',
    fontWeight: 600, fontSize: 'var(--text-xs)',
    color: 'var(--color-text-debug)', userSelect: 'none',
  },
  content: {
    padding: '6px var(--space-2)',
    background: 'var(--color-surface-debug-body)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    lineHeight: '1.4', color: 'var(--color-text-debug-val)',
    fontFamily: 'monospace', fontSize: '0.58rem',
  },
};
