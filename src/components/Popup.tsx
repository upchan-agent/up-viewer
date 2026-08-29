'use client';

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import { ErrorImage, ImagePending } from '@/components/ErrorImage';
import type { ImageTransportStatus } from '@/components/ErrorImage';
import { TRACE_GLYPH, traceHit, traceMiss, traceSkip, traceWait, type TraceStep } from '@/lib/debug-trace';

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
// debugSteps: structured trace (preferred) — rendered as a readable
//   step list with status glyphs. Takes precedence over debugText.
//   Pass neither to hide the debug section.

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
  placeholderInitials?: string;   // shown when no image

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
  debugSteps?: TraceStep[];
  }

// ─── Component ────────────────────────────────────────────────

export const Popup = memo(function Popup({
  onClose,
  image,
  backgroundImage,
  useBannerLayout = false,
  placeholderInitials,
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
  viewLabel = 'View',
  debugText,
  debugSteps,
}: PopupProps) {
  const [debugOpen, setDebugOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomTriggerRef = useRef<HTMLButtonElement>(null);
  const [primaryTransport, setPrimaryTransport] = useState<{
    src: string;
    status: ImageTransportStatus;
  } | null>(null);
  const [backgroundTransport, setBackgroundTransport] = useState<{
    src: string;
    status: ImageTransportStatus;
  } | null>(null);

  const handlePrimaryTransport = useCallback((status: ImageTransportStatus, src: string) => {
    setPrimaryTransport(current => current?.src === src && current.status === status
      ? current
      : { src, status });
  }, []);
  const handleBackgroundTransport = useCallback((status: ImageTransportStatus, src: string) => {
    setBackgroundTransport(current => current?.src === src && current.status === status
      ? current
      : { src, status });
  }, []);

  const canZoom = !!image?.url
    && primaryTransport?.src === image.url
    && primaryTransport.status === 'loaded';

  const handleOpenZoom = useCallback(() => {
    if (canZoom) setZoomOpen(true);
  }, [canZoom]);

  const handleCloseZoom = useCallback(() => {
    setZoomOpen(false);
    requestAnimationFrame(() => zoomTriggerRef.current?.focus());
  }, []);

  // Escape closes the topmost layer first: lightbox, then details popup.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (zoomOpen) {
        e.preventDefault();
        e.stopImmediatePropagation();
        handleCloseZoom();
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleCloseZoom, onClose, zoomOpen]);

  // Reset transient panels when popup content changes
  useEffect(() => {
    setDebugOpen(false);
    setZoomOpen(false);
  }, [name, subLabel]);

  const renderedDebugSteps = useMemo((): TraceStep[] | undefined => {
    if (debugSteps === undefined) return undefined;
    const steps = [...debugSteps];

    if (image?.url) {
      const status = primaryTransport?.src === image.url ? primaryTransport.status : 'loading';
      if (status === 'loaded') steps.push(traceHit('transport.primary: decoded', image.url));
      else if (status === 'failed') steps.push(traceMiss('transport.primary: load failed', image.url));
      else if (status === 'timeout') steps.push(traceMiss('transport.primary: timeout after 20s', image.url));
      else steps.push(traceWait('transport.primary: loading', image.url));
    } else if (image?.scheme === 'loading') {
      steps.push(traceWait('transport.primary: waiting for URL'));
    } else {
      steps.push(traceSkip('transport.primary', 'no resolved image URL'));
    }

    if (useBannerLayout) {
      if (backgroundImage) {
        const status = backgroundTransport?.src === backgroundImage ? backgroundTransport.status : 'loading';
        if (status === 'loaded') steps.push(traceHit('transport.background: decoded', backgroundImage));
        else if (status === 'failed') steps.push(traceMiss('transport.background: load failed', backgroundImage));
        else if (status === 'timeout') steps.push(traceMiss('transport.background: timeout after 20s', backgroundImage));
        else steps.push(traceWait('transport.background: loading', backgroundImage));
      } else {
        steps.push(traceSkip('transport.background', 'no resolved background URL'));
      }
    }

    return steps;
  }, [backgroundImage, backgroundTransport, debugSteps, image, primaryTransport, useBannerLayout]);

  const handleDebugToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setDebugOpen(open => !open);
  }, []);

  // Banner avatar fallback (timeout時 / ローディング中 / 画像なし)
  // Banner avatar content — what to show inside the circular avatar
  const avatarContent = image?.scheme === 'loading'
    ? <div style={{ ...styles.bannerAvatarPlaceholder, display: 'grid', placeItems: 'center' }}><ImagePending /></div>
    : image?.url
      ? (
        <button
          ref={zoomTriggerRef}
          type="button"
          aria-label={`Enlarge ${name || 'profile'} image`}
          title="Enlarge image"
          disabled={!canZoom}
          onClick={handleOpenZoom}
          style={{ ...styles.imageZoomTrigger, cursor: canZoom ? 'zoom-in' : 'default' }}
        >
          <ErrorImage
            src={image.url}
            style={styles.bannerAvatar}
            loading="eager"
            fetchPriority="high"
            pendingFallback={<ImagePending />}
            onStatusChange={handlePrimaryTransport}
            fallback={<div style={styles.bannerAvatarPlaceholder} />}
          />
        </button>
      )
      : <div style={styles.bannerAvatarPlaceholder} />;

  return createPortal(
    <>
    <div style={styles.overlay} onClick={onClose} aria-hidden={zoomOpen || undefined}>
      {/* uv-scroll: スクロールバーの有無でコンテンツ幅が変わり、
          読み込み前後で左に詰まるのを防ぐ（gutter 常時予約）。
          overlay は createPortal で document.body 直下に描画するため、
          タブ切り替え（opacity 合成レイヤー）の影響で黒い残像が残らない。 */}
      <div
        className="uv-scroll"
        style={styles.popup}
        role="dialog"
        aria-modal="true"
        aria-label={name ? `${name} details` : 'Details'}
        onClick={(e) => e.stopPropagation()}
      >

        {/* Close button — always on top */}
        <button autoFocus aria-label="Close details" style={styles.closeButton} onClick={onClose}>×</button>

        {/* ── Image area ──────────────────────────────────────
            useBannerLayout: always banner+avatar (Social).
              backgroundImage present → show image, absent → show gradient placeholder.
            Standard layout: fixed-height centered image box (Asset).
            Both layouts reserve a fixed height so the popup never shifts size.
        */}
        {useBannerLayout ? (
          <div style={styles.bannerWrapper}>
            <div style={{
              ...styles.bannerBackground,
              background: 'var(--color-state-resolving)',
            }}>
              {backgroundImage && (
                <ErrorImage
                  src={backgroundImage}
                  style={styles.bannerBgImg}
                  loading="eager"
                  fetchPriority="high"
                  pendingFallback={<ImagePending />}
                  onStatusChange={handleBackgroundTransport}
                />
              )}
            </div>
            <div style={{
              ...styles.bannerAvatarWrapper,
              background: 'var(--color-state-resolving)',
            }}>
              {avatarContent}
            </div>
          </div>
        ) : (
          <div style={styles.imageWrapper}>
            {image?.url
              ? (
                <button
                  ref={zoomTriggerRef}
                  type="button"
                  aria-label={`Enlarge ${name || 'asset'} image`}
                  title="Enlarge image"
                  disabled={!canZoom}
                  onClick={handleOpenZoom}
                  style={{ ...styles.imageZoomTrigger, cursor: canZoom ? 'zoom-in' : 'default' }}
                >
                  <ErrorImage
                    src={image.url}
                    style={styles.image}
                    loading="eager"
                    fetchPriority="high"
                    pendingFallback={<ImagePending />}
                    onStatusChange={handlePrimaryTransport}
                    fallback={<span style={styles.placeholderMark}>{(placeholderInitials || name || '·').charAt(0)}</span>}
                  />
                </button>
              )
              : isLoading || image?.scheme === 'loading'
                ? <ImagePending />
                : <span style={styles.placeholderMark}>{(placeholderInitials || name || '·').charAt(0)}</span>}
          </div>
        )}

        {/* Header — banner かどうかで top margin が変わるが、
            バナーのアバター(64px)が下方向に 28px はみ出すため固定値で補正。
            name / subLabel の有無で高さを変えない（minHeight で予約）。 */}
        <div style={{ ...styles.header, ...(useBannerLayout ? { marginTop: 36 } : {}) }}>
          {name
            ? <h3 style={styles.name}>{name}</h3>
            : isLoading
              ? <div className="skim" style={styles.nameSkim} />
              : <h3 style={styles.name}>&nbsp;</h3>}
          {subLabel
            ? <span style={styles.subLabel}>{subLabel}</span>
            : <span style={styles.subLabel}>&nbsp;</span>}
        </div>

        {onView && (
          <div style={styles.viewRow}>
            <button
              style={styles.viewButton}
              onClick={(e) => { e.stopPropagation(); onView(); }}
            >
              {viewLabel}
            </button>
          </div>
        )}

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

        {externalUrl && (
          <div style={{ marginBottom: 'var(--space-1)' }}>
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

        {isLoading && !description && (
          <div className="skim" style={styles.descSkim} />
        )}

        {!!(tags?.length) && (
          <div style={styles.tagsRow}>
            {tags.map((tag, i) => (
              <span key={i} style={styles.tag}>{tag}</span>
            ))}
          </div>
        )}

        {description && <p style={styles.description}>{description}</p>}

        {/* ── Links ───────────────────────────────────────── */}
        {!!(links?.length) && (
          <div style={{ marginBottom: 'var(--space-1)' }}>
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
          <div style={{ marginBottom: 'var(--space-1)' }}>
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
        {(renderedDebugSteps !== undefined || debugText !== undefined) && (
          <div style={debugStyles.container}>
            <button
              style={debugStyles.toggle}
              onClick={handleDebugToggle}
            >
              Debug: Image Resolution {debugOpen ? '▲' : '▼'}
            </button>
            {debugOpen && renderedDebugSteps !== undefined && (
              <div style={debugStyles.content}>
                {renderedDebugSteps.map((step, i) => (
                  <div key={i} style={debugStyles.stepRow}>
                    <span style={debugStyles.stepGlyph} data-status={step.status}>
                      {TRACE_GLYPH[step.status]}
                    </span>
                    <span style={debugStyles.stepLabel}>{step.label}</span>
                    {step.detail && (
                      <span style={debugStyles.stepDetail}>
                        {' '}
                        {step.detail}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {debugOpen && renderedDebugSteps === undefined && debugText !== undefined && (
              <div style={debugStyles.content}>{debugText}</div>
            )}
          </div>
        )}

      </div>
    </div>
    {zoomOpen && image?.url && (
      <div
        style={styles.lightboxOverlay}
        role="dialog"
        aria-modal="true"
        aria-label={`${name || 'Image'} enlarged image`}
        onClick={(event) => {
          if (event.target === event.currentTarget) handleCloseZoom();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return;
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>('button')?.focus();
        }}
      >
        <button
          type="button"
          autoFocus
          aria-label="Close enlarged image"
          style={styles.lightboxClose}
          onClick={handleCloseZoom}
        >
          ×
        </button>
        <img
          src={image.url}
          alt={name ? `${name} enlarged` : 'Enlarged image'}
          style={styles.lightboxImage}
          loading="eager"
          decoding="async"
          draggable={false}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
    )}
    </>,
    document.body,
  );
});

// ─── Styles ──────────────────────────────────────────────────

// ─── Styles ──────────────────────────────────────────────────
// popupIn keyframes は globals.css で定義済み。
// document.createElement('style') による注入は不要。

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    background: 'rgba(15, 20, 30, 0.42)', zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    // backdrop-filter は意図的に不使用: タブ切り替え時に合成レイヤー上に
    // 黒い残像が残る原因だった。半透明の塗りだけで十分に分離できる。
    animation: 'popupIn 0.15s ease',
  },
  popup: {
    background: 'var(--color-surface-input)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-popup)',
    maxWidth: '420px', width: '90%',
    height: '70vh',     // 固定高さでコンテンツロード時のサイズシフトを防ぐ
    overflowY: 'auto', overflowX: 'hidden',
    position: 'relative', padding: '12px',
    isolation: 'isolate',
    animation: 'popupIn 0.2s ease', transformOrigin: 'center',
    boxSizing: 'border-box',
  },
  closeButton: {
    position: 'absolute', top: '12px', right: '12px',
    background: 'none', border: 'none', fontSize: '1.5rem',
    cursor: 'pointer', color: 'var(--color-text-muted)', lineHeight: 1, zIndex: 3,
  },

  imageZoomTrigger: {
    width: '100%',
    height: '100%',
    padding: 0,
    border: 'none',
    borderRadius: 'inherit',
    background: 'var(--color-state-resolving)',
    display: 'block',
    minWidth: 0,
    minHeight: 0,
    boxSizing: 'border-box',
    overflow: 'hidden',
    appearance: 'none',
    opacity: 1,
  },

  lightboxOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 10000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '56px 16px 24px',
    boxSizing: 'border-box',
    background: 'rgba(7, 10, 16, 0.92)',
    cursor: 'zoom-out',
  },
  lightboxClose: {
    position: 'fixed',
    top: 14,
    right: 14,
    width: 34,
    height: 34,
    border: '1px solid rgba(255, 255, 255, 0.22)',
    borderRadius: 'var(--radius-full)',
    background: 'rgba(20, 25, 35, 0.78)',
    color: '#fff',
    fontSize: 22,
    lineHeight: 1,
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    cursor: 'pointer',
  },
  lightboxImage: {
    display: 'block',
    width: 'auto',
    height: 'auto',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100dvh - 80px)',
    objectFit: 'contain',
    borderRadius: 'var(--radius-md)',
    boxShadow: '0 18px 60px rgba(0, 0, 0, 0.45)',
    cursor: 'default',
    touchAction: 'pinch-zoom',
    userSelect: 'none',
  },

  // 標準画像エリア（Asset）— 固定高さでレイアウトシフトを防ぐ
  imageWrapper: {
    width: '100%', height: '160px',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden', marginBottom: 'var(--space-1)',
    display: 'flex', justifyContent: 'center', alignItems: 'center',
    background: 'var(--color-state-resolving)', flexShrink: 0,
  },
  image: { width: '100%', height: '100%', objectFit: 'contain' },
  nameSkim: { width: 120, height: 22, borderRadius: 'var(--radius-xs)' },
  descSkim: { width: '100%', height: 40, borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-1)', flexShrink: 0 },
  placeholderMark: { color: 'var(--accent)', fontSize: '1.4rem', fontWeight: 700 },

  // バナー＋アバターレイアウト（Social）
  bannerWrapper: {
    width: '100%', marginBottom: 'var(--space-1)', position: 'relative',
    isolation: 'isolate',
    borderRadius: 'var(--radius-xl)', overflow: 'visible',
  },
  // バナー背景（画像なし時）— トークン統一
  bannerBackground: {
    width: '100%', height: '100px',
    borderRadius: 'var(--radius-xl)',
    overflow: 'hidden', position: 'relative',
    zIndex: 0,
  },
  bannerBgImg: {
    width: '100%', height: '100%',
    objectFit: 'cover', objectPosition: 'center',
    display: 'block',
  },
  bannerAvatarWrapper: {
    position: 'absolute', bottom: '-28px', left: '16px',
    width: '64px', height: '64px',
    borderRadius: 'var(--radius-full)',
    border: '3px solid var(--color-surface-input)',
    boxSizing: 'border-box',
    overflow: 'hidden',
    background: 'var(--color-surface-muted)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: 'var(--shadow-avatar)',
    zIndex: 2,
  },
  bannerAvatar: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' },
  bannerAvatarPlaceholder: { width: '100%', height: '100%', borderRadius: 'inherit', background: 'var(--color-state-resolving)' },

  // ヘッダー — name/subLabel の有無で高さが変わらないよう固定行高を予約。
  // name 行: 23px (18px font), subLabel 行: 17px (12px font)。
  header: { marginBottom: 'var(--space-1)', marginTop: 0 },
  name: {
    fontSize: 'var(--text-xl)', fontWeight: 700,
    color: 'var(--color-text-primary)', margin: 0,
    lineHeight: '23px', minHeight: 23,
    wordBreak: 'break-word',
  },
  subLabel: {
    display: 'block',
    fontSize: 'var(--text-sm)', color: 'var(--color-text-muted)', fontWeight: 500,
    lineHeight: '17px', minHeight: 17,
    fontFamily: 'var(--font-stack-mono)',
  },

  // タグ
  tagsRow: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)', marginBottom: 'var(--space-1)' },
  tag: {
    fontSize: 'var(--text-sm)', padding: '2px 8px',
    background: 'var(--color-surface-tag)',
    borderRadius: 'var(--radius-full)',
    color: 'var(--color-text-tag)', fontWeight: '500',
  },

  // 説明文
  description: {
    fontSize: 'var(--text-md)', color: 'var(--color-text-secondary)', lineHeight: 1.5,
    margin: '0 0 var(--space-1) 0', wordBreak: 'break-word', whiteSpace: 'pre-wrap',
  },

  // Stats グリッド
  statsGrid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-1)', marginBottom: 'var(--space-1)',
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
  viewRow: {
    marginBottom: 'var(--space-1)',
  },
  viewButton: {
    padding: '4px 12px',
    border: 'none',
    borderRadius: 'var(--radius-md)',
    background: 'transparent',
    color: 'var(--accent)',
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
    marginTop: 'var(--space-1)', fontSize: '0.58rem', color: 'var(--color-text-muted)',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid var(--color-border-debug)`, overflow: 'hidden',
  },
  toggle: {
    width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
    padding: '4px var(--space-1)',
    background: 'var(--color-surface-debug)',
    fontWeight: 600, fontSize: 'var(--text-xs)',
    color: 'var(--color-text-debug)', userSelect: 'none',
  },
  content: {
    padding: '6px var(--space-1)',
    background: 'var(--color-surface-debug-body)',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    lineHeight: '1.4', color: 'var(--color-text-debug-val)',
    fontFamily: 'monospace', fontSize: '0.58rem',
  },
  stepRow: {
    display: 'flex', alignItems: 'baseline', gap: '4px',
    padding: '1px 0',
  },
  stepGlyph: { flexShrink: 0, width: '1.2em' },
  stepLabel: { flexShrink: 0, fontWeight: 600 },
  stepDetail: { color: 'var(--color-text-faint)', wordBreak: 'break-all' },
};
