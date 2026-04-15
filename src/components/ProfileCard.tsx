'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useProfile } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';
import { useResolvedProfileImage } from '@/lib/profile-image-cache';
import { useState, useEffect, useRef } from 'react';
import { ErrorImage } from '@/components/ErrorImage';

// ── document.createElement('style') は globals.css に集約済み ──
// shimmer / pulse keyframes は globals.css で定義。
// .skim クラスをスケルトン要素に付与する。

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

  // ── 画像解決（Priority: indexer → erc725 → avatar）──
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

  const hasProfile = activeAddress && !isProfileLoading && profile;
  const name       = profile?.name || 'Unknown';
  const initials   = name.charAt(0).toUpperCase();
  const isLoading  = isProfileLoading || resolved === undefined;

  return (
    <div style={styles.card}>
      {/* 背景画像 — absolute で位置取りし、カードサイズに影響しない */}
      {!isLoading && backgroundImageUrl && (
        <div style={styles.bgWrapper}>
          <ErrorImage
            src={backgroundImageUrl}
            style={styles.bgImg}
            onLoad={(e) => { (e.target as HTMLImageElement).style.opacity = '1'; }}
          />
        </div>
      )}

      {/* ── 接続バー ──────────────────────────────────────────
          固定高さ（--conn-bar-height）で常にスペースを確保する。
          コンテンツの有無でカードが伸縮しないよう height を固定。  */}
      <div style={styles.connectionSection}>

        {/* View Mode */}
        {isViewMode && onExitViewMode && (
          <div style={styles.viewModeRow}>
            <span style={styles.connIcon}>👀</span>
            <span style={styles.viewModeText}>View mode</span>
          </div>
        )}
        {isViewMode && onExitViewMode && (
          <button
            onClick={onExitViewMode}
            style={styles.exitButton}
            aria-label="Exit view mode"
          >
            Exit
          </button>
        )}

        {/* 通常状態（View Mode 時は非表示）*/}
        {!isViewMode && (
          <>
            {isDetecting && (
              <div style={styles.connRow}>
                {/* .skim クラスで shimmer アニメーション（globals.css 定義）*/}
                <div className="skim" style={styles.skeletonIcon} />
                <div className="skim" style={styles.skeletonText} />
              </div>
            )}

            {viewMode === 'wallet' && (
              <div style={styles.connRow}>
                <span style={styles.connIcon}>🟢</span>
                <span style={styles.connectedText}>
                  {isMiniApp ? 'Connected via Grid' : 'Connected'}
                </span>
                {!isMiniApp && (
                  <button onClick={handleSwitch} style={styles.switchButton}>
                    Switch
                  </button>
                )}
              </div>
            )}

            {viewMode === 'grid' && (
              <div style={styles.connRow}>
                <span style={styles.connIcon}>👀</span>
                <span style={styles.viewingText}>Viewing via Grid</span>
              </div>
            )}

            {!isDetecting && viewMode === 'none' && isMiniApp === false && (
              <div style={styles.connRow}>
                <span style={styles.connIcon}>🔌</span>
                <span style={styles.disconnectedText}>Not connected</span>
                <button
                  onClick={connect}
                  disabled={isConnecting}
                  style={{
                    ...styles.connectButton,
                    ...(isConnecting ? styles.connectButtonDisabled : {}),
                  }}
                >
                  {isConnecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            )}
          </>
        )}

        {/* 🔍 検索ボタン — 常時表示 */}
        {onToggleSearch && (
          <button
            onClick={onToggleSearch}
            style={styles.searchButton}
            aria-label="Search UP"
          >
            🔍
          </button>
        )}
      </div>

      {/* ── プロフィールセクション ──────────────────────────────
          height を固定して、ロード中・未接続・接続済みすべての
          状態でカード高さが変わらないようにする。
          placeholderSection も同じ height を持ち、overflow:hidden
          でコンテンツがはみ出さないようにする。               */}
      <div style={
        hasProfile
          ? styles.profileSection
          : styles.placeholderSection
      }>
        {!activeAddress ? (
          <>
            <span style={styles.placeholderIcon}>👤</span>
            <p style={styles.placeholderText}>No profile connected</p>
          </>
        ) : !hasProfile ? (
          <>
            <span style={styles.placeholderIcon}>👤</span>
            <p style={styles.placeholderText}>Loading profile...</p>
          </>
        ) : (
          <>
            {isLoading ? (
              <div style={styles.avatarPlaceholder}>
                <span style={styles.loadingSpinner}>⏳</span>
              </div>
            ) : profileImageUrl ? (
              <ErrorImage
                src={profileImageUrl}
                alt={name}
                style={styles.avatar}
                fallback={<div style={styles.avatarPlaceholder}>{initials}</div>}
              />
            ) : (
              <div style={styles.avatarPlaceholder}>{initials}</div>
            )}
            <div style={styles.info}>
              <h2 style={styles.name}>{name}</h2>
              <p style={styles.address}>{activeAddress}</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────
// CSS 変数を参照。ハードコード値は globals.css に定義済み。

const styles: { [key: string]: React.CSSProperties } = {
  // ── カード ──
  card: {
    padding: 'var(--card-padding)',
    background: 'var(--color-surface-card)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-card)',
    position: 'relative',
    overflow: 'hidden',
    flexShrink: 0,  // content (flex column) の中で縮ませない
  },

  // ── 背景画像 ──
  bgWrapper: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: '100%',
    overflow: 'hidden',
    borderRadius: 'var(--radius-2xl)',
    zIndex: 0,
  },
  bgImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center',
    opacity: 0,
    transition: `opacity var(--transition-normal)`,
  },

  // ── 接続バー ──
  // height を固定することで、コンテンツが変わってもカードが伸縮しない
  connectionSection: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    alignItems: 'center',
    height: 'var(--conn-bar-height)',  // ← 固定高さ（旧: minHeight: '18px'）
    overflow: 'hidden',
  },

  // 各状態の行（高さは connectionSection に依存）
  connRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    flex: 1,
    overflow: 'hidden',
  },
  viewModeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    flex: 1,
    overflow: 'hidden',
  },

  // アイコン（絵文字サイズを明示）
  connIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
    lineHeight: 1,
  },

  // テキスト各種
  viewModeText: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-viewmode)',
    fontWeight: '600',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  connectedText: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-connected)',
    fontWeight: '600',
    whiteSpace: 'nowrap',
  },
  viewingText: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-viewing)',
    fontWeight: '600',
    whiteSpace: 'nowrap',
  },
  disconnectedText: {
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-muted)',
    whiteSpace: 'nowrap',
  },

  // ── スケルトン ──
  skeletonIcon: {
    width: 'var(--avatar-size-sm)',
    height: 'var(--avatar-size-sm)',
    borderRadius: 'var(--radius-full)',
    flexShrink: 0,
  },
  skeletonText: {
    width: '120px',
    height: '12px',
    borderRadius: 'var(--radius-xs)',
  },

  // ── ボタン群 ──
  exitButton: {
    position: 'absolute',
    right: 'var(--space-1)',
    top: 0,
    height: 'var(--conn-bar-height)',
    display: 'flex',
    alignItems: 'center',
    padding: '0 var(--space-1)',
    background: 'var(--color-surface-danger-light)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-danger)',
    fontSize: 'var(--text-xs)',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
    zIndex: 2,
    boxSizing: 'border-box',
  },
  searchButton: {
    position: 'absolute',
    right: 'var(--space-1)',
    top: 0,
    width: '28px',
    height: 'var(--conn-bar-height)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    background: 'rgba(255,255,255,0.8)',
    border: `1px solid var(--color-border-default)`,
    borderRadius: 'var(--radius-sm)',
    fontSize: '0.85rem',
    cursor: 'pointer',
    flexShrink: 0,
    zIndex: 2,
    boxSizing: 'border-box',
  },
  switchButton: {
    marginLeft: 'auto',
    marginRight: '34px',
    height: 'var(--conn-bar-height)',
    display: 'flex',
    alignItems: 'center',
    padding: '2px var(--space-2)',
    background: 'var(--color-border-default)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-secondary)',
    fontSize: 'var(--text-xs)',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
    boxSizing: 'border-box',
  },
  connectButton: {
    marginRight: '34px',
    height: 'var(--conn-bar-height)',
    display: 'flex',
    alignItems: 'center',
    padding: '2px var(--space-3)',
    background: 'var(--gradient-brand)',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--color-text-white)',
    fontSize: 'var(--text-xs)',
    fontWeight: '700',
    cursor: 'pointer',
    flexShrink: 0,
    boxSizing: 'border-box',
  },
  connectButtonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },

  // ── プロフィールセクション（共通ベース） ──
  // height 固定 + overflow:hidden で、どの状態でもカード高さが変わらない。
  // flex row で左にアバター（またはアイコン）、右にテキストを並べる。
  // これにより placeholder と profile で同じ高さになる。
  placeholderSection: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'var(--space-3)',
    height: 'var(--profile-section-height)',
    overflow: 'hidden',
    position: 'relative',
    zIndex: 1,
    paddingTop: 'var(--space-1)',
  },
  placeholderIcon: {
    fontSize: '1.5rem',
    flexShrink: 0,
    width: 'var(--avatar-size-lg)',  // avatar と同幅でアライン揃え
    textAlign: 'center',
  },
  placeholderText: {
    margin: 0,
    fontSize: 'var(--text-base)',
    color: 'var(--color-text-faint)',
  },

  profileSection: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'var(--space-3)',
    height: 'var(--profile-section-height)',
    overflow: 'hidden',
    position: 'relative',
    zIndex: 1,
    paddingTop: 'var(--space-1)',
  },

  // ── アバター ──
  avatar: {
    width: 'var(--avatar-size-lg)',
    height: 'var(--avatar-size-lg)',
    borderRadius: 'var(--radius-full)',
    objectFit: 'cover',
    border: '3px solid rgba(255,255,255,0.8)',
    boxShadow: 'var(--shadow-avatar)',
    flexShrink: 0,
  },
  avatarPlaceholder: {
    width: 'var(--avatar-size-lg)',
    height: 'var(--avatar-size-lg)',
    borderRadius: 'var(--radius-full)',
    background: 'var(--gradient-brand)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: 'var(--color-text-white)',
    border: '3px solid rgba(255,255,255,0.3)',
    flexShrink: 0,
  },
  loadingSpinner: {
    fontSize: '1.2rem',
    // pulse アニメーションは globals.css @keyframes pulse で定義
    animation: 'pulse 1.5s ease-in-out infinite',
  },

  // ── テキスト情報 ──
  info: { flex: 1, minWidth: 0 },
  name: {
    margin: '0 0 2px 0',
    fontSize: 'var(--text-md)',
    fontWeight: '700',
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  address: {
    margin: 0,
    fontSize: 'var(--text-sm)',
    color: 'var(--color-text-muted)',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
};
