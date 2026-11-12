import type { SyncAnswer } from '../services/api/import';
import { isSessionExpiredError } from '../services/api/base';

/**
 * What to tell a member whose manual bank sync was refused. A 4xx answer carries text
 * meant for them: another sync of this Ledger is running (409), there is no SimpleFin
 * connection (404), too many syncs this hour (429). The API helpers put it in
 * `error.message`, already in Ledger wording. Anything else gets `fallback`. An expired
 * session gets null: AuthContext has already said so, and a second toast repeated it.
 */
export function syncFailureMessage(error: unknown, fallback: string): string | null {
  const status = (error as { status?: unknown } | null)?.status;
  if (isSessionExpiredError(error) || status === 401) return null;
  if (
    error instanceof Error &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500 &&
    error.message
  ) {
    return error.message;
  }
  return fallback;
}

/** How a finished sync should be shown: a 'warning' when it was partial. */
export function syncOutcomeNotice(answer: SyncAnswer, successText: string): { tone: 'success' | 'warning' | 'error'; text: string } {
  if (!answer.success) return { tone: 'error', text: answer.error || answer.message || 'Sync failed' };
  if (answer.status === 'partial') return { tone: 'warning', text: answer.message || 'Sync completed with problems' };
  return { tone: 'success', text: answer.message || successText };
}
