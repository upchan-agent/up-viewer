'use client';

import { useState, useEffect, useCallback, memo } from 'react';

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
  placeholderInitial?: string;    // shown in avatar when no image (1 char)

  // Header
  name?: string;
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
  placeholderInitial,
  name,
  subLabel,
  description,
  tags,
  stats,
  links,
  attributes,
  externalUrl,
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

  const isLoading = image?.scheme === 'loading';

  // Banner avatar content — what to show inside the circular avatar
  const avatarContent = isLoading
    ? <span style={{ fontSize: '1rem', color: '#a0aec0' }}>⏳</span>
    : image?.url
      ? <img src={image.url} alt="" style={styles.bannerAvatar}
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
      : placeholderInitial
        ? <span style={{ fontSize: '1.4rem', fontWeight: 700, color: '#fff' }}>{placeholderInitial}</span>
        : <span style={{ fontSize: '1.4rem' }}>{placeholderEmoji}</span>;

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
              background: backgroundImage ? 'transparent' : '#e2e8f0',
            }}>
              {backgroundImage && (
                <img
                  src={backgroundImage}
                  alt=""
                  style={styles.bannerBgImg}
                  onLoad={(e) => { (e.target as HTMLImageElement).style.opacity = '1'; }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              )}
            </div>
            <div style={{
              ...styles.bannerAvatarWrapper,
              background: (!image?.url && !placeholderInitial) ? '#e2e8f0' : '#f7fafc',
            }}>
              {avatarContent}
            </div>
          </div>
        ) : (
          <div style={styles.imageWrapper}>
            {isLoading
              ? <span style={styles.loadingText}>⏳ Loading...</span>
              : image?.url
                ? <img src={image.url} alt="" style={styles.image}
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                : <span style={styles.placeholderEmoji}>{placeholderEmoji}</span>}
          </div>
        )}

        {/* ── Header ──────────────────────────────────────── */}
        <div style={{ ...styles.header, ...(useBannerLayout ? { marginTop: '36px' } : {}) }}>
          {name && <h3 style={styles.name}>{name}</h3>}
          {subLabel && <span style={styles.subLabel}>{subLabel}</span>}
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

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(0,0,0,0.3)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backdropFilter: 'blur(2px)',
  },
  popup: {
    background: '#fff', borderRadius: '16px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
    maxWidth: '420px', width: '90%',
    height: '70vh',           // always full height — prevents size shift on content load
    overflowY: 'auto', overflowX: 'hidden',
    position: 'relative', padding: '16px',
    animation: 'popupIn 0.2s ease', transformOrigin: 'center',
    boxSizing: 'border-box',
  },
  closeButton: {
    position: 'absolute', top: '8px', right: '12px',
    background: 'none', border: 'none', fontSize: '1.5rem',
    cursor: 'pointer', color: '#718096', lineHeight: 1, zIndex: 2,
  },

  // Standard image (Asset) — always reserves height to prevent layout shift
  imageWrapper: {
    width: '100%', height: '160px', borderRadius: '12px',
    overflow: 'hidden', marginBottom: '12px',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    background: '#f7fafc', flexShrink: 0,
  },
  image: { maxWidth: '100%', maxHeight: '160px', objectFit: 'contain' },
  loadingText: { color: '#a0aec0', fontSize: '0.85rem' },
  placeholderEmoji: { color: '#a0aec0', fontSize: '2rem' },

  // Background + avatar layout (Social)
  bannerWrapper: {
    width: '100%', marginBottom: '12px', position: 'relative',
    borderRadius: '12px', overflow: 'visible',
  },
  bannerBackground: {
    width: '100%', height: '100px', borderRadius: '12px',
    overflow: 'hidden', position: 'relative',
  },
  bannerBgImg: {
    width: '100%', height: '100%',
    objectFit: 'cover', objectPosition: 'center',
    opacity: 0, transition: 'opacity 0.2s ease',
    display: 'block',
  },
  bannerAvatarWrapper: {
    position: 'absolute', bottom: '-28px', left: '16px',
    width: '64px', height: '64px', borderRadius: '50%',
    border: '3px solid #fff', overflow: 'hidden',
    background: '#f7fafc',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
  },
  bannerAvatar: { width: '100%', height: '100%', objectFit: 'cover' },

  // Header
  header: { marginBottom: '8px', marginTop: '0' },
  name: { fontSize: '1.1rem', fontWeight: '700', color: '#1a202c', margin: 0, lineHeight: 1.3 },
  subLabel: { fontSize: '0.8rem', color: '#718096', fontWeight: '500' },

  // Tags
  tagsRow: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' },
  tag: {
    fontSize: '0.7rem', padding: '2px 8px',
    background: '#edf2f7', borderRadius: '999px',
    color: '#4a5568', fontWeight: '500',
  },

  // Description
  description: {
    fontSize: '0.85rem', color: '#4a5568', lineHeight: 1.5,
    margin: '0 0 8px 0', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
  },

  // Stats grid
  statsGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: '8px', marginBottom: '8px',
  },
  statLabel: {
    display: 'block', fontSize: '0.7rem', color: '#a0aec0',
    fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.025em',
  },
  statValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-all' },

  // Links
  link: { color: '#667eea', textDecoration: 'none', wordBreak: 'break-all' },
  linksRow: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '4px' },
  outboundLink: {
    fontSize: '0.8rem', padding: '4px 8px',
    background: '#edf2f7', borderRadius: '6px',
    color: '#4a5568', textDecoration: 'none',
    transition: 'background 0.15s', wordBreak: 'break-all',
  },

  // Attributes
  attributesGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '4px' },
  attributeItem: {
    padding: '6px 8px', background: '#f7fafc', borderRadius: '8px',
    display: 'flex', flexDirection: 'column', gap: '2px', overflow: 'hidden',
  },
  attrKey: { fontSize: '0.7rem', color: '#a0aec0', fontWeight: '500' },
  attrValue: { fontSize: '0.85rem', fontWeight: '600', color: '#2d3748', wordBreak: 'break-word' },
};

const debugStyles: Record<string, React.CSSProperties> = {
  container: {
    marginTop: '8px', fontSize: '0.58rem', color: '#6b7280',
    borderRadius: '6px', border: '1px solid #e5e7eb', overflow: 'hidden',
  },
  toggle: {
    width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
    padding: '4px 8px', background: '#f9fafb',
    fontWeight: 600, fontSize: '0.65rem', color: '#374151', userSelect: 'none',
  },
  content: {
    padding: '6px 8px', background: '#fef2f2',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    lineHeight: '1.4', color: '#e74c3c',
    fontFamily: 'monospace', fontSize: '0.58rem',
  },
};

// Inject keyframes once
if (typeof document !== 'undefined' && !document.getElementById('popup-keyframes')) {
  const s = document.createElement('style');
  s.id = 'popup-keyframes';
  s.textContent = '@keyframes popupIn{from{opacity:0}to{opacity:1}}';
  document.head.appendChild(s);
}
