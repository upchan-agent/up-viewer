'use client';

import { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { LSP26_ADDRESS, LUKSO_RPC_URL } from '@/lib/constants';

// ─── LSP26 function selectors ───────────────────────────────
const SELECTOR_FOLLOWER_COUNT = '0x30b3a890';
const SELECTOR_FOLLOWING_COUNT = '0x64548707';

// ─── Shared provider (singleton) ────────────────────────────
let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(LUKSO_RPC_URL);
  }
  return _provider;
}

// ─── In-flight request dedup ────────────────────────────────
const _inFlight = new Map<string, Promise<number>>();
const _cache = new Map<string, { value: number; ts: number }>();
const CACHE_TTL_MS = 60_000; // 1 min

async function fetchCount(
  selector: string,
  address: string,
): Promise<number> {
  const cacheKey = `${selector}:${address}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.value;
  }

  const existing = _inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const provider = getProvider();
      const addrPadded = ethers.zeroPadValue(address, 32);
      const data = selector + addrPadded.slice(2); // selector + padded address
      const result = await provider.call({ to: LSP26_ADDRESS, data });
      const value = Number(BigInt(result));
      _cache.set(cacheKey, { value, ts: Date.now() });
      return value;
    } catch {
      return 0;
    } finally {
      _inFlight.delete(cacheKey);
    }
  })();

  _inFlight.set(cacheKey, promise);
  return promise;
}

// ─── Hook ───────────────────────────────────────────────────

interface Lsp26Counts {
  followerCount: number;
  followingCount: number;
  isLoading: boolean;
}

export function useLsp26Counts(address: string | undefined): Lsp26Counts {
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!address) {
      setFollowerCount(0);
      setFollowingCount(0);
      return;
    }

    const addr = address.toLowerCase();
    setIsLoading(true);

    Promise.all([
      fetchCount(SELECTOR_FOLLOWER_COUNT, addr),
      fetchCount(SELECTOR_FOLLOWING_COUNT, addr),
    ]).then(([followers, following]) => {
      if (!mountedRef.current) return;
      setFollowerCount(followers);
      setFollowingCount(following);
      setIsLoading(false);
    });
  }, [address]);

  return { followerCount, followingCount, isLoading };
}
