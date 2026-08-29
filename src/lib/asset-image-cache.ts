// ─── Asset Image Cache ─────────────────────────────────────
// AssetList で使うモジュールレベルのキャッシュ・フェッチ基盤。
// useTokenImage / useLsp7SingleNftImage を useAssetImage(type) に統合。
//
// キャッシュキー名前空間:
//   token:    LSP7 TOKEN
//   lsp7nft:  LSP7 NFT/COLLECTION
//   lsp8:     LSP8 個別トークン      (AssetList.tsx 内 useLsp8ChildImage が使用)
//   lsp8coll: LSP8 コレクション      (AssetList.tsx 内 useLsp8CollectionImage が使用)
//
// Refactored (2026-08):
// - Envio URL / query execution via shared src/lib/envio.ts
// - ConcurrencyLimiter replaces the ad-hoc queue (same 6-parallel limit)
// - TtlLruCache: negative results expire after 2 min so transient
//   indexer failures retry instead of being permanent

import { useEffect, useState } from 'react';
import { toGatewayUrl } from '@/lib/utils';
import { envioQuery } from '@/lib/envio';
import { TtlLruCache } from '@/lib/cache';
import { ConcurrencyLimiter } from '@/lib/rate-limiter';
import { traceHit, traceMiss, traceWait, traceSkip } from '@/lib/debug-trace';

// ─── 型定義 ───────────────────────────────────────────────

export interface ResolvedIcon {
  url: string;
  scheme: string;
}

export interface ResolvedAssetImage {
  url: string;
  scheme: string;
  /** Debug trace — populated by useLsp8ChildImage (AssetList) when debug is enabled. */
  trace?: import('@/lib/debug-trace').TraceStep[];
}

// ─── Rate limiter (最大6並列) ─────────────────────────────

const _limiter = new ConcurrencyLimiter(6);

const MAX_RETRIES = 2;
async function fetchWithRetry<T>(fn: () => Promise<T>): Promise<T | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch {
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }
  return null;
}

function fetchWithLimit(fn: () => Promise<string | null>): Promise<string | null> {
  // Retry inside the limiter slot so retries don't bypass the cap.
  return _limiter.run(() => fetchWithRetry(fn));
}

// ─── API フェッチャー ──────────────────────────────────────

export async function fetchAssetImage(addr: string): Promise<string | null> {
  const data = await envioQuery<{ Asset: any[] }>(
    `query AssetImage($id: String!) { Asset(where:{id:{_eq:$id}},limit:1){icons{url}images{url}url} }`,
    { id: addr.toLowerCase() },
  );
  const a = data?.Asset?.[0];
  if (a?.icons?.[0]?.url)  return toGatewayUrl(a.icons[0].url)  ?? null;
  if (a?.images?.[0]?.url) return toGatewayUrl(a.images[0].url) ?? null;
  if (a?.url?.startsWith('ipfs://')) return toGatewayUrl(a.url) ?? null;
  return null;
}

export async function fetchTokenImage(addr: string, tidHex: string): Promise<string | null> {
  const fullId = `${addr.toLowerCase()}-${tidHex.toLowerCase()}`;
  const data = await envioQuery<{ Token: any[] }>(
    `query TokenImage($id: String!) { Token(where:{id:{_eq:$id}},limit:1){images{url}icons{url}} }`,
    { id: fullId },
  );
  const t = data?.Token?.[0];
  if (t?.images?.[0]?.url) return toGatewayUrl(t.images[0].url) ?? null;
  if (t?.icons?.[0]?.url)  return toGatewayUrl(t.icons[0].url)  ?? null;
  return null;
}

// ─── モジュールレベルキャッシュ ───────────────────────────
// value → string: 解決済み URL（セッション中保持）
// value → null:   「画像なし/取得失敗」— 2分後に期限切れ（リトライ可）

const NEGATIVE_TTL_MS = 120_000;

const _apiCache = new TtlLruCache<string>({
  maxSize: 500,
  ttlMs: Number.POSITIVE_INFINITY,
  negativeTtlMs: NEGATIVE_TTL_MS,
});

// キー単位サブスクライバー: そのキーが解決した時だけ通知する。
// グローバル broadcast を避け、不要な全体再レンダーを防ぐ。
const _apiSubs = new Map<string, Set<() => void>>();
const _apiInFlight = new Set<string>();

export function apiSubscribe(key: string, cb: () => void): () => void {
  if (!_apiSubs.has(key)) _apiSubs.set(key, new Set());
  _apiSubs.get(key)!.add(cb);
  return () => {
    const subs = _apiSubs.get(key);
    if (!subs) return;
    subs.delete(cb);
    if (subs.size === 0) _apiSubs.delete(key);
  };
}

function _apiNotify(key: string) {
  _apiSubs.get(key)?.forEach(cb => cb());
}

// ─── Popup open フラグ ────────────────────────────────────
// Popup 表示中はバックグラウンドフェッチを defer し、
// メインスレッドをポップアップ操作のために空ける。
// （特にモバイルでタップ遅延・クローズ遅延の改善）

