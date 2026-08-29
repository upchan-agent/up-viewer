// ─── erc725.js profile image fallback ─────────────────────
// Used when lsp-indexer (useProfile) does not have profileImage/backgroundImage
// for an address — typically non-standard or recently updated profiles.
// Shared between SocialGraph and ProfileCard.
//
// Refactored (2026-08):
// - Single resolveProfileImages() used by BOTH the hook and the popup
//   (previously the popup re-implemented the priority chain manually).
// - Concurrency-limited erc725 fetches (was unlimited).
// - TTL+LRU cache with shorter negative-TTL: transient RPC/IPFS failures
//   are retried after a bounded interval instead of cached forever.

import { toGatewayUrl } from '@/lib/utils';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { TtlLruCache } from '@/lib/cache';
import { ConcurrencyLimiter } from '@/lib/rate-limiter';
import { useEffect, useState } from 'react';

interface Lsp3ProfileImages {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
}

const ERC725_CONCURRENCY = 4;

const _erc725Limiter = new ConcurrencyLimiter(ERC725_CONCURRENCY);

async function fetchLsp3ProfileImages(address: string): Promise<Lsp3ProfileImages> {
  return _erc725Limiter.run(async () => {
    const [{ default: ERC725 }, LSP3Schema] = await Promise.all([
      import('@erc725/erc725.js'),
      import('@erc725/erc725.js/schemas/LSP3ProfileMetadata.json'),
    ]);

    const erc725 = new ERC725(
      LSP3Schema.default ?? LSP3Schema,
      address,
      LUKSO_RPC_URL,
      { ipfsGateway: 'https://api.universalprofile.cloud/ipfs/' },
    );

    const result = await erc725.fetchData('LSP3Profile');
    const lsp3 = (result?.value as any)?.LSP3Profile;

    const profileImageUrl = lsp3?.profileImage?.[0]?.url
      ? toGatewayUrl(lsp3.profileImage[0].url) ?? null
      : null;
    const backgroundImageUrl = lsp3?.backgroundImage?.[0]?.url
      ? toGatewayUrl(lsp3.backgroundImage[0].url) ?? null
      : null;

    return { profileImageUrl, backgroundImageUrl };
  });
}

// ─── Cache ─────────────────────────────────────────────────

// Positive entries live for the session; negative results (no image found /
// fetch error) retry after 2 minutes instead of being permanent.
const MAX_CACHE_ENTRIES = 300;
const NEGATIVE_TTL_MS = 120_000;

export interface CachedProfileImages {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
}

const _profileCache = new TtlLruCache<CachedProfileImages>({
  maxSize: MAX_CACHE_ENTRIES,
  ttlMs: Number.POSITIVE_INFINITY,
  negativeTtlMs: NEGATIVE_TTL_MS,
});
const _profileCacheInFlight = new Set<string>();
const _profileCacheSubs = new Map<string, Set<() => void>>();

// Popup open flag for SocialGraph — defers fetches while popup is open
let _popupOpen = false;
const _deferredFetches: string[] = [];

export function setProfileCachePopupOpen(open: boolean) {
  _popupOpen = open;
  if (!open && _deferredFetches.length > 0) {
    const pending = _deferredFetches.splice(0);
    for (const addr of pending) fetchProfileCache(addr);
  }
}

export function subscribeProfileCache(key: string, cb: () => void): () => void {
  if (!_profileCacheSubs.has(key)) _profileCacheSubs.set(key, new Set());
  _profileCacheSubs.get(key)!.add(cb);
  return () => {
    const subs = _profileCacheSubs.get(key);
    if (!subs) return;
    subs.delete(cb);
    if (subs.size === 0) _profileCacheSubs.delete(key);
  };
}

function _notify(key: string) {
  _profileCacheSubs.get(key)?.forEach(cb => cb());
}

export function fetchProfileCache(address: string, priority = false) {
  const key = address.toLowerCase();
  if (_profileCache.has(key) || _profileCacheInFlight.has(key)) return;
  if (_popupOpen && !priority) {
    if (!_deferredFetches.includes(key)) _deferredFetches.push(key);
    return;
  }
  _profileCacheInFlight.add(key);
  fetchLsp3ProfileImages(key)
    .catch(() => ({ profileImageUrl: null, backgroundImageUrl: null }))
    .then(result => { _profileCache.set(key, result); })
    .finally(() => { _profileCacheInFlight.delete(key); _notify(key); });
}

// ─── Canonical resolution chain ────────────────────────────
// The ONE place that defines profile-image resolution. Both
// useResolvedProfileImage and ProfilePopupContent call this.
//
// Priority (per-field, NOT all-or-nothing):
//   1. indexer profileImage / backgroundImage (lsp-indexer)
//   2. erc725.js (_profileCache) — fills gaps when indexer is partial
//   3. indexerAvatarUrl (lsp-indexer fallback)
//
// Bug fix history:
// - 2026-04-19: per-field fallback introduced (indexer partial no longer
//   blocks erc725 gap-filling).
// - 2026-08: extracted into this shared function so the popup and the list
//   rows can never diverge again.

