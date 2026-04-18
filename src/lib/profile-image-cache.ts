// ─── erc725.js profile image fallback ─────────────────────
// Used when lsp-indexer (useProfile) does not have profileImage/backgroundImage
// for an address — typically non-standard or recently updated profiles.
// Shared between SocialGraph and ProfileCard.

import { toGatewayUrl } from '@/lib/utils';
import { LUKSO_RPC_URL } from '@/lib/constants';
import { useEffect, useState } from 'react';

interface Lsp3ProfileImages {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
}

async function fetchLsp3ProfileImages(address: string): Promise<Lsp3ProfileImages> {
  try {
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
  } catch {
    return { profileImageUrl: null, backgroundImageUrl: null };
  }
}

// ─── Cache ─────────────────────────────────────────────────

const MAX_CACHE_ENTRIES = 300;

export interface CachedProfileImages {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
}

const _profileCache = new Map<string, CachedProfileImages>();
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
    .then(result => {
      if (_profileCache.size >= MAX_CACHE_ENTRIES) {
        const oldest = _profileCache.keys().next().value;
        if (oldest !== undefined) _profileCache.delete(oldest);
      }
      _profileCache.set(key, result);
    })
    .catch(() => {
      _profileCache.set(key, { profileImageUrl: null, backgroundImageUrl: null });
    })
    .finally(() => { _profileCacheInFlight.delete(key); _notify(key); });
}

// ─── Hook: useResolvedProfileImage ─────────────────────────
// Priority chain (per-field, NOT all-or-nothing):
//   1. indexerImageUrl / indexerBackgroundImageUrl (lsp-indexer)
//   2. erc725.js (_profileCache) — fills gaps when indexer is partial
//   3. indexerAvatarUrl (lsp-indexer fallback)
//
// Bug fix (2026-04-19): Previously, if the indexer had *any* image
// (profileImage OR backgroundImage), erc725 was skipped entirely and
// the missing field stayed null — even if erc725 had it.
// Now each field falls back independently.

interface ResolvedProfileImage {
  profileImageUrl: string | null;
  backgroundImageUrl: string | null;
  scheme: string;
}

export function useResolvedProfileImage({
  address,
  indexerImageUrl,
  indexerBackgroundImageUrl,
  indexerAvatarUrl,
}: {
  address: string;
  indexerImageUrl?: string;
  indexerBackgroundImageUrl?: string;
  indexerAvatarUrl?: string;
}): ResolvedProfileImage | undefined {
  const key = address.toLowerCase();

  const [, setTick] = useState(0);
  useEffect(() => subscribeProfileCache(key, () => setTick(t => t + 1)), [key]);

  // Fetch erc725 only when indexer has NO images AND cache not yet settled
  const hasAnyIndexerImage = !!(indexerImageUrl || indexerBackgroundImageUrl);
  const cached = _profileCache.has(key) ? _profileCache.get(key) : undefined;
  const isCacheSettled = cached !== undefined;

  useEffect(() => {
    if (hasAnyIndexerImage && isCacheSettled) return; // cache already has what we need
    if (hasAnyIndexerImage) {
      // Indexer has something but cache not settled — fetch to fill gaps
      fetchProfileCache(key);
      return;
    }
    if (!isCacheSettled) {
      fetchProfileCache(key);
    }
  }, [key, hasAnyIndexerImage, isCacheSettled]);

  // If indexer has both images, no need to wait for cache
  if (indexerImageUrl && indexerBackgroundImageUrl) {
    return {
      profileImageUrl: indexerImageUrl,
      backgroundImageUrl: indexerBackgroundImageUrl,
      scheme: 'indexer',
    };
  }

  // If indexer has no images, wait for erc725 cache
  if (!hasAnyIndexerImage) {
    if (!isCacheSettled) return undefined; // still resolving

    if (cached?.profileImageUrl) {
      return {
        profileImageUrl: cached.profileImageUrl,
        backgroundImageUrl: cached.backgroundImageUrl,
        scheme: 'erc725',
      };
    }

    // 3rd: avatar fallback
    if (indexerAvatarUrl) {
      return {
        profileImageUrl: indexerAvatarUrl,
        backgroundImageUrl: null,
        scheme: 'indexer.avatar',
      };
    }

    return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'none' };
  }

  // Indexer has partial images — merge with erc725 cache to fill gaps
  if (!isCacheSettled) {
    // Return what indexer has now; cache will trigger re-render when ready
    return {
      profileImageUrl: indexerImageUrl ?? null,
      backgroundImageUrl: indexerBackgroundImageUrl ?? null,
      scheme: 'indexer(partial)',
    };
  }

  // Merge: indexer wins, cache fills gaps
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

  // Both indexer (partial) and erc725 are empty — try avatar
  if (indexerAvatarUrl) {
    return {
      profileImageUrl: indexerAvatarUrl,
      backgroundImageUrl: null,
      scheme: 'indexer.avatar',
    };
  }

  return { profileImageUrl: null, backgroundImageUrl: null, scheme: 'none' };
}

// ─── Direct cache read (for debug / popup rendering) ──────

export function getProfileCacheEntry(address: string): CachedProfileImages | undefined {
  return _profileCache.get(address.toLowerCase());
}

export function isProfileCacheSettled(address: string): boolean {
  return _profileCache.has(address.toLowerCase());
}
