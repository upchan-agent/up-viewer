// LSP26 コントラクトからアドレス一覧を取得し、lsp-indexer でプロフィールをバッチ取得するフック。
// useInfiniteFollows の代替。アドレス一覧の正確性を LSP26 で保証する。

'use client';

import { useUpProvider } from '@/lib/up-provider';
import { useState, useEffect, useRef, useCallback } from 'react';
import { ethers } from 'ethers';
import { LUKSO_RPC_URL, LSP26_ADDRESS } from '@/lib/constants';

// Profile クエリは Envio 直接（Vercel プロキシは Profile エンティティ非対応）
const ENVIO_URL = 'https://envio.lukso-mainnet.universal.tech/v1/graphql';

// ─── LSP26 ABI（必要最小限）──────────────────────────────

const LSP26_ABI = [
  'function followerCount(address) view returns (uint256)',
  'function followingCount(address) view returns (uint256)',
  'function getFollowersByIndex(address, uint256, uint256) view returns (address[])',
  'function getFollowsByIndex(address, uint256, uint256) view returns (address[])',
];

// ─── 型定義 ──────────────────────────────────────────────

export interface Lsp26ProfileRow {
  addr: string;
  name: string;
  indexerImageUrl?: string;
}

export interface UseLsp26FollowsReturn {
  followerAddresses: string[];
  followingAddresses: string[];
  followerProfiles: Map<string, { name: string; profileImage?: string }>;
  followingProfiles: Map<string, { name: string; profileImage?: string }>;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}

// ─── プロフィールバッチ取得 ─────────────────────────────

const PROFILE_BATCH_SIZE = 20;

