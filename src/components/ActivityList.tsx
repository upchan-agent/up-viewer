'use client';

import { useUpProvider } from '@/lib/up-provider';

interface ActivityListProps {
  address?: `0x${string}`;
}

export function ActivityList({ address: _address }: ActivityListProps) {
  const { displayAddress } = useUpProvider();

  const showPlaceholder = !displayAddress;

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
    padding: '8px',
    background: 'rgba(255, 255, 255, 0.95)',
    borderRadius: '16px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.1)',
  },
  title: {
    margin: '0 0 8px 0',
    fontSize: '1rem',
    fontWeight: '700',
    color: '#1a202c',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    maxHeight: '450px',
    overflowY: 'auto',
  },
  empty: {
    margin: 0,
    padding: '16px',
    textAlign: 'center',
    color: '#a0aec0',
    fontSize: '0.85rem',
  },
};
