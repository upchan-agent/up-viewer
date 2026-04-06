'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useProfile } from '@lsp-indexer/react';
import { toGatewayUrl } from '@/lib/utils';

const getProfileImageUrl = (profile: { profileImage?: { url: string }[] | null } | null): string | undefined => {
  if (!profile?.profileImage?.[0]?.url) return undefined;
  return toGatewayUrl(profile.profileImage[0].url);
};

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
    accounts,
    provider,
    isDetecting,
  } = useUpProvider();

  const activeAddress = propAddress || displayAddress;

  const { profile, isLoading: isProfileLoading } = useProfile({
    address: activeAddress || '',
  });

  const handleSwitch = async () => {
    if (!provider) return;
    try {
      await provider.request({ method: 'eth_requestAccounts' });
    } catch (error) {
      console.error('Failed to switch account:', error);
    }
  };

  const hasProfile = activeAddress && !isProfileLoading && profile;
  const name = profile?.name || 'Unknown';
  const initials = name.charAt(0).toUpperCase();
  const profileImageUrl = getProfileImageUrl(profile);

  return (
    <div style={styles.card}>
      {/* Connection Status Section */}
      <div style={styles.connectionSection}>
        {/* View Mode State */}
        {isViewMode && onExitViewMode && (
          <div style={styles.viewModeRow}>
            <span style={styles.viewModeIcon}>👁️</span>
            <span style={styles.viewModeText}>View mode</span>
            <button onClick={onExitViewMode} style={styles.exitButton}>
              Exit
            </button>
            {onToggleSearch && (
              <button onClick={onToggleSearch} style={styles.searchButton}>
                🔍
              </button>
            )}
          </div>
        )}

        {/* Normal states (when not in view mode) */}
        {!isViewMode && (
          <>
            {isDetecting && (
              <div style={styles.skeletonRow}>
                <div style={styles.skeletonIcon} />
                <div style={styles.skeletonText} />
              </div>
            )}

            {viewMode === 'wallet' && (
              <div style={styles.connectedRow}>
                <span style={styles.connectedIcon}>🟢</span>
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
              <div style={styles.viewingRow}>
                <span style={styles.viewingIcon}>👀</span>
                <span style={styles.viewingText}>Viewing via Grid</span>
              </div>
            )}

            {!isDetecting && viewMode === 'none' && isMiniApp === false && (
              <div style={styles.disconnectedRow}>
                <span style={styles.disconnectedIcon}>🔌</span>
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
      </div>

      {/* Profile Section */}
      {!activeAddress ? (
        <div style={styles.placeholderSection}>
          <span style={styles.placeholderIcon}>👤</span>
          <p style={styles.placeholderText}>No profile connected</p>
        </div>
      ) : !hasProfile ? (
        <div style={styles.placeholderSection}>
          <span style={styles.placeholderIcon}>👤</span>
          <p style={styles.placeholderText}>Loading profile...</p>
        </div>
      ) : (
        <div style={styles.profileSection}>
          {profileImageUrl ? (
            <img src={profileImageUrl} alt={name} style={styles.avatar} />
          ) : (
            <div style={styles.avatarPlaceholder}>{initials}</div>
          )}
          <div style={styles.info}>
            <h2 style={styles.name}>{name}</h2>
            <p style={styles.address}>{activeAddress}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  card: {
    padding: '8px',
    background: 'rgba(255, 255, 255, 0.95)',
    borderRadius: '16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
  },
  connectionSection: {
    marginBottom: '8px',
    height: '20px',
    position: 'relative',
  },
  /* ─── View Mode ─── */
  viewModeRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '20px',
  },
  viewModeIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  viewModeText: {
    fontSize: '0.75rem',
    color: '#3182ce',
    fontWeight: '600',
    whiteSpace: 'nowrap',
  },
  exitButton: {
    marginLeft: 'auto',
    padding: '2px 8px',
    background: '#fed7d7',
    border: 'none',
    borderRadius: '6px',
    color: '#e53e3e',
    fontSize: '0.7rem',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
  },
  searchButton: {
    padding: '2px 6px',
    background: '#f7fafc',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.85rem',
    cursor: 'pointer',
    flexShrink: 0,
  },
  /* ─── Skeleton ─── */
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minHeight: '20px',
  },
  skeletonIcon: {
    width: '16px',
    height: '16px',
    borderRadius: '50%',
    background: 'linear-gradient(90deg, #e0e0e0 25%, #d0d0d0 50%, #e0e0e0 75%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 1.5s infinite',
    flexShrink: 0,
  },
  skeletonText: {
    width: '120px',
    height: '12px',
    borderRadius: '4px',
    background: 'linear-gradient(90deg, #e0e0e0 25%, #d0d0d0 50%, #e0e0e0 75%)',
    backgroundSize: '200% 100%',
    animation: 'shimmer 1.5s infinite',
  },
  /* ─── Connected ─── */
  connectedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '20px',
  },
  connectedIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  connectedText: {
    fontSize: '0.75rem',
    color: '#48bb78',
    fontWeight: '600',
    whiteSpace: 'nowrap',
  },
  switchButton: {
    marginLeft: 'auto',
    padding: '4px 10px',
    background: '#e2e8f0',
    border: 'none',
    borderRadius: '6px',
    color: '#4a5568',
    fontSize: '0.7rem',
    fontWeight: '600',
    cursor: 'pointer',
    flexShrink: 0,
  },
  /* ─── Grid ─── */
  viewingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '20px',
  },
  viewingIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  viewingText: {
    fontSize: '0.75rem',
    color: '#805ad5',
    fontWeight: '600',
    whiteSpace: 'nowrap',
  },
  /* ─── Disconnected ─── */
  disconnectedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '20px',
  },
  disconnectedIcon: {
    fontSize: '0.9rem',
    flexShrink: 0,
  },
  disconnectedText: {
    fontSize: '0.75rem',
    color: '#718096',
    whiteSpace: 'nowrap',
  },
  connectButton: {
    marginLeft: 'auto',
    padding: '4px 12px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    border: 'none',
    borderRadius: '6px',
    color: '#ffffff',
    fontSize: '0.7rem',
    fontWeight: '700',
    cursor: 'pointer',
    flexShrink: 0,
  },
  connectButtonDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  /* ─── Profile ─── */
  placeholderSection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    minHeight: '56px',
  },
  placeholderIcon: {
    fontSize: '1.5rem',
  },
  placeholderText: {
    margin: 0,
    fontSize: '0.75rem',
    color: '#a0aec0',
  },
  profileSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    minHeight: '56px',
  },
  avatar: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    objectFit: 'cover',
  },
  avatarPlaceholder: {
    width: '56px',
    height: '56px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.5rem',
    fontWeight: 'bold',
    color: '#ffffff',
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    margin: '0 0 2px 0',
    fontSize: '0.85rem',
    fontWeight: '700',
    color: '#1a202c',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  address: {
    margin: 0,
    fontSize: '0.7rem',
    color: '#718096',
    fontFamily: 'monospace',
    wordBreak: 'break-all',
  },
};
