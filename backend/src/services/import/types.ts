/** The shapes SimpleFin answers with (protocol v2), and the options a fetch takes. */
import type { SimpleFinProtocolError, SimpleFinConnection } from '@nuggets/shared';

export interface SimplefinAccount {
  /** v2 — links the account to a Connection in the AccountSet's connections[]. */
  conn_id?: string;
  /** v2 — sometimes echoed on the account; connection display name. */
  conn_name?: string;
  id: string;
  name: string;
  currency: string;
  balance: string;
  'available-balance'?: string;
  'balance-date': number; // Unix timestamp
  transactions?: SimplefinTransaction[];
  /** Provider-specific fields; an object per the SimpleFin spec. */
  extra?: Record<string, unknown>;
  /**
   * v1 (DEPRECATED, replaced by conn_id and connections[]): the institution, per account. A
   * bridge may still send it beside a v2 answer, or instead of a connection.
   */
  org?: { domain?: string; 'sfin-url'?: string; name?: string; url?: string; id?: string };
}

export interface SimplefinTransaction {
  id: string;
  posted: number; // Unix timestamp
  amount: string;
  description: string;
  // Optional per the SimpleFin spec, but bridges that send them carry the
  // best data in the payload: payee is a pre-cleaned merchant name ("Sample Mart"
  // for description "SAMPLE MART MKTPLACE SAMPLEMART.EXAMPLE/BILL XX"), memo is extra
  // context (e.g. "Dividend Payment - EQFUND" on a brokerage sweep).
  payee?: string;
  memo?: string;
  transacted_at?: number;
  pending?: boolean;
  /** Provider-specific fields; an object per the SimpleFin spec. */
  extra?: Record<string, unknown>;
}

/** Normalized institution descriptor, resolved from a v2 Connection. */
export type ResolvedInstitution = {
  domain?: string;
  'sfin-url'?: string;
  name?: string;
  url?: string;
  id?: string;
};

export interface SimplefinAccountSet {
  /** v1 (DEPRECATED) — plain strings. Normalized into `errlist` on read. */
  errors?: string[];
  /** v2 — structured errors. Our code reads this. */
  errlist?: SimpleFinProtocolError[];
  /** v2 — connection objects (one credential set per bank). */
  connections?: SimpleFinConnection[];
  accounts: SimplefinAccount[];
  /**
   * Ours, not SimpleFin's: the start-date this answer was asked for (import_days_back), or
   * null for all history. Its transactions posted on or after it (unsavedRows.ts reads it).
   */
  requestedStartDate?: Date | null;
}

export interface ImportSyncOptions {
  startDate?: Date;
  endDate?: Date;
  includePending?: boolean;
  balancesOnly?: boolean;
  accountId?: string;
}
