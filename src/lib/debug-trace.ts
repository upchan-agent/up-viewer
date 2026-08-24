// ─── Debug Trace ────────────────────────────────────────────
// Structured trace steps for image-resolution chains.
// Consumed by Popup's debug panel (and available to any caller).
//
// A trace describes WHY an image resolved the way it did:
// every candidate source in priority order, with its outcome.
//
//   ✓ hit   — this source produced a URL
//   ✗ miss  — this source had nothing
//   ⏳ wait — this source hasn't settled yet (fetch in flight)
//   ⊘ skip  — not evaluated (a higher-priority source won first)

export type TraceStatus = 'hit' | 'miss' | 'wait' | 'skip';

export interface TraceStep {
  /** Source identifier, e.g. 'useNft.images' */
  label: string;
  status: TraceStatus;
  /** Full URL or note — never truncated */
  detail?: string;
}

export const TRACE_GLYPH: Record<TraceStatus, string> = {
  hit: '✓',
  miss: '✗',
  wait: '⏳',
  skip: '⊘',
};

export const traceHit = (label: string, url?: string): TraceStep =>
  ({ label, status: 'hit', ...(url ? { detail: url } : {}) });

export const traceMiss = (label: string, detail?: string): TraceStep =>
  ({ label, status: 'miss', ...(detail ? { detail } : {}) });

export const traceWait = (label: string): TraceStep => ({ label, status: 'wait' });

export const traceSkip = (label: string, why = 'higher priority won'): TraceStep =>
  ({ label, status: 'skip', detail: why });

/** True when the debug panel should be rendered: always in dev,
 *  opt-in in production via ?debug=1.
 *
 *  The result is latched on first read: page.tsx rewrites the URL
 *  (router.replace '?view=...') which drops the debug param, so later
 *  reads must not depend on location.search. */
let _debugLatched: boolean | undefined;

export function isDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (_debugLatched !== undefined) return _debugLatched;
  _debugLatched = process.env.NODE_ENV === 'development'
    || (() => {
      try {
        return new URLSearchParams(window.location.search).has('debug');
      } catch {
        return false;
      }
    })();
  return _debugLatched;
}
