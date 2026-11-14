import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { CONTROL_PLANE_VOCABULARIES, TENANT_VOCABULARIES } from '@nuggets/shared';
import { TENANT_SETTING_KEYS } from '../services/tenantSettings.js';

/**
 * The shared vocabulary constants (`@nuggets/shared` vocabulary.ts) are the lists the
 * database enforces: the arguments of each `check_known_or_unchanged` trigger, and
 * the values of each `<column> IN (…)` CHECK, on every public table. Read from the catalog
 * as the owner, so a migration that changes a list fails here until shared does.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const sorted = (values: readonly string[]) => [...values].sort();

/**
 * Lists kept somewhere other than shared vocabulary.ts, with the constant that holds them:
 * tenant_settings' keys are the backend's (services/tenantSettings.ts), not a vocabulary.
 */
const BACKEND_LISTS: Readonly<Record<string, readonly string[]>> = {
  'tenant_settings.setting_key': TENANT_SETTING_KEYS,
};
const VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  ...TENANT_VOCABULARIES,
  ...CONTROL_PLANE_VOCABULARIES,
  ...BACKEND_LISTS,
};
const sharedList = (column: string) => (Object.hasOwn(VOCABULARIES, column) ? VOCABULARIES[column] : undefined);

/**
 * CHECKs that compare with a quoted value but aren't a list of values, by `table.constraint`:
 * a format or a pairing. A new one fails "reads every list CHECK" until it is named here.
 */
const NOT_LISTS: Readonly<Record<string, string>> = {
  'backup_recipients.backup_recipients_recipient_check': 'an age public key (a prefix, LIKE, and a length)',
  'backup_runs.backup_runs_file_check': 'a run that succeeded names the file it made',
  'holding_events.holding_events_adjusted_through_action_check': 'the event types that can be adjusted for later splits, a few of the list',
  'login_throttles.login_throttles_throttle_key_check': 'a hex digest (regex)',
  'securities.securities_exchange_normalized': 'an exchange trimmed and in upper case, not empty',
  'securities.securities_ticker_trimmed': 'a ticker not empty and without surrounding spaces',
  'organization_invitations.organization_invitations_email_check': 'a lower-case, non-empty email',
  'organization_invitations.organization_invitations_token_hash_check': 'a hex digest (regex)',
  'passkey_credentials.passkey_credentials_user_handle_check': 'a base64url WebAuthn user handle (regex)',
  'users.users_webauthn_user_id_check': 'a base64url WebAuthn user handle (regex)',
  'webauthn_challenges.webauthn_challenges_browser_hash_check': 'a hex digest (regex)',
  'webauthn_challenges.webauthn_challenges_user_check': 'an authentication challenge has no user, the others one',
};

/** Add a list to a column's lists: a column can be checked twice, and every check must match. */
function addList(map: Map<string, string[][]>, column: string, values: string[]) {
  map.set(column, [...(map.get(column) ?? []), values]);
}

/**
 * The column and values of a list CHECK as Postgres prints it: CHECK ((col = ANY (ARRAY['a'::text,
 * …]))), CHECK (((col)::text = ANY ((ARRAY['a'::character varying, …])::text[]))), the same with
 * each value cast (('a'::character varying)::text), and any of them after `(col IS NULL) OR` for
 * a nullable list. Null when it isn't one of those: one column, compared with one list.
 */
