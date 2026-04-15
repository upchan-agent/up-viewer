// ─── Asset Image Cache ─────────────────────────────────────
// AssetList で使うモジュールレベルのキャッシュ・フェッチ基盤。
// useTokenImage / useLsp7SingleNftImage を useAssetImage(type) に統合。
//
// キャッシュキー名前空間:
//   token:    LSP7 TOKEN
//   lsp7nft:  LSP7 NFT/COLLECTION
//   lsp8:     LSP8 個別トークン      (AssetList.tsx 内 useLsp8ChildImage が使用)
//   lsp8coll: LSP8 コレクション      (AssetList.tsx 内 useLsp8CollectionImage が使用)

import { useEffect, useState } from 'react';
import { toGatewayUrl } from '@/lib/utils';

// ─── 型定義 ───────────────────────────────────────────────

export interface ResolvedIcon {
  url: string;
  scheme: string;
}

export interface ResolvedAssetImage {
  url: string;
  scheme: string;
  debug: string[];
}

// ─── Envio GraphQL エンドポイント ─────────────────────────

const INDEXER_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── Rate limiter (最大6並列) ─────────────────────────────

let _activeFetches = 0;
const _fetchQueue: {
  fn: () => Promise<string | null>;
  resolve: (v: string | null) => void;
  reject: (e: any) => void;
}[] = [];

function _drainQueue() {
  while (_activeFetches < 6 && _fetchQueue.length > 0) {
    _activeFetches++;
    const { fn, resolve, reject } = _fetchQueue.shift()!;
    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => { _activeFetches--; _drainQueue(); });
  }
}

function fetchWithLimit(fn: () => Promise<string | null>): Promise<string | null> {
  return new Promise((resolve, reject) => {
    _fetchQueue.push({ fn: () => fetchWithRetry(fn), resolve, reject });
    _drainQueue();
  });
}

const MAX_RETRIES = 2;
async function fetchWithRetry(fn: () => Promise<string | null>): Promise<string | null> {
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

// ─── API フェッチャー ──────────────────────────────────────

export async function fetchAssetImage(addr: string): Promise<string | null> {
  const query = `{Asset(where:{id:{_eq:"${addr.toLowerCase()}"}},limit:1){icons{url}images{url}url}}`;
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const a = json.data?.Asset?.[0];
  if (a?.icons?.[0]?.url)  return toGatewayUrl(a.icons[0].url)  ?? null;
  if (a?.images?.[0]?.url) return toGatewayUrl(a.images[0].url) ?? null;
  if (a?.url?.startsWith('ipfs://')) return toGatewayUrl(a.url) ?? null;
  return null;
}

export async function fetchTokenImage(addr: string, tidHex: string): Promise<string | null> {
  const fullId = `${addr.toLowerCase()}-${tidHex}`;
  const query = `{Token(where:{id:{_eq:"${fullId}"}},limit:1){images{url}icons{url}}}`;
  const res = await fetch(INDEXER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const t = json.data?.Token?.[0];
  if (t?.images?.[0]?.url) return toGatewayUrl(t.images[0].url) ?? null;
  if (t?.icons?.[0]?.url)  return toGatewayUrl(t.icons[0].url)  ?? null;
  return null;
}

// ─── モジュールレベルキャッシュ ───────────────────────────
// key → string:    解決済み URL
// key → null:      API が画像なしと確認（リトライしない）
// key 不在:        未フェッチ
//
// MAX_CACHE_ENTRIES を超えると最古のエントリを削除（LRU近似）。
// モバイルの RAM 制約を考慮した上限値。

const MAX_CACHE_ENTRIES = 500;
export const _apiCache = new Map<string, string | null>();
const _apiInFlight = new Set<string>();

// キー単位サブスクライバー: そのキーが解決した時だけ通知する。
// グローバル broadcast を避け、不要な全体再レンダーを防ぐ。
const _apiSubs = new Map<string, Set<() => void>>();

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
    .then(url => {
      if (_apiCache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = _apiCache.keys().next().value;
        if (oldestKey !== undefined) _apiCache.delete(oldestKey);
      }
      _apiCache.set(key, url);
    })
    .catch(() => { /* 一時エラー: 不在のままにして次回マウント時にリトライ */ })
    .finally(() => { _apiInFlight.delete(key); _apiNotify(key); });
}

// ─── useAssetImage ────────────────────────────────────────
// useTokenImage / useLsp7SingleNftImage を統合した共通フック。
// 両者はキャッシュキープレフィックスのみ異なり、ロジックは同一。
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

  const [, setTick] = useState(0);
  useEffect(
    () => apiSubscribe(imageCacheKey, () => setTick(t => t + 1)),
    [imageCacheKey],
  );

  useEffect(() => {
    if (indexerIcon) return;
    apiFetch(imageCacheKey, () => fetchAssetImage(contractAddress), isPopupContext);
  }, [imageCacheKey, contractAddress, indexerIcon, isPopupContext]);

  const debug: string[] = [];

  // 1st: ownedAsset.digitalAsset.icons
  const indexerIconsUrl =
    indexerIcon?.scheme === 'ownedAsset.digitalAsset.icons' ? indexerIcon.url : undefined;
  debug.push(`1st ownedAsset.digitalAsset.icons: ${indexerIconsUrl ? '✓ ' + indexerIconsUrl : '(none)'}`);

  // 2nd: ownedAsset.digitalAsset.images
  const indexerImagesUrl =
    indexerIcon?.scheme === 'ownedAsset.digitalAsset.images' ? indexerIcon.url : undefined;
  debug.push(`2nd ownedAsset.digitalAsset.images: ${indexerImagesUrl ? '✓ ' + indexerImagesUrl : '(none)'}`);

  // 3rd: api.Asset
  const cachedImageUrl = _apiCache.has(imageCacheKey) ? _apiCache.get(imageCacheKey) : undefined;
  const isCacheSettled = cachedImageUrl !== undefined;
  debug.push(`3rd api.Asset: ${!isCacheSettled ? '(pending...)' : cachedImageUrl ? '✓ ' + cachedImageUrl : '(null)'}`);

  if (indexerIconsUrl) {
    debug.push('selected: 1st');
    return { url: indexerIconsUrl, scheme: 'ownedAsset.digitalAsset.icons', debug };
  }
  if (indexerImagesUrl) {
    debug.push('selected: 2nd');
    return { url: indexerImagesUrl, scheme: 'ownedAsset.digitalAsset.images', debug };
  }
  if (!isCacheSettled) return undefined;
  if (cachedImageUrl) {
    debug.push('selected: 3rd');
    return { url: cachedImageUrl, scheme: 'api.Asset', debug };
  }

  debug.push('selected: none');
  return { url: '', scheme: 'none', debug };
}
