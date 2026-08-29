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

export const traceWait = (label: string, detail?: string): TraceStep =>
  ({ label, status: 'wait', ...(detail ? { detail } : {}) });

export const traceSkip = (label: string, why = 'higher priority won'): TraceStep =>
  ({ label, status: 'skip', detail: why });

/**
 * Image diagnostics are a first-class viewer feature. The panel stays collapsed
 * by default, so keeping it available in production has no layout cost and
 * avoids environment-dependent UAT behaviour.
 */
export function isDebugEnabled(): boolean {
  return true;
}
