import { QueryClient, QueryCache } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { logger } from '../utils/logger';
import { isSessionExpiredError } from '../services/api/base';

type ApiErrorLike = Error & { status?: number };

/**
 * Shared React Query client for the app.
 *
 * staleTime tiers: 30s global default (financial data — never minutes stale, but
 * back/forward nav renders instantly with a background refetch). Reference data
 * (categories/merchants/institutions/tags/templates) overrides to 5 min at the
 * hook level; edit-form detail fetches override to 0 at the call site.
 *
 * Query errors surface a toast centrally here (opt out per-query with
 * `meta: { suppressErrorToast: true }` when the page renders its own error UI).
 * Mutations keep contextual per-hook toasts.
 *
 * 401s reject with `SessionExpiredError` (`services/api/base.ts`), which also
 * dispatches `session-expired` (AuthContext logs out + toasts). Queries settle
 * as errors instead of hanging in `isLoading` forever; the
 * duplicate toast is suppressed here and 401s/403s are not retried.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      logger.error({ err: error, queryKey: query.queryKey }, 'Query failed');
      if (query.meta?.suppressErrorToast) {
        return;
      }
      // AuthContext owns the session-expired notification + redirect.
      if (isSessionExpiredError(error)) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Failed to load data';
      toast.error(message);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        const status = (error as ApiErrorLike)?.status;
        // 401 → logout is already in flight; 403 → retrying can't help.
        if (status === 401 || status === 403) {
          return false;
        }
        return failureCount < 1;
      },
    },
  },
});
