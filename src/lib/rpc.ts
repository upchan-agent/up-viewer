// ─── Shared RPC provider ────────────────────────────────────
// Singleton JsonRpcProvider for public LUKSO mainnet RPC.
// Avoids creating a new provider (and new connection pool) per call.

import { ethers } from 'ethers';
import { LUKSO_RPC_URL } from '@/lib/constants';

let _provider: ethers.JsonRpcProvider | null = null;

export function getRpcProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(LUKSO_RPC_URL);
  }
  return _provider;
}
