import { useCallback, useRef, useState } from 'react';
import { isReauthRequiredError } from '../services/api';

/** Thrown by `withReauth` when the user closes the prompt instead of confirming. */
export class ReauthCancelledError extends Error {
  constructor() {
    super('Confirmation cancelled');
    this.name = 'ReauthCancelledError';
  }
}

export const isReauthCancelledError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ReauthCancelledError';

export interface ReauthDialogProps {
  open: boolean;
  /** The user confirmed their password or passkey. */
  onConfirmed: () => void;
  /** The user closed the prompt. */
  onCancel: () => void;
}

/**
 * Step-up prompt for actions the server only allows right after the user confirmed their
 * password or a passkey (creating an MCP token, adding a passkey). `withReauth(action)`
 * runs the action; when the server answers REAUTH_REQUIRED it opens the prompt (render
 * `<ReauthDialog {...dialogProps} />`) and, once the user confirms, runs the action again.
 * If they close the prompt it rejects with ReauthCancelledError.
 */
export function useReauth() {
  const [open, setOpen] = useState(false);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const finish = useCallback((confirmed: boolean) => {
    setOpen(false);
    const resolve = pending.current;
    pending.current = null;
    resolve?.(confirmed);
  }, []);

  const askToConfirm = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setOpen(true);
      }),
    []
  );

  const withReauth = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isReauthRequiredError(err)) throw err;
        if (!(await askToConfirm())) throw new ReauthCancelledError();
        return action();
      }
    },
    [askToConfirm]
  );

  const dialogProps: ReauthDialogProps = {
    open,
    onConfirmed: () => finish(true),
    onCancel: () => finish(false),
  };
  return { withReauth, dialogProps };
}
