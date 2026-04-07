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
// Priority chain:
//   1. indexerImageUrl / indexerBackgroundImageUrl (lsp-indexer)
//   2. erc725.js (_profileCache) — only when indexer has no images
//   3. indexerAvatarUrl (lsp-indexer fallback)
//
// Once resolved, no extra fetches are triggered.

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

  // Only fetch via erc725 when indexer has no images
  useEffect(() => {
    if (indexerImageUrl || indexerBackgroundImageUrl) return;
    fetchProfileCache(key);
  }, [key, indexerImageUrl, indexerBackgroundImageUrl]);

  // Has indexer image? → resolved immediately, no erc725 needed
  if (indexerImageUrl || indexerBackgroundImageUrl) {
    return {
      profileImageUrl: indexerImageUrl ?? null,
      backgroundImageUrl: indexerBackgroundImageUrl ?? null,
      scheme: 'indexer',
    };
  }

  const cached = _profileCache.has(key) ? _profileCache.get(key) : undefined;
  const isCacheSettled = cached !== undefined;

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

  return { profileImageUrl: null, backgroundImageUrl: cached?.backgroundImageUrl ?? null, scheme: 'none' };
}

// ─── Direct cache read (for debug / popup rendering) ──────

export function getProfileCacheEntry(address: string): CachedProfileImages | undefined {
  return _profileCache.get(address.toLowerCase());
}

export function isProfileCacheSettled(address: string): boolean {
  return _profileCache.has(address.toLowerCase());
}