let _isPopupOpen = false;
const _deferredFetches: Array<{ key: string; fn: () => Promise<string | null> }> = [];

export function setAssetCachePopupOpen(open: boolean) {
  _isPopupOpen = open;
  if (!open && _deferredFetches.length > 0) {
    const pending = _deferredFetches.splice(0);
    for (const { key, fn } of pending) apiFetch(key, fn);
  }
}

// ─── apiFetch ─────────────────────────────────────────────
// priority=true: popup 自身のフェッチに使用（defer されない）
// priority=false: バックグラウンドフェッチ（popup 中は defer）

export function apiFetch(
  key: string,
  fn: () => Promise<string | null>,
  priority = false,
) {
  if (_apiCache.has(key) || _apiInFlight.has(key)) return;
  if (_isPopupOpen && !priority) {
    if (!_deferredFetches.some(d => d.key === key)) {
      _deferredFetches.push({ key, fn });
    }
    return;
  }
  _apiInFlight.add(key);
  fetchWithLimit(fn)
    .then(url => { _apiCache.set(key, url); })
    .catch(() => { /* limiter/retry exhausted — stays unset, retried on next mount */ })
    .finally(() => {
      _apiInFlight.delete(key);
      _apiNotify(key);
    });
}

// ─── Direct cache read (read-only access for AssetList hooks) ──

export function apiCacheGet(key: string): string | null | undefined {
  return _apiCache.get(key);
}

export function apiCacheHas(key: string): boolean {
  return _apiCache.has(key);
}

// ─── useAssetImage ────────────────────────────────────────
// useTokenImage / useLsp7SingleNftImage を統合した共通フック。
//
// type:
//   'token'   → キャッシュキー = `token:${address}`
//   'lsp7nft' → キャッシュキー = `lsp7nft:${address}`
//
// Priority chain:
//   1. indexerIcon.scheme === 'ownedAsset.digitalAsset.icons'
//   2. indexerIcon.scheme === 'ownedAsset.digitalAsset.images'
//   3. api.Asset (Envio GraphQL)
//
// 戻り値:
//   undefined        → まだ解決中（ローディング表示）
//   { url: '', ... } → 画像なしと確定（絵文字プレースホルダー）
//   { url: '...', }  → 解決済み（画像を表示）

export function useAssetImage({
  type,
  contractAddress,
  indexerIcon,
  isPopupContext = false,
}: {
  type: 'token' | 'lsp7nft';
  contractAddress: string;
  indexerIcon?: ResolvedIcon;
  isPopupContext?: boolean;
}): ResolvedAssetImage | undefined {
  const imageCacheKey = `${type}:${contractAddress.toLowerCase()}`;
  const shouldResolve = !!contractAddress && contractAddress !== 'skip';

  const [, setTick] = useState(0);
  useEffect(
    () => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)),
    [imageCacheKey],
  );

  useEffect(() => {
    if (!shouldResolve || indexerIcon) return;
    apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress), isPopupContext);
  }, [imageCacheKey, contractAddress, indexerIcon, isPopupContext, shouldResolve]);

  if (!shouldResolve) {
    return { url: '', scheme: 'none', trace: [] };
  }

  // 1st: ownedAsset.digitalAsset.icons
  const indexerIconsUrl =
    indexerIcon?.scheme === 'ownedAsset.digitalAsset.icons' ? indexerIcon.url : undefined;

  // 2nd: ownedAsset.digitalAsset.images
  const indexerImagesUrl =
    indexerIcon?.scheme === 'ownedAsset.digitalAsset.images' ? indexerIcon.url : undefined;

  // 3rd: api.Asset cache
  const cachedImageUrl = _apiCache.get(imageCacheKey);
  const isCacheSettled = cachedImageUrl !== undefined;

  // Debug trace — records every priority-chain source with its outcome.
  const trace = [
    indexerIconsUrl ? traceHit('1. ownedAsset.digitalAsset.icons', indexerIconsUrl)
      : traceMiss('1. ownedAsset.digitalAsset.icons', indexerIcon ? 'icons absent in list data' : '(no list data)'),
    indexerImagesUrl ? traceHit('2. ownedAsset.digitalAsset.images', indexerImagesUrl)
      : traceMiss('2. ownedAsset.digitalAsset.images', indexerIcon ? 'images absent in list data' : '(no list data)'),
    !isCacheSettled ? traceWait('3. api.Asset')
      : cachedImageUrl ? traceHit('3. api.Asset', cachedImageUrl)
        : traceMiss('3. api.Asset', '(null)'),
  ];

  if (indexerIconsUrl) {
    return { url: indexerIconsUrl, scheme: 'ownedAsset.digitalAsset.icons',
             trace: [...trace, traceSkip('4. —')] };
  }
  if (indexerImagesUrl) {
    return { url: indexerImagesUrl, scheme: 'ownedAsset.digitalAsset.images',
             trace: [...trace, traceSkip('4. —')] };
  }
  if (!isCacheSettled) return undefined;
  if (cachedImageUrl) {
    return { url: cachedImageUrl, scheme: 'api.Asset', trace };
  }
  return { url: '', scheme: 'none', trace };
}
