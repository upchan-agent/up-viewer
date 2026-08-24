// ─── Popup asset metadata fetch ────────────────────────────
// Phase 2 performance: the list view's useInfiniteOwnedAssets no longer
// includes description/links/attributes/totalSupply (multi-MB payload on
// whale addresses). The popup fetches these on demand for the single
// selected asset via Envio, with a small TTL cache.

import { useEffect, useState } from 'react';
import { envioQuery } from '@/lib/envio';
import { TtlLruCache } from '@/lib/cache';

export interface PopupAssetMeta {
  name: string | null;
  symbol: string | null;
  description: string | null;
  links: { title?: string; url: string }[];
  attributes: { key: string; value: string }[];
  totalSupply: string | null;
  decimals: number | null;
}

const _metaCache = new TtlLruCache<PopupAssetMeta>({
  maxSize: 100,
  ttlMs: 5 * 60_000,       // positive metadata: 5 min
  negativeTtlMs: 60_000,   // failed lookups retry after 1 min
});

async function fetchPopupAssetMeta(contractAddress: string): Promise<PopupAssetMeta | null> {
  const data = await envioQuery<{ Asset: any[] }>(
    `query PopupMeta($id: String!) {
      Asset(where:{id:{_eq:$id}},limit:1){
        name lsp4TokenSymbol description
        links{title url}
        attributes{key value}
        totalSupply decimals url
      }
    }`,
    { id: contractAddress.toLowerCase() },
  );
  const a = data?.Asset?.[0];
  if (!a) return null;
  return {
    name: a.name ?? null,
    symbol: a.lsp4TokenSymbol ?? null,
    description: a.description ?? null,
    links: (a.links ?? []).map((l: any) => ({ title: l.title ?? undefined, url: l.url })),
    attributes: (a.attributes ?? []).map((x: any) => ({ key: x.key, value: x.value })),
    totalSupply: a.totalSupply != null ? String(a.totalSupply) : null,
    decimals: typeof a.decimals === 'number' ? a.decimals : null,
  };
}

/**
 * On-demand metadata for the popup. Returns:
 *   undefined → still fetching
 *   null      → confirmed unavailable
 *   meta      → resolved
 */
export function usePopupAssetMeta(contractAddress: string | null): PopupAssetMeta | null | undefined {
  const key = contractAddress?.toLowerCase() ?? '';

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!key) return;
    if (_metaCache.has(key)) return;
    let cancelled = false;
    fetchPopupAssetMeta(key)
      .then(meta => { _metaCache.set(key, meta); })
      .catch(() => { _metaCache.set(key, null); })
      .finally(() => { if (!cancelled) setTick(t => t + 1); });
    return () => { cancelled = true; };
  }, [key]);

  if (!key) return null;
  const cached = _metaCache.get(key);
  return cached === undefined ? undefined : cached;
}