async function fetchProfilesBatch(
  addresses: string[],
): Promise<Map<string, { name: string; profileImage?: string }>> {
  const result = new Map<string, { name: string; profileImage?: string }>();
  if (addresses.length === 0) return result;

  // バッチに分割して並列フェッチ
  const batches: string[][] = [];
  for (let i = 0; i < addresses.length; i += PROFILE_BATCH_SIZE) {
    batches.push(addresses.slice(i, i + PROFILE_BATCH_SIZE));
  }

  await Promise.all(
    batches.map(async (batch) => {
      const addrFilter = batch.map((a) => `"${a.toLowerCase()}"`).join(',');
      const query = `{Profile(where:{id:{_in:[${addrFilter}]}}){id name profileImages{url}}}`;

      try {
        const res = await fetch(ENVIO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        if (!res.ok) return;

        const json = await res.json();
        const profiles = json.data?.Profile ?? [];

        for (const p of profiles) {
          const addr = p.id.toLowerCase();
          const imageUrl = p.profileImages?.[0]?.url ?? undefined;
          result.set(addr, { name: p.name || 'Unknown', profileImage: imageUrl });
        }

        // プロフィールが見つからなかったアドレスも登録
        for (const addr of batch) {
          if (!result.has(addr.toLowerCase())) {
            result.set(addr.toLowerCase(), { name: 'Unknown' });
          }
        }
      } catch {
        // エラー時は Unknown で登録
        for (const addr of batch) {
          if (!result.has(addr.toLowerCase())) {
            result.set(addr.toLowerCase(), { name: 'Unknown' });
          }
        }
      }
    }),
  );

  return result;
}

// ─── フック ──────────────────────────────────────────────

// モジュールレベルキャッシュ
const _addressCache = new Map<string, { followers: string[]; following: string[] }>();
const _profileCache = new Map<string, Map<string, { name: string; profileImage?: string }>>();

export function useLsp26Follows(address?: string): UseLsp26FollowsReturn {
  const { displayAddress } = useUpProvider();
  const targetAddress = (address || displayAddress || '').toLowerCase();

  const [followerAddresses, setFollowerAddresses] = useState<string[]>([]);
  const [followingAddresses, setFollowingAddresses] = useState<string[]>([]);
  const [followerProfiles, setFollowerProfiles] = useState<
    Map<string, { name: string; profileImage?: string }>
  >(new Map());
  const [followingProfiles, setFollowingProfiles] = useState<
    Map<string, { name: string; profileImage?: string }>
  >(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRef = useRef<AbortController | null>(null);

  const doFetch = useCallback(async () => {
    if (!targetAddress) return;

    // キャッシュ確認
    const cached = _addressCache.get(targetAddress);
    if (cached) {
      setFollowerAddresses(cached.followers);
      setFollowingAddresses(cached.following);

      const fProf = _profileCache.get(`${targetAddress}:followers`);
      const gProf = _profileCache.get(`${targetAddress}:following`);
      if (fProf) setFollowerProfiles(fProf);
      if (gProf) setFollowingProfiles(gProf);
      if (fProf && gProf) return;
    }

    // 進行中のリクエストをキャンセル
    fetchRef.current?.abort();
    const controller = new AbortController();
    fetchRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const provider = new ethers.JsonRpcProvider(LUKSO_RPC_URL);
      const contract = new ethers.Contract(LSP26_ADDRESS, LSP26_ABI, provider);

      // LSP26 からカウント取得
      const [followerCountRaw, followingCountRaw] = await Promise.all([
        contract.followerCount(targetAddress) as Promise<bigint>,
        contract.followingCount(targetAddress) as Promise<bigint>,
      ]);

      if (controller.signal.aborted) return;

      const followerCount = Number(followerCountRaw);
      const followingCount = Number(followingCountRaw);

      // LSP26 からアドレス一覧を取得（全件）
      const [followerAddrs, followingAddrs] = await Promise.all([
        followerCount > 0
          ? (contract.getFollowersByIndex(targetAddress, 0, followerCount) as Promise<string[]>)
          : Promise.resolve([] as string[]),
        followingCount > 0
          ? (contract.getFollowsByIndex(targetAddress, 0, followingCount) as Promise<string[]>)
          : Promise.resolve([] as string[]),
      ]);

      if (controller.signal.aborted) return;

      // アドレスを小文字に正規化 + 古い順→新しい順に reverse（LSP26 は挿入順で返す）
      const followerAddrsLower = followerAddrs.map((a) => a.toLowerCase()).reverse();
      const followingAddrsLower = followingAddrs.map((a) => a.toLowerCase()).reverse();

      // アドレスキャッシュに保存
      _addressCache.set(targetAddress, {
        followers: followerAddrsLower,
        following: followingAddrsLower,
      });

      setFollowerAddresses(followerAddrsLower);
      setFollowingAddresses(followingAddrsLower);

      // lsp-indexer でプロフィールをバッチ取得
      const [fProfiles, gProfiles] = await Promise.all([
        fetchProfilesBatch(followerAddrsLower),
        fetchProfilesBatch(followingAddrsLower),
      ]);

      if (controller.signal.aborted) return;

      // プロフィールキャッシュに保存
      _profileCache.set(`${targetAddress}:followers`, fProfiles);
      _profileCache.set(`${targetAddress}:following`, gProfiles);

      setFollowerProfiles(fProfiles);
      setFollowingProfiles(gProfiles);
    } catch (e: any) {
      if (e.name === 'AbortError') return;
      console.error('[useLsp26Follows]', e);
      setError(e.message || 'Failed to fetch follows');
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, [targetAddress]);

  const refetch = useCallback(() => {
    // キャッシュをクリアして再取得
    _addressCache.delete(targetAddress);
    _profileCache.delete(`${targetAddress}:followers`);
    _profileCache.delete(`${targetAddress}:following`);
    doFetch();
  }, [targetAddress, doFetch]);

  useEffect(() => {
    doFetch();
    return () => fetchRef.current?.abort();
  }, [doFetch]);

  return {
    followerAddresses,
    followingAddresses,
    followerProfiles,
    followingProfiles,
    isLoading,
    error,
    refetch,
  };
}
