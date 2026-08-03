'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import Toaster from '@/components/ui/Toast';

/**
 * Client-side providers. Server state goes through TanStack Query; the seat
 * map polls every 7 s (see docs/API_CONTRACT.md § Conventions), so defaults
 * here stay conservative and per-query options do the tuning.
 *
 * `<Toaster />` is mounted here rather than inside a page, because the toast
 * queue in `components/ui/Toast.tsx` is a module-level store: `pushToast()`
 * works from anywhere, but the messages are only ever *shown* by a mounted
 * viewport. One at the root means every route can raise a toast, and there is
 * exactly one — two viewports would render every toast twice.
 */
export default function Providers({ children }: { children: ReactNode }) {
  // One client per browser session, created lazily so it is never shared
  // between requests during SSR.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