function parseListCheck(def: string): { column: string; values: string[] } | null {
  const m = /^CHECK \(\(*(?:(\w+) IS NULL\) OR \(*)?(\w+)\)*(?:::text)? = ANY \(\(*ARRAY\[([^\]]*)\]/.exec(def);
  if (!m || (def.match(/= ANY \(/g) ?? []).length !== 1) return null;
  const [, nullable, column, list] = m;
  if (nullable !== undefined && nullable !== column) return null;
  return { column, values: [...list.matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replaceAll("''", "'")) };
}

describe('parseListCheck', () => {
  it('reads each form Postgres prints a list CHECK in', () => {
    expect(parseListCheck(`CHECK ((scope = ANY (ARRAY['read'::text, 'read_write'::text])))`)).toEqual({ column: 'scope', values: ['read', 'read_write'] });
    expect(parseListCheck(`CHECK (((status)::text = ANY (ARRAY[('active'::character varying)::text, ('paused'::character varying)::text])))`))
      .toEqual({ column: 'status', values: ['active', 'paused'] });
    expect(parseListCheck(`CHECK (((source_system)::text = ANY ((ARRAY['system'::character varying, 'it''s'::character varying])::text[])))`))
      .toEqual({ column: 'source_system', values: ['system', "it's"] });
    expect(parseListCheck(`CHECK (((fee_type IS NULL) OR ((fee_type)::text = ANY (ARRAY[('advisory'::character varying)::text]))))`))
      .toEqual({ column: 'fee_type', values: ['advisory'] });
  });
  it('reads nothing else as a list', () => {
    expect(parseListCheck(`CHECK ((throttle_key ~ '^[0-9a-f]{64}$'::text))`)).toBeNull();
    expect(parseListCheck(`CHECK (((purpose = 'authentication'::text) = (user_id IS NULL)))`)).toBeNull();
    expect(parseListCheck(`CHECK (((other IS NULL) OR ((fee_type)::text = ANY (ARRAY['a'::text]))))`)).toBeNull();
    expect(parseListCheck(`CHECK (((a)::text = ANY (ARRAY['x'::text])) AND ((b)::text = ANY (ARRAY['y'::text])))`)).toBeNull();
  });
});

describeDb('shared vocabularies match the database', () => {
  let owner: Pool;
  let triggers: Map<string, string[][]>; // table.column -> each enabled trigger's allowed values
  let checks: Map<string, string[][]>;
  let disabled: string[]; // vocabulary triggers that don't enforce their list
  let unparsed: string[]; // list CHECKs this file can't read

  beforeAll(async () => {
    owner = new Pool({ connectionString });
    // tgargs is the trigger's arguments, NUL-separated: the column, then its values.
    // A trigger enforces its list only if it fires (enabled 'O' or 'A'; 'R' fires only on a
    // replica, 'D' never), as a BEFORE ROW trigger on INSERT and UPDATE (tgtype bits 1, 2, 4,
    // 16), with no WHEN condition.
    const t = await owner.query<{ tbl: string; name: string; enforces: boolean; args: string[] }>(`
      SELECT c.relname AS tbl, tg.tgname AS name,
             (tg.tgenabled IN ('O', 'A') AND (tg.tgtype & 23) = 23 AND tg.tgqual IS NULL) AS enforces,
             (regexp_split_to_array(encode(tg.tgargs, 'escape'), '\\\\000'))[1:tg.tgnargs] AS args
        FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = tg.tgfoid
       WHERE n.nspname = 'public' AND p.proname = 'check_known_or_unchanged' AND NOT tg.tgisinternal`);
    triggers = new Map();
    disabled = [];
    for (const r of t.rows) {
      if (!r.enforces) disabled.push(`${r.tbl}.${r.name}`);
      else addList(triggers, `${r.tbl}.${r.args[0]}`, r.args.slice(1));
    }

    // Every CHECK on a public table (the budget event log's, the investment tables', the
    // control plane's), not only the ones some list here already names.
    const c = await owner.query<{ tbl: string; name: string; def: string }>(`
      SELECT c.relname AS tbl, con.conname AS name, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND con.contype = 'c'`);
    checks = new Map();
    unparsed = [];
    for (const { tbl, name, def } of c.rows) {
      // A CHECK that compares with a quoted value is a list (Postgres writes a one-value IN
      // ('x') as = 'x', and someone may write a = 'x' OR a = 'y'), unless NOT_LISTS says
      // what else it is. Others (signs, ranges) aren't. Anything else is reported, not skipped.
      if (!/'/.test(def) || Object.hasOwn(NOT_LISTS, `${tbl}.${name}`)) continue;
      const list = parseListCheck(def);
      if (!list) {
        unparsed.push(`${tbl}.${name}: ${def}`);
        continue;
      }
      addList(checks, `${tbl}.${list.column}`, list.values);
    }
  });

  afterAll(async () => {
    await owner?.end();
  });

  it('reads the database lists (a catalog query that finds nothing would pass everything)', () => {
    expect(triggers.size).toBeGreaterThanOrEqual(19);
    // The budget event log's 4, the bill, investment and tag lists, and the control plane's.
    expect(checks.size).toBeGreaterThanOrEqual(19);
    for (const column of ['budget_period_transactions.type', 'holding_events.fee_type', 'tax_lots.acquisition_method', 'budget_items.status', 'personal_access_tokens.scope']) {
      expect(checks.has(column), column).toBe(true);
    }
  });

  it('every vocabulary trigger enforces its list', () => {
    expect(disabled, 'check_known_or_unchanged triggers that are off, replica-only, conditional or not BEFORE INSERT OR UPDATE').toEqual([]);
  });

  it('every check_known_or_unchanged trigger has a shared constant with its values', () => {
    for (const [column, lists] of triggers) {
      const shared = sharedList(column);
      expect(shared, `${column} has a vocabulary trigger but no constant in shared vocabulary.ts`).toBeDefined();
      for (const values of lists) expect(sorted(shared ?? []), column).toEqual(sorted(values));
    }
  });

  it('reads every list CHECK', () => {
    expect(unparsed, 'CHECKs with a quoted value this test cannot read: extend its parser, or name one that is not a list in NOT_LISTS').toEqual([]);
  });

  it('every list CHECK has a shared constant with its values', () => {
    for (const [column, lists] of checks) {
      const shared = sharedList(column);
      expect(shared, `${column} has an IN (…) CHECK but no constant in shared vocabulary.ts`).toBeDefined();
      for (const values of lists) expect(sorted(shared ?? []), column).toEqual(sorted(values));
    }
  });

  it('every shared constant is enforced by the database', () => {
    for (const column of Object.keys(VOCABULARIES)) {
      expect(triggers.has(column) || checks.has(column), `${column} is in shared but the database checks no list`).toBe(true);
    }
  });

  it('every CHECK named as not a list still exists', () => {
    const named = Object.keys(NOT_LISTS);
    return owner
      .query<{ key: string }>(`
        SELECT c.relname || '.' || con.conname AS key
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND con.contype = 'c' AND c.relname || '.' || con.conname = ANY ($1)`, [named])
      .then(({ rows }) => expect(sorted(rows.map((r) => r.key))).toEqual(sorted(named)));
  });
});
