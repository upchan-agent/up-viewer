'use client';

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
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
  isMiniApp: boolean | null;
  isConnecting: boolean;
  connect: () => Promise<void>;
  displayAddress: `0x${string}` | null;
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

// Timeout for isMiniApp detection (3 seconds)
const MINI_APP_TIMEOUT = 3000;

export function UpProvider({ children }: UpProviderProps) {
  const [provider, setProvider] = useState<EIP1193Provider | null>(null);
  const [accounts, setAccounts] = useState<`0x${string}`[]>([]);
  const [contextAccounts, setContextAccounts] = useState<`0x${string}`[]>([]);
  const [chainId, setChainId] = useState(42);
  const [isMiniApp, setIsMiniApp] = useState<boolean | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  // Initialize provider
  useEffect(() => {
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const initProvider = async () => {
      try {
        // Try Grid provider first
        const gridProvider = createClientUPProvider();

        // Check if running in Grid with timeout
        const miniAppPromise = gridProvider.isMiniApp;
        const timeoutPromise = new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), MINI_APP_TIMEOUT);
        });

        const miniApp = await Promise.race([miniAppPromise, timeoutPromise]);

        if (miniApp) {
          // Grid mode: use grid provider
          setProvider(gridProvider as unknown as EIP1193Provider);
          setIsMiniApp(true);
          setAccounts((gridProvider.accounts || []) as `0x${string}`[]);
          setContextAccounts((gridProvider.contextAccounts || []) as `0x${string}`[]);
          setChainId(gridProvider.chainId || 42);

          // Listen for changes
          gridProvider.on('accountsChanged', (newAccounts: string[]) => {
            setAccounts(newAccounts as `0x${string}`[]);
            setContextAccounts((gridProvider.contextAccounts || []) as `0x${string}`[]);
          });
          gridProvider.on('contextAccountsChanged', (newContextAccounts: string[]) => {
            setContextAccounts(newContextAccounts as `0x${string}`[]);
            setAccounts((gridProvider.accounts || []) as `0x${string}`[]);
          });
          gridProvider.on('chainChanged', (newChainId: number) => {
            setChainId(newChainId);
          });

          // Polling fallback: Grid OFF→ON may not fire events,
          // so actively re-request accounts via RPC every 2 seconds
          pollInterval = setInterval(async () => {
            try {
              const rpcAccounts = await gridProvider.request({ method: 'eth_accounts' }) as string[];
              const currentAccounts = (rpcAccounts || []) as `0x${string}`[];
              const currentContext = (gridProvider.contextAccounts || []) as `0x${string}`[];
              
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
          }, 2000);
        } else {
          // Standalone mode: use window.lukso (browser extension)
          const luksoProvider = (window as any).lukso;
          if (luksoProvider) {
            setProvider(luksoProvider);
            setIsMiniApp(false);
            
            // Get initial accounts
            try {
              const initialAccounts = await luksoProvider.request({ method: 'eth_accounts' });
              setAccounts((initialAccounts || []) as `0x${string}`[]);
            } catch (e) {
              console.log('No initial accounts');
            }

            // Listen for changes
            luksoProvider.on('accountsChanged', (newAccounts: string[]) => {
              setAccounts(newAccounts as `0x${string}`[]);
            });
            luksoProvider.on('chainChanged', (newChainId: number) => {
              setChainId(newChainId);
            });
          } else {
            // No provider available
            setIsMiniApp(false);
            console.warn('No LUKSO provider found. Install UP Browser Extension.');
          }
        }
      } catch (error) {
        console.error('Failed to initialize UP provider:', error);
        setIsMiniApp(false);
      }
    };

    initProvider();

    return () => {
      if (pollInterval) clearInterval(pollInterval);
    };
  }, []);

  // Connect for standalone mode
  const connect = useCallback(async () => {
    if (!provider) {
      alert('No wallet found. Please install UP Browser Extension.');
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
  const displayAddress: `0x${string}` | null = 
    contextAccounts[0] || accounts[0] || null;

  // Connected status
  const isConnected = isMiniApp 
    ? accounts.length > 0
    : accounts.length > 0;

  return (
    <UpProviderContext.Provider
      value={{
        provider,
        accounts,
        contextAccounts,
        chainId,
        isConnected,
        isMiniApp,
        isConnecting,
        connect,
        displayAddress,
      }}
    >
      {children}
    </UpProviderContext.Provider>
  );
}