'use client';

import { useUpProvider } from '@/lib/up-provider';

interface ActivityListProps {
  address?: `0x${string}`;
  active?: boolean;  // 将来のフェッチ制御用（現在は未使用）
}

export function ActivityList({ address, active: _active = true }: ActivityListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress  = address || displayAddress;
  const showPlaceholder = !targetAddress;

  return (
    <div style={styles.card}>
      <h3 style={styles.title}>⚡ Activity</h3>
      {showPlaceholder ? (
        <p style={styles.empty}>🔌</p>
      ) : (
        <div style={styles.list}>
          <p style={styles.empty}>Coming soon...</p>
        </div>
      )}
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  card: {
    padding: 'var(--card-padding)',
    background: 'var(--color-surface-card)',
    borderRadius: 'var(--radius-2xl)',
    boxShadow: 'var(--shadow-card)',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  title: {
    margin: '0 0 var(--space-2) 0',
    fontSize: 'var(--text-lg)',
    fontWeight: '700',
    color: 'var(--color-text-primary)',
    flexShrink: 0,
  },
  list: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    overflowY: 'auto',
    minHeight: 0,
  },
  empty: {
    margin: 0,
    padding: 'var(--space-4)',
    textAlign: 'center',
    color: 'var(--color-text-faint)',
    fontSize: 'var(--text-md)',
  },
};
