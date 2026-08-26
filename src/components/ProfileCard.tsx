'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useProfile } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { LUKSO_EXPLORER_URL } from '@/lib/constants';
import { useResolvedProfileImage } from '@/lib/profile-image-cache';
import { ErrorImage } from '@/components/ErrorImage';

// ─── Layout stability ────────────────────────────────────────
// 接続状態の遷移（Detecting → Connected / Viewing / Connect button）で
// このカードの高さが変わると、下のタブ・リスト全体がずれる。
// そのため identity 領域は「常に同じ高さの2行」を予約する:
//   Row 1: 名前（またはスケルトン）     — 常に 21px
//   Row 2: アドレス / Connect ボタン    — 常に minHeight 18px
// スケルトン・空状態も同じボックスを描画するため、遷移時のシフトはゼロ。

const NAME_ROW_HEIGHT = 21;   // fontSize 18 × lineHeight
const ADDR_ROW_HEIGHT = 18;   // fontSize 11 mono / 13 button が収まる高さ

export function ProfileCard({
  address: propAddress,
  isViewMode,
  onExitViewMode,
  onToggleSearch,
}: {
  address?: string;
  isViewMode?: boolean;
  onExitViewMode?: () => void;
  onToggleSearch?: () => void;
}) {
  const {
    displayAddress,
    isMiniApp,
    isConnecting,
    connect,
    viewMode,
    provider,
    isDetecting,
  } = useUpProvider();

  const activeAddress = propAddress || displayAddress;

  const { profile, isLoading: isProfileLoading } = useProfile({
    address: activeAddress || '',
  });

  const indexerProfileUrl = toGatewayUrl(profile?.profileImage?.[0]?.url ?? '') ?? undefined;
  const indexerBgUrl      = toGatewayUrl(profile?.backgroundImage?.[0]?.url ?? '') ?? undefined;
  const indexerAvatarUrl  = toGatewayUrl(profile?.avatar?.[0]?.url ?? '') ?? undefined;

  const resolved = useResolvedProfileImage({
    address: activeAddress || '',
    indexerImageUrl: indexerProfileUrl,
    indexerBackgroundImageUrl: indexerBgUrl,
    indexerAvatarUrl,
  });

  const profileImageUrl    = resolved?.profileImageUrl ?? undefined;
  const backgroundImageUrl = resolved?.backgroundImageUrl ?? undefined;

  const handleSwitch = async () => {
    if (!provider) return;
    try {
      await provider.request({ method: 'eth_requestAccounts' });
    } catch (error) {
      console.error('Failed to switch account:', error);
    }
  };

  const hasProfile = !!(activeAddress && !isProfileLoading && profile);
  const name       = profile?.name || (activeAddress ? 'Unknown' : 'No profile connected');
  const initials   = name.charAt(0).toUpperCase();
  const isLoading  = isProfileLoading || resolved === undefined;

  const chipLabel = isViewMode
    ? 'Viewing'
    : isDetecting
      ? null
      : viewMode === 'wallet'
        ? (isMiniApp ? 'Connected via Grid' : 'Connected')
        : viewMode === 'grid'
          ? 'Viewing via Grid'
          : null;

  // Row 2 content — every variant renders inside the same fixed-height box
  let row2: React.ReactNode = null;
  if (activeAddress) {
    row2 = (
      <a
        href={`${LUKSO_EXPLORER_URL}/address/${activeAddress}`}
        target="_blank"
        rel="noopener noreferrer"
        style={styles.addr}
      >
        {activeAddress}
      </a>
    );
  } else if (viewMode === 'none' && isMiniApp === false) {
    row2 = (
      <button
        onClick={connect}
        disabled={isConnecting}
        style={styles.connect}
      >
        {isConnecting ? 'Connecting…' : 'Connect'}
      </button>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.bannerWrap}>
        {backgroundImageUrl ? (
          <ErrorImage
            src={backgroundImageUrl}
            style={styles.bannerImg}
            onLoad={(e) => { (e.target as HTMLImageElement).style.opacity = '1'; }}
          />
        ) : (
          <div style={styles.bannerFallback} />
        )}
        <div style={styles.bannerFade} />
      </div>
      <div style={styles.bannerBar}>
          {isDetecting && !isViewMode ? (
            <div className="skim" style={styles.chipSkim} />
          ) : chipLabel ? (
            <span style={styles.chip}>{chipLabel}</span>
          ) : (
            <span style={styles.chipSpacer} />
          )}
          <div style={styles.bannerActions}>
            {viewMode === 'wallet' && !isMiniApp && !isViewMode && (
              <button onClick={handleSwitch} style={styles.chipButton}>Switch</button>
            )}
            {onToggleSearch && (
              <button onClick={onToggleSearch} style={styles.chipButton} aria-label="Search UP">
                Search
              </button>
            )}
            {isViewMode && onExitViewMode && (
              <button onClick={onExitViewMode} style={styles.chipButton} aria-label="Exit view mode">
                Exit
              </button>
            )}
          </div>
      </div>

      <div style={styles.identity}>
        {isLoading && activeAddress ? (
          <div className="skim" style={styles.avatar} />
        ) : profileImageUrl ? (
          <ErrorImage
            src={profileImageUrl}
            alt={name}
            style={styles.avatar}
            fallback={<div style={styles.avatarFallback}>{initials}</div>}
          />
        ) : (
          <div style={styles.avatarFallback}>{activeAddress ? initials : ''}</div>
        )}
        <div style={styles.who}>
          {/* Row 1 — name / skeleton: always the same height */}
          <div style={styles.nameRow}>
            {isLoading && activeAddress ? (
              <div className="skim" style={styles.nameSkim} />
            ) : (
              <h1 style={styles.name} title={name}>{name}</h1>
            )}
          </div>
          {/* Row 2 — address / connect: always reserved */}
          <div style={styles.addrRow}>{row2}</div>
        </div>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  root: {
    position: 'relative',
    flexShrink: 0,
    overflow: 'visible',
  },
  bannerWrap: {
    position: 'relative',
    height: 96,
    overflow: 'hidden',
    background: '#c5cedb',
    zIndex: 0,
  },
  bannerImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center',
    display: 'block',
    opacity: 0,
    transition: 'opacity var(--transition-normal)',
  },
  bannerFallback: {
    width: '100%',
    height: '100%',
    background: '#c5cedb',
  },
  bannerFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 24,
    background: 'linear-gradient(to bottom, transparent, var(--paper))',
    pointerEvents: 'none',
  },
  bannerBar: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    zIndex: 3,
    pointerEvents: 'auto',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chip: {
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 999,
    height: 24,
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    background: 'var(--chip)',
    color: '#f4f7fb',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
  },
  chipSkim: {
    width: 88,
    height: 24,
    borderRadius: 999,
  },
  chipSpacer: {
    height: 24,
    display: 'inline-block',
  },
  bannerActions: {
    display: 'flex',
    gap: 6,
  },
  chipButton: {
    fontSize: 11,
    fontWeight: 600,
    border: 0,
    borderRadius: 999,
    height: 24,
    padding: '0 10px',
    display: 'inline-flex',
    alignItems: 'center',
    background: 'var(--chip)',
    color: '#f4f7fb',
    cursor: 'pointer',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
  },
  identity: {
    display: 'flex',
    gap: 14,
    alignItems: 'flex-end',
    padding: '0 16px 8px',
    position: 'relative',
    zIndex: 1,
  },
  avatar: {
    width: 'var(--avatar-size-lg)',
    height: 'var(--avatar-size-lg)',
    borderRadius: '50%',
    border: '3px solid var(--paper)',
    objectFit: 'cover',
    flexShrink: 0,
    marginTop: -20,
    background: 'var(--accent-soft)',
  },
  avatarFallback: {
    width: 'var(--avatar-size-lg)',
    height: 'var(--avatar-size-lg)',
    borderRadius: '50%',
    border: '3px solid var(--paper)',
    flexShrink: 0,
    marginTop: -20,
    background: 'var(--accent-soft)',
    color: 'var(--accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 18,
    fontWeight: 700,
  },
  who: {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  // Row 1: fixed height — name, skeleton, or empty-state label all render here
  nameRow: {
    height: NAME_ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  },
  nameSkim: {
    width: 132,
    height: 16,
    borderRadius: 4,
  },
  name: {
    margin: 0,
    fontSize: 'var(--text-xl)',
    fontWeight: 650,
    lineHeight: `${NAME_ROW_HEIGHT}px`,
    color: 'var(--ink)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  },
  // Row 2: fixed minimum height — address link / Connect button / empty
  addrRow: {
    minHeight: ADDR_ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
  },
  addr: {
    display: 'block',
    margin: 0,
    fontSize: 'var(--text-xs)',
    color: 'var(--mute)',
    fontVariantNumeric: 'tabular-nums',
    fontFamily: 'var(--font-stack-mono)',
    wordBreak: 'break-all',
    lineHeight: `${ADDR_ROW_HEIGHT}px`,
    textDecoration: 'none',
  },
  connect: {
    margin: 0,
    border: 0,
    background: 'transparent',
    color: 'var(--accent)',
    fontSize: 'var(--text-base)',
    fontWeight: 650,
    height: ADDR_ROW_HEIGHT,
    lineHeight: `${ADDR_ROW_HEIGHT}px`,
    padding: 0,
    cursor: 'pointer',
  },
};
