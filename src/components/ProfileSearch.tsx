'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

const ENVIO_MAINNET_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── ErrorImage（エラー時のみフォールバック表示）──────────

function ErrorImage({ src, alt, style, fallback }: {
  src: string; alt?: string; style?: React.CSSProperties;
  fallback?: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) return <>{fallback ?? null}</>;
  return (
    <img
      src={src}
      alt={alt ?? ''}
      style={style}
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
                  <ErrorImage
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
    gap: 'var(--space-2)',
  },
  input: {
    flex: 1,
    padding: 'var(--space-3) var(--space-4)',
    border: '1px solid var(--color-border-default)',
    borderRadius: 'var(--radius-lg)',
    fontSize: 'var(--text-lg)',
    outline: 'none',
    background: 'var(--color-surface-input)',
  },
  cancelButton: {
    padding: 'var(--space-2) var(--space-4)',
    border: 'none',
    borderRadius: 'var(--radius-lg)',
    background: 'var(--color-surface-muted)',
    color: 'var(--color-text-muted)',
    fontSize: 'var(--text-lg)',
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
    marginTop: 'var(--space-1)',
    background: 'var(--color-surface-input)',
    border: '1px solid var(--color-border-default)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-popup)',
    zIndex: 100,
    maxHeight: '220px',
    overflow: 'auto',
  },
  resultItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    width: '100%',
    padding: 'var(--space-3) var(--space-4)',
    border: 'none',
    borderBottom: '1px solid var(--color-surface-muted)',
    background: 'var(--color-surface-input)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  resultAvatar: {
    width: '36px',
    height: '36px',
    borderRadius: 'var(--radius-full)',
    overflow: 'hidden',
    flexShrink: 0,
    background: 'var(--color-surface-muted)',
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
    fontSize: 'var(--text-sm)',
    fontWeight: '700',
    color: 'var(--color-text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  resultUpName: {
    fontSize: 'var(--text-xs)',
    color: 'var(--color-brand)',
    fontWeight: '500',
  },
  resultAddress: {
    fontSize: 'var(--text-xs)',
    color: 'var(--color-text-faint)',
    fontFamily: 'monospace',
  },
};