export interface ResolvedProfileImage {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  scheme: string;
}

export function resolveFromSources({
  indexerImageUrl,
  indexerBackgroundImageUrl,
  indexerAvatarUrl,
  cacheSettled,
  cached,
}: {
  indexerImageUrl?: string;
  indexerBackgroundImageUrl?: string;
  indexerAvatarUrl?: string;
  cacheSettled: boolean;
  cached?: CachedProfileImages;
}): ResolvedProfileImage {
  // If indexer has both images, done.
  if (indexerImageUrl && indexerBackgroundImageUrl) {
    return {
      profileImageUrl: indexerImageUrl,
      backgroundImageUrl: indexerBackgroundImageUrl,
      scheme: 'indexer',
    };
  }

  const hasAnyIndexerImage = !!(indexerImageUrl || indexerBackgroundImageUrl);

  // Indexer has nothing — wait for erc725 before deciding.
  if (!hasAnyIndexerImage) {
    if (!cacheSettled) {
      return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'loading' };
    }
    if (cached?.profileImageUrl) {
      return {
        profileImageUrl: cached.profileImageUrl,
        backgroundImageUrl: cached.backgroundImageUrl,
        scheme: 'erc725',
      };
    }
    if (indexerAvatarUrl) {
      return {
        profileImageUrl: indexerAvatarUrl,
        backgroundImageUrl: null,
        scheme: 'indexer.avatar',
      };
    }
    return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'none' };
  }

  // Indexer has partial images — merge with erc725 cache to fill gaps.
  const mergedProfileImageUrl = indexerImageUrl ?? cached?.profileImageUrl ?? null;
  const mergedBackgroundImageUrl = indexerBackgroundImageUrl ?? cached?.backgroundImageUrl ?? null;
  const mergedScheme = indexerImageUrl && indexerBackgroundImageUrl
    ? 'indexer'
    : (indexerImageUrl || indexerBackgroundImageUrl) && (cached?.profileImageUrl || cached?.backgroundImageUrl)
      ? 'indexer+erc725'
      : (indexerImageUrl || indexerBackgroundImageUrl) ? 'indexer' : 'erc725';

  if (mergedProfileImageUrl || mergedBackgroundImageUrl) {
    return {
      profileImageUrl: mergedProfileImageUrl,
      backgroundImageUrl: mergedBackgroundImageUrl,
      scheme: mergedScheme,
    };
  }

  if (indexerAvatarUrl) {
    return {
      profileImageUrl: indexerAvatarUrl,
      backgroundImageUrl: null,
      scheme: 'indexer.avatar',
    };
  }

  return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'none' };
}

// ─── Hook: useResolvedProfileImage ─────────────────────────

export function useResolvedProfileImage({
  address,
  indexerImageUrl,
  indexerBackgroundImageUrl,
  indexerAvatarUrl,
  resolveBackground = true,
}: {
  address: string;
  indexerImageUrl?: string;
  indexerBackgroundImageUrl?: string;
  indexerAvatarUrl?: string;
  /**
   * List rows only need the profile image. Setting this to false prevents an
   * ERC725/RPC fallback fetch solely to fill an unused background image.
   */
  resolveBackground?: boolean;
}): ResolvedProfileImage | undefined {
  const key = address.toLowerCase();

  const [, setTick] = useState(0);
  useEffect(() => subscribeProfileCache(key, () => setTick(t => t + 1)), [key]);

  const hasRequiredIndexerData = !!indexerImageUrl && (!resolveBackground || !!indexerBackgroundImageUrl);
  const cached = _profileCache.get(key);
  const isCacheSettled = cached !== undefined;

  useEffect(() => {
    if (!key || hasRequiredIndexerData || isCacheSettled) return;
    fetchProfileCache(key);
  }, [key, hasRequiredIndexerData, isCacheSettled]);

  if (!key) {
    return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'none' };
  }

  const resolved = resolveFromSources({
    indexerImageUrl,
    indexerBackgroundImageUrl,
    indexerAvatarUrl,
    cacheSettled: isCacheSettled,
    cached: cached ?? undefined,
  });

  // 'loading' means "still resolving" — surface undefined so callers can
  // show their loading state.
  if (resolved.scheme === 'loading') return undefined;
  return resolved;
}

// ─── Direct cache read (for debug / popup rendering) ──────

export function getProfileCacheEntry(address: string): CachedProfileImages | undefined {
  const v = _profileCache.get(address.toLowerCase());
  return v ?? undefined;
}

export function isProfileCacheSettled(address: string): boolean {
  return _profileCache.has(address.toLowerCase());
}
