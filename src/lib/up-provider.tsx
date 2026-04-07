'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { createClientUPProvider } from '@lukso/up-provider';

// Define EIP1193Provider type
interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  accounts?: string[];
  contextAccounts?: string[];
  chainId?: number;
  isMiniApp?: Promise<boolean>;
}

interface UpProviderContextType {
  provider: EIP1193Provider | null;
  accounts: `0x${string}`[];
  contextAccounts: `0x${string}`[];
  chainId: number;
  isConnected: boolean;
  isDetecting: boolean; // Still detecting provider type
  isMiniApp: boolean | null;
  isConnecting: boolean;
  connect: () => Promise<void>;
  displayAddress: `0x${string}` | null;
  viewMode: 'grid' | 'wallet' | 'none';
}

const UpProviderContext = createContext<UpProviderContextType | null>(null);

export function useUpProvider() {
  const context = useContext(UpProviderContext);
  if (!context) {
    throw new Error('useUpProvider must be used within UpProvider');
  }
  return context;
}

interface UpProviderProps {
  children: ReactNode;
}

// Timeout for isMiniApp detection (1 second)
const MINI_APP_TIMEOUT = 1000;

export function UpProvider({ children }: UpProviderProps) {
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [accounts, setAccounts] = useState<`0x${string}`[]>([]);
  const [contextAccounts, setContextAccounts] = useState<`0x${string}`[]>([]);
  const [chainId, setChainId] = useState(42);
  const [isMiniApp, setIsMiniApp] = useState<boolean | null>(null);
  const [isDetecting, setIsDetecting] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  // Preserve the initial Grid context address (the UP owner whose page this is)
  const initialContextAddress = useRef<`0x${string}` | null>(null);

  // Set initial context address helper
  const setInitialContext = useCallback((ctx: `0x${string}`[]) => {
    if (ctx.length > 0 && !initialContextAddress.current) {
      initialContextAddress.current = ctx[0];
    }
  }, []);

  // Initialize provider
  useEffect(() => {
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const initProvider = async () => {
      try {
        // Check window.lukso (standalone) immediately — this is synchronous
        const luksoProvider = (window as any).lukso as EIP1193Provider | undefined;

        // Try Grid provider in parallel
        const gridProvider = createClientUPProvider();
        const miniAppPromise = gridProvider.isMiniApp;
        const timeoutPromise = new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), MINI_APP_TIMEOUT);
        });

        const miniApp = await Promise.race([miniAppPromise, timeoutPromise]);

        if (miniApp) {
          // Grid mode: use grid provider
          setProvider(gridProvider as unknown as EIP1193Provider);
          setIsMiniApp(true);
          setIsDetecting(false);
          
          const initialCtx = (gridProvider.contextAccounts || []) as `0x${string}`[];
          const initialAcc = (gridProvider.accounts || []) as `0x${string}`[];
          
          // Save initial context address BEFORE setting state (state update is async)
          setInitialContext(initialCtx);
          
          setAccounts(initialAcc);
          setContextAccounts(initialCtx);
          setChainId(gridProvider.chainId || 42);

          // Listen for changes
          gridProvider.on('accountsChanged', (newAccounts: string[]) => {
            setAccounts(newAccounts as `0x${string}`[]);
            const ctx = (gridProvider.contextAccounts || []) as `0x${string}`[];
            setContextAccounts(ctx);
            setInitialContext(ctx);
          });
          gridProvider.on('contextAccountsChanged', (newContextAccounts: string[]) => {
            setContextAccounts(newContextAccounts as `0x${string}`[]);
            setAccounts((gridProvider.accounts || []) as `0x${string}`[]);
            setInitialContext(newContextAccounts as `0x${string}`[]);
          });
          gridProvider.on('chainChanged', (newChainId: number) => {
            setChainId(newChainId);
          });

          // Polling fallback: Grid OFF→ON may not fire events,
          // so actively re-request accounts via RPC every 10 seconds.
          // 10s is sufficient for account detection; 2s caused unnecessary CPU load on mobile.
          pollInterval = setInterval(async () => {
            try {
              const rpcAccounts = await gridProvider.request({ method: 'eth_accounts' }) as string[];
              const currentAccounts = (rpcAccounts || []) as `0x${string}`[];
              const currentContext = (gridProvider.contextAccounts || []) as `0x${string}`[];
              
              // If context accounts appear and we don't have initial yet, save it
              if (currentContext.length > 0) {
                setInitialContext(currentContext);
              }
              
              setAccounts(prev =>
                prev.length !== currentAccounts.length || prev[0] !== currentAccounts[0]
                  ? currentAccounts : prev
              );
              setContextAccounts(prev =>
                prev.length !== currentContext.length || prev[0] !== currentContext[0]
                  ? currentContext : prev
              );
            } catch {
              // Ignore polling errors
            }
          }, 10000);
        } else if (luksoProvider) {
          // Standalone mode: use window.lukso (browser extension)
          setProvider(luksoProvider);
          setIsMiniApp(false);
          
          // Get initial accounts
          try {
            const initialAccounts = await luksoProvider.request({ method: 'eth_accounts' });
            setAccounts((initialAccounts || []) as `0x${string}`[]);
          } catch (e) {
            // No accounts yet — user hasn't connected
          }
          
          setIsDetecting(false);

          // Listen for changes
          luksoProvider.on('accountsChanged', (...args) => {
            const newAccounts = args[0] as string[];
            setAccounts(newAccounts as `0x${string}`[]);
          });
          luksoProvider.on('chainChanged', (...args) => {
            const newChainId = args[0] as number;
            setChainId(newChainId);
          });
        } else {
          // No provider available
          setIsMiniApp(false);
          setIsDetecting(false);
        }
      } catch (error) {
        console.error('Failed to initialize UP provider:', error);
        setIsMiniApp(false);
        setIsDetecting(false);
      }
    };

    initProvider();

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [setInitialContext]);

  // Connect for standalone mode (or Grid mode: request accounts)
  const connect = useCallback(async () => {
    if (!provider) {
      alert('Please install the UP Browser Extension.');
      return;
    }

    setIsConnecting(true);
    try {
      const newAccounts = await provider.request({
        method: 'eth_requestAccounts',
      }) as string[];
      setAccounts(newAccounts as `0x${string}`[]);
    } catch (error: any) {
      console.error('Failed to connect:', error);
      if (error.code === 4001) {
        // User rejected
        console.log('User rejected connection');
      }
    } finally {
      setIsConnecting(false);
    }
  }, [provider]);

  // Determine display address
// View mode: 'grid' (showing embedded profile), 'wallet' (user connected), 'none' (not connected)
  const displayAddress: `0x${string}` | null = 
    accounts[0] || initialContextAddress.current || null;

  // View mode
  const viewMode: 'grid' | 'wallet' | 'none' = 
    accounts.length > 0
      ? 'wallet'
      : (isMiniApp === true && initialContextAddress.current)
        ? 'grid'
        : 'none';

  // Connected status
  const isConnected = accounts.length > 0;

  return (
    <UpProviderContext.Provider
      value={{
        provider,
        accounts,
        contextAccounts,
        chainId,
        isConnected,
        isDetecting,
        isMiniApp,
        isConnecting,
        connect,
        displayAddress,
        viewMode,
      }}
    >
      {children}
    </UpProviderContext.Provider>
  );
}
