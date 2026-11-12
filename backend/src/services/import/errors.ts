/** The import's failures a member is told about, and the reason a failed sync gives. */
import { ControlPlaneError } from '../controlPlaneErrors.js';

/** The ledger's organization has no SimpleFin connection: a setup step, not a failure. */
export class NoSimpleFinConnectionError extends ControlPlaneError {
  constructor() {
    super(404, 'NO_SIMPLEFIN_CONNECTION', 'No SimpleFin connection for this organization. Connect one in Settings → Bank Import.');
    this.name = 'NoSimpleFinConnectionError';
  }
}

/**
 * Another bank sync of this ledger is running. Syncs of one ledger don't run at
 * once: they would fetch the same answer and race to write it. The second one is turned
 * away rather than queued behind the first, which can hold its transaction for a minute
 * or more (SimpleFin's own answer can take 60 s); it would only redo the same work.
 */
export class SyncInProgressError extends ControlPlaneError {
  constructor() {
    super(409, 'SYNC_IN_PROGRESS', 'A bank sync of this tenant is already running. Try again when it has finished.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * SimpleFin refused, timed out, or answered something unusable. Its message is ours,
 * written for the member (answered by the import routes, kept in the sync log); the
 * status says the fault was upstream (502/503/504).
 */
export class SimpleFinUpstreamError extends ControlPlaneError {
  constructor(status: 502 | 503 | 504, code: string, message: string, options?: ErrorOptions) {
    super(status, code, message);
    this.name = 'SimpleFinUpstreamError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** A failed sync's reason, as the sync log keeps it and the sync routes answer it. */
export const SYNC_FAILED_REASON = 'Sync failed with an internal error; the server log has the details';
