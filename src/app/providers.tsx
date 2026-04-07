'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UpProvider } from '@/lib/up-provider';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000, // 5 minutes — reduces background refetch frequency on mobile
        refetchOnWindowFocus: false,
      },
    },
  }));

  return (
    <QueryClientProvider client={queryClient}>
      <UpProvider>
        {children}
      </UpProvider>
    </QueryClientProvider>
  );
}