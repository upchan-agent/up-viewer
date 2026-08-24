'use client';

import { useUpProvider } from '@/lib/up-provider';

interface ActivityListProps {
  address?: `0x${string}`;
  active?: boolean;
}

export function ActivityList({ address, active: _active = true }: ActivityListProps) {
  const { displayAddress } = useUpProvider();
  const targetAddress  = address || displayAddress;
  const showPlaceholder = !targetAddress;

  return (
    <div style={styles.card}>
      {showPlaceholder ? (
        <p style={styles.empty}>No profile connected</p>
      ) : (
        <div style={styles.list}>
          <p style={styles.empty}>Coming soon</p>
        </div>
      )}
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  card: {
    padding: '8px 16px 0',
    background: 'transparent',
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
  },
  list: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
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
