import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api.ts";

/**
 * The cache is invalidated by the SSE stream, never by a timer.
 *
 * `staleTime: Infinity` and every refetch trigger off is the whole point: if React Query also
 * polled, two sources would be racing to decide what is current and the stream would stop being
 * the source of truth. The one exception is `refetchOnReconnect`, which is not polling — it is
 * the catch-up read after the browser has been offline, and it pairs with the stream's own
 * `stream:reset` handling.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: 5 * 60_000,
        refetchInterval: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          // A 4xx will not fix itself; only retry transport failures and server faults.
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
