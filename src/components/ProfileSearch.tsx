'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

const ENVIO_MAINNET_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

const GQL_QUERY = `
  query MyQuery($id: String!) {
    search_profiles(args: { search: $id }) {
      name
      fullName
      id
      profileImages(
        where: { error: { _is_null: true } }
        order_by: { width: asc }
      ) {
        width
        src
        url
        verified
      }
    }
  }
`;

type Profile = {
  name?: string;
  id: string;
  fullName?: string;
  profileImages?: {
    width: number;
    src: string;
    url: string;
    verified: boolean;
  }[];
};

interface ProfileSearchProps {
  onSelect: (address: `0x${string}`) => void;
  onCancel: () => void;
}

export function ProfileSearch({ onSelect, onCancel }: ProfileSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.length < 3) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(ENVIO_MAINNET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GQL_QUERY, variables: { id: searchQuery.toLowerCase() } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data: Profile[] = json.data?.search_profiles ?? [];
      setResults(data);
      setShowDropdown(data.length > 0);
    } catch {
      setResults([]);
      setShowDropdown(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (val.length < 3) {
        setResults([]);
        setShowDropdown(false);
        return;
      }

      // Check if it looks like an address (0x + hex)
      const looksLikeAddress = /^0x[0-9a-f]{5,}/i.test(val);

      if (looksLikeAddress) {
        // Address paste — wait a bit for the full paste, then search immediately
        debounceRef.current = setTimeout(() => doSearch(val), 400);
      } else if (val.length === 3) {
        // Exactly 3 chars — auto search immediately
        doSearch(val);
      } else {
        // >3 chars, not an address — debounce 800ms then search
        debounceRef.current = setTimeout(() => doSearch(val), 800);
      }
    },
    [doSearch]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        doSearch(query);
      }
    },
    [doSearch, query]
  );

  const handleSelect = useCallback(
    (profile: Profile) => {
      onSelect(profile.id as `0x${string}`);
    },
    [onSelect]
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-search-root]')) setShowDropdown(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  return (
    <div data-search-root style={styles.root}>
      <div style={styles.inputRow}>
        <input
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="🔍 Enter 3 chars or paste address..."
          style={styles.input}
          disabled={loading}
          autoFocus
        />
        <button onClick={onCancel} style={styles.cancelButton}>
          ✕
        </button>
      </div>

      {showDropdown && results.length > 0 && (
        <div style={styles.dropdown}>
          {results.map((r) => (
            <button key={r.id} style={styles.resultItem} onClick={() => handleSelect(r)}>
              <div style={styles.resultAvatar}>
                {r.profileImages?.[0]?.src ? (
                  <img src={r.profileImages[0].src} alt="" style={styles.resultAvatarImg} />
                ) : (
                  <span style={styles.resultAvatarFallback}>👤</span>
                )}
              </div>
              <div style={styles.resultInfo}>
                {r.fullName && <div style={styles.resultName}>{r.fullName}</div>}
                {r.name && <div style={styles.resultUpName}>{r.name}</div>}
                <div style={styles.resultAddress}>{r.id.slice(0, 6)}...{r.id.slice(-4)}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      {loading && <div style={styles.loading}>⏳ Searching...</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
    // No marginBottom — container gap handles it
  },
  inputRow: {
    display: 'flex',
    gap: '6px',
  },
  input: {
    flex: 1,
    padding: '10px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: '10px',
    fontSize: '14px',
    outline: 'none',
    background: '#fff',
  },
  cancelButton: {
    padding: '8px 12px',
    border: 'none',
    borderRadius: '10px',
    background: '#f7fafc',
    color: '#718096',
    fontSize: '1rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: '4px',
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: '12px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
    zIndex: 100,
    maxHeight: '220px',
    overflow: 'auto',
  },
  resultItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    padding: '10px 12px',
    border: 'none',
    borderBottom: '1px solid #f7fafc',
    background: '#fff',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.1s',
  },
  resultAvatar: {
    width: '36px',
    height: '36px',
    borderRadius: '50%',
    overflow: 'hidden',
    flexShrink: 0,
    background: '#f7fafc',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  resultAvatarImg: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  resultAvatarFallback: {
    fontSize: '1.2rem',
  },
  resultInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  resultName: {
    fontSize: '0.85rem',
    fontWeight: '700',
    color: '#1a202c',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  resultUpName: {
    fontSize: '0.75rem',
    color: '#805ad5',
    fontWeight: '500',
  },
  resultAddress: {
    fontSize: '0.7rem',
    color: '#a0aec0',
    fontFamily: 'monospace',
  },
  loading: {
    textAlign: 'center',
    padding: '8px',
    fontSize: '0.8rem',
    color: '#a0aec0',
  },
};
