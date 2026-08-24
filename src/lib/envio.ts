// ─── Envio GraphQL client ──────────────────────────────────
// Single source of truth for the Envio endpoint and query execution.
// All modules must import from here instead of hardcoding the URL.

export const ENVIO_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

export class EnvioError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'EnvioError';
  }
}

/**
 * Execute a GraphQL query against the Envio indexer.
 * - signal: optional AbortController signal (propagates to fetch)
 * - Throws EnvioError on HTTP failure or GraphQL errors array.
 */
export async function envioQuery<T = any>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(ENVIO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) {
    throw new EnvioError(`Envio HTTP ${res.status}`, res.status);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new EnvioError(`Envio GraphQL error: ${json.errors[0]?.message ?? 'unknown'}`);
  }
  return json.data as T;
}
