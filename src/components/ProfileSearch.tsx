'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

const ENVIO_MAINNET_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── TimeoutImage ────────────────────────────────────────

const PS_IMG_TIMEOUT_MS = 8000;

function TimeoutImage({ src, alt, style, fallback, }: {
  src: string; alt?: string; style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    setFailed(false);
    loadedRef.current = false;
    const timer = setTimeout(() => {
      if (!loadedRef.current) setFailed(true);
    }, PS_IMG_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [src]);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <img
      src={src}
      alt={alt ?? ''}
      style={style}
      onLoad={() => { loadedRef.current = true; }}
      onError={() => setFailed(true)}
    />
  );
}

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
  // All state managed by refs (except query) to avoid re-render input unmount
  const [query, setQuery] = useState('');
  const resultsRef = useRef<Profile[]>([]);
  const [resultsTick, setResultsTick] = useState(0);
  const loadingRef = useRef(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Force re-render of dropdown area only (input stays stable)
  const tick = useCallback(() => setResultsTick(t => t + 1), []);

  const doSearch = useCallback(async (searchQuery: string) => {
    if (searchQuery.length < 3) {
      resultsRef.current = [];
      setShowDropdown(false);
      tick();
      return;
    }

    loadingRef.current = true;
    try {
      const res = await fetch(ENVIO_MAINNET_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: GQL_QUERY, variables: { id: searchQuery.toLowerCase() } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      resultsRef.current = json.data?.search_profiles ?? [];
      setShowDropdown(resultsRef.current.length > 0);
    } catch {
      resultsRef.current = [];
      setShowDropdown(false);
    } finally {
      loadingRef.current = false;
    }
    tick();
  }, [tick]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setQuery(val);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (val.length < 3) {
        resultsRef.current = [];
        setShowDropdown(false);
        tick();
        return;
      }

      const looksLikeAddress = /^0x[0-9a-f]{5,}/i.test(val);

      if (looksLikeAddress) {
        debounceRef.current = setTimeout(() => doSearch(val), 400);
      } else if (val.length === 3) {
        doSearch(val);
      } else {
        debounceRef.current = setTimeout(() => doSearch(val), 800);
      }
    },
    [doSearch, tick]
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

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Stable input ref + dropdown state
  const results = resultsRef.current;

  return (
    <div data-search-root style={styles.root}>
      <div style={styles.inputRow}>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="🔍 Enter 3 chars or paste address..."
          style={styles.input}
        />
        <button onClick={onCancel} style={styles.cancelButton}>
          ✕
        </button>
      </div>

      {showDropdown && results.length > 0 && (
        <div key={`dd-${resultsTick}`} style={styles.dropdown}>
          {results.map((r) => (
            <button key={r.id} style={styles.resultItem} onClick={() => handleSelect(r)}>
              <div style={styles.resultAvatar}>
                {r.profileImages?.[0]?.src ? (
                  <TimeoutImage
                    src={r.profileImages[0].src}
                    style={styles.resultAvatarImg}
                    fallback={<span style={styles.resultAvatarFallback}>👤</span>}
                  />
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
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    position: 'relative',
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
    fontSize: '16px',
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
};
