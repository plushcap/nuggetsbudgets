import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import path from 'path';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../app.js';
import { mountRoutes } from '../routes.js';
import { sessionService } from '../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../utils/session-cookie-config.js';
// The CSRF token is bound to the session.
import { csrfTokenFor } from '../utils/csrfToken.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { getDirname } from '../utils/esm-compat.js';

/**
 * Two ledgers in two organizations, through the real app: what a signed-in
 * user of ledger B does through the API must not reveal or change ledger A's data.
 *
 * Ledger A gets one of each main resource, its names carrying a marker and its amounts
 * distinctive values. B's user administers ledger B and its organization. As B:
 * - every member, tenant-admin, org-admin and signed-in route with a path parameter is
 *   called with A's ids, and every such read without one too; organization routes again
 *   with B's own organization first, so their handlers run with A's ids after it. No
 *   answer may show A's marker, names, amounts, uuids or email, and no write sent with the
 *   sweep's one generic body may succeed;
 * - the main resources' GET/PUT/DELETE, A's memberships, sessions, tokens, passkeys and
 *   invitations (even with the token), switching to ledger A, and writes with valid bodies
 *   the sweep can't send, are refused;
 * - B's writes without an id of A's (renaming its ledger and organization, its profile,
 *   ledger and organization settings, MCP tokens, adding and inviting members, signing out
 *   everywhere)
 *   stay in B's ledger, organization and account. Not sent: creating a ledger, the
 *   price-sync run and SimpleFin connect (they reach the network), and changing the
 *   password (the fixture user has no real password);
 * - afterwards A's rows, and its organization, user and session rows, are exactly as they
 *   were. Nothing is sent as A after the control, since that updates A's session.
 * A's own requests are the control: the same ones reach the data when it's yours.
 *
 * What this can't see:
 * - a leak with nothing identifying in it, such as a bare count or sum;
 * - data in tables not seeded here, and in tables the app only reads through a join to a
 *   protected parent (taggings, bill occurrences, tax lots, prices, holding events), where
 *   opening one alone changes no answer. The RLS catalog test pins every table's policy;
 * - reads that take their ids from query parameters, and writes the sweep's generic body
 *   doesn't get past validation with, apart from the targeted checks;
 * - a second path parameter on non-organization routes, since A's first one is refused
 *   first (cross-tenant references);
 * - deployment-wide rows (`system_settings`, `deployment`), which other test files change
 *   in parallel, so only the probe key written here is checked;
 * - two ledgers in the same organization, which can see some of each other's bank
 *   mappings by design.
 * Deployment-admin routes are cross-tenant by design and aren't swept.
 *
 * The route list is the route-authorization snapshot, which that test keeps in step with
 * the app. A new swept route with a path parameter fails here until urlFor has an id for it.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const ROUTES_FILE = path.join(getDirname(import.meta.url), '__snapshots__', 'route-authorization.routes.txt');
const UPLOAD_DIR = path.join(getDirname(import.meta.url), '..', '..', 'uploads'); // as routes/attachments.ts
const SWEPT_LEVELS = new Set(['user', 'member', 'tenantAdmin', 'orgAdmin']);
// GET /api/mcp opens the MCP event stream, which doesn't end.
const NOT_SWEPT = new Set(['GET /api/mcp']);
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const CSRF_TOKEN = 'tenant-isolation-csrf-token';
// What B writes, so a write that wrongly lands in A shows up in A's rows, not as the marker.
const HIJACK = 'hijacked-by-ledger-b';
// Ledger A's amounts, chosen to appear nowhere else.
const AMOUNTS = { transaction: '4321.87', netWorth: '87654.21', bill: '1357.91', budgetEvent: '765.43', price: '432.19' };

// Leaks and wrong answers found today, each a tracked bug. Once one is fixed this test
// fails until its entry goes: what's found must match these lists exactly.
const KNOWN_LEAKS: string[] = [];
// Writes the sweep sends with A's ids and its generic body that succeed anyway.
const KNOWN_SWEEP_SUCCESSES: string[] = [];
// Targeted requests that should be refused but aren't.
const KNOWN_WRONG_ANSWERS: string[] = [];

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

interface Route {
  level: string;
  method: string;
  path: string;
}

function sweptRoutes(): Route[] {
  return readFileSync(ROUTES_FILE, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [level, method, routePath] = line.trim().split(/\s+/);
      return { level, method, path: routePath };
    })
    .filter((r) => SWEPT_LEVELS.has(r.level) && !NOT_SWEPT.has(`${r.method} ${r.path}`));
}

type Ref = { id: number; uuid: string };

describeDb('Tenant isolation through the API', () => {
  let server: http.Server;
  let owner: Pool;
  let a: TestTenant;
  let b: TestTenant;
  const sessions: Record<'a' | 'b', { token: string; id: number; uuid: string }> = {} as never;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const marker = `isolation-a-${stamp}`;
  const attachmentFile = `isolation-${stamp}.pdf`;
  const seed = {} as Record<
    | 'category'
    | 'institution'
    | 'account'
    | 'brokerage'
    | 'merchant'
    | 'merchantRule'
    | 'budgetItem'
    | 'bill'
    | 'goal'
    | 'budgetItemRule'
    | 'period'
    | 'periodItem'
    | 'budgetEvent'
    | 'transaction'
    | 'tag'
    | 'security'
    | 'holding'
    | 'lot'
    | 'price'
    | 'netWorth'
    | 'annotation'
    | 'occurrence'
    | 'attachment'
    | 'image',
    Ref
  >;
  // A's identities outside its ledger's own tables.
  const ids = {} as {
    tenantUuid: string;
    orgUuid: string;
    userUuid: string;
    memberUuid: string; // tenant_users.uuid
    orgMemberUuid: string; // organization_users.uuid
    tokenUuid: string; // personal_access_tokens.uuid
    credentialId: string; // passkey_credentials.credential_id
    invitationUuid: string; // organization_invitations.uuid, an invitation of A's organization to A's email
    bOrgUuid: string; // B's own organization
  };
  // The link token of that invitation (only its hash is stored).
  const invitationToken = randomBytes(32).toString('base64url');
  const probeSetting = `isolation_probe_${stamp}`;
  let bTransaction: Ref; // B's own, to try pointing it at A's user
  let fingerprintBefore: Map<string, string>;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'tenant-isolation-test-encryption-key-0123456789';
    const app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    owner = new Pool({ connectionString, max: 2 });
    a = await createTestTenant('Isolation A');
    b = await createTestTenant('Isolation B');
    for (const [key, tenant] of [['a', a], ['b', b]] as const) {
      // Each user administers their own ledger and organization, so those routes are swept too.
      await owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [
        tenant.tenantId,
        tenant.userId,
      ]);
      await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [
        tenant.organizationId,
        tenant.userId,
      ]);
      const { token, sessionId } = await sessionService.createSession({ userId: tenant.userId });
      const row = await owner.query<{ uuid: string }>(
        'UPDATE sessions SET active_tenant_id = $1 WHERE id = $2 RETURNING uuid',
        [tenant.tenantId, sessionId]
      );
      sessions[key] = { token, id: sessionId, uuid: row.rows[0].uuid };
    }
    const first = async <T>(sql: string, params: unknown[]): Promise<T> => (await owner.query(sql, params)).rows[0];
    ids.tenantUuid = (await first<{ uuid: string }>('SELECT uuid FROM tenants WHERE id = $1', [a.tenantId])).uuid;
    ids.orgUuid = (await first<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [a.organizationId])).uuid;
    ids.bOrgUuid = (await first<{ uuid: string }>('SELECT uuid FROM organizations WHERE id = $1', [b.organizationId])).uuid;
    ids.userUuid = (await first<{ uuid: string }>('SELECT uuid FROM users WHERE id = $1', [a.userId])).uuid;
    ids.memberUuid = (
      await first<{ uuid: string }>('SELECT uuid FROM tenant_users WHERE tenant_id = $1 AND user_id = $2', [
        a.tenantId,
        a.userId,
      ])
    ).uuid;
    ids.orgMemberUuid = (
      await first<{ uuid: string }>('SELECT uuid FROM organization_users WHERE organization_id = $1 AND user_id = $2', [
        a.organizationId,
        a.userId,
      ])
    ).uuid;
    ids.tokenUuid = (
      await first<{ uuid: string }>(
        `INSERT INTO personal_access_tokens (user_id, tenant_id, jti, label, audience, expires_at)
         VALUES ($1, $2, $3, $4, 'mcp', now() + interval '1 day') RETURNING uuid`,
        [a.userId, a.tenantId, `isolation-${stamp}`, `${marker}-token`]
      )
    ).uuid;
    // A SimpleFin connection for A's organization: an unscoped delete through B's would remove it.
    // access_url is never decrypted here.
    await owner.query(
      `INSERT INTO organization_simplefin_connections (organization_id, access_url, label) VALUES ($1, 'unused', $2)`,
      [a.organizationId, `${marker}-simplefin`]
    );
    ids.invitationUuid = (
      await first<{ uuid: string }>(
        `INSERT INTO organization_invitations (organization_id, email, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '1 day') RETURNING uuid`,
        [a.organizationId, a.userEmail, createHash('sha256').update(invitationToken).digest('hex'), a.userId]
      )
    ).uuid;
    ids.credentialId = `isolation-credential-${stamp}`;
    await owner.query(
      `INSERT INTO passkey_credentials (user_id, credential_id, public_key, device_name) VALUES ($1, $2, 'x', $3)`,
      [a.userId, ids.credentialId, `${marker}-passkey`]
    );

    // Bills are shown by the app's current month, which is in its time zone, not the database's.
    const today: string = (await send('a', 'GET', '/api/bills').expect(200)).body.today;

    // Ledger A's data, inserted through its own RLS-scoped pool.
    const one = async (sql: string, params: unknown[] = []): Promise<Ref> =>
      (await a.pool.query<Ref>(`${sql} RETURNING id, uuid`, params)).rows[0];
    const m = (what: string) => `${marker}-${what}`;
    seed.category = await one('INSERT INTO categories (name) VALUES ($1)', [m('category')]);
    seed.institution = await one('INSERT INTO account_institutions (name) VALUES ($1)', [m('institution')]);
    seed.account = await one(
      `INSERT INTO accounts (name, account_type, account_group, type, institution_id)
       VALUES ($1, 'checking', 'cash', 'Asset', $2)`,
      [m('account'), seed.institution.id]
    );
    seed.brokerage = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset')`,
      [m('brokerage')]
    );
    seed.merchant = await one('INSERT INTO merchants (name) VALUES ($1)', [m('merchant')]);
    seed.merchantRule = await one(
      `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', $2)`,
      [seed.merchant.id, m('merchant-rule')]
    );
    seed.budgetItem = await one(
      `INSERT INTO budget_items (name, status, category_id, merchant_id) VALUES ($1, 'active', $2, $3)`,
      [m('budget-item'), seed.category.id, seed.merchant.id]
    );
    seed.bill = await one(
      `INSERT INTO budget_items
         (name, status, isbill, recurring_payment_frequency, recurring_next_payment_date, recurring_payment_amount)
       VALUES ($1, 'active', true, 1, $2, $3)`,
      [m('bill'), today, AMOUNTS.bill]
    );
    seed.goal = await one(
      `INSERT INTO budget_items (name, status, type, expense_type, goal_target_amount)
       VALUES ($1, 'active', 'Goal', 'Savings', 1000)`,
      [m('goal')]
    );
    seed.budgetItemRule = await one(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text) VALUES ($1, 'contains', $2)`,
      [seed.budgetItem.id, m('budget-item-rule')]
    );
    seed.period = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       SELECT $1, to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM (SELECT date_trunc('month', app_today())::date AS d) s`,
      [m('period')]
    );
    seed.periodItem = await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [
      seed.period.id,
      seed.budgetItem.id,
    ]);
    seed.budgetEvent = await one(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount, description)
       VALUES ($1, $2, 'add', 'budget_update', $3, $4)`,
      [seed.periodItem.id, seed.budgetItem.id, AMOUNTS.budgetEvent, m('budget-event')]
    );
    seed.transaction = await one(
      `INSERT INTO transactions
         (account_id, amount, transaction_date, type, description, merchant_id, budget_item_id,
          budget_period_id, budget_period_item_id)
       VALUES ($1, $2, app_today(), 'expense', $3, $4, $5, $6, $7)`,
      [
        seed.account.id,
        `-${AMOUNTS.transaction}`,
        m('transaction'),
        seed.merchant.id,
        seed.budgetItem.id,
        seed.period.id,
        seed.periodItem.id,
      ]
    );
    seed.tag = await one('INSERT INTO tags (name) VALUES ($1)', [m('tag')]);
    await a.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [
      seed.tag.id,
      seed.transaction.id,
    ]);
    seed.security = await one('INSERT INTO securities (ticker, name) VALUES ($1, $2)', [
      `ISO${stamp.slice(-6)}`,
      m('security'),
    ]);
    seed.holding = await one(
      `INSERT INTO holding_events (account_id, security_id, event_type, event_date, shares, price_per_share, total_amount, description)
       VALUES ($1, $2, 'buy', app_today() - 30, 10, 100, 1000, $3)`,
      [seed.brokerage.id, seed.security.id, m('holding')]
    );
    seed.lot = await one(
      `INSERT INTO tax_lots
         (account_id, security_id, created_by_event_id, acquisition_date, holding_period_start,
          shares_original, shares_remaining, cost_basis_per_share, total_cost_basis, acquisition_method, is_open)
       VALUES ($1, $2, $3, app_today() - 30, app_today() - 30, 10, 10, 100, 1000, 'purchase', true)`,
      [seed.brokerage.id, seed.security.id, seed.holding.id]
    );
    seed.price = await one('INSERT INTO security_prices (security_id, price_date, close) VALUES ($1, app_today(), $2)', [
      seed.security.id,
      AMOUNTS.price,
    ]);
    seed.netWorth = await one(
      `INSERT INTO net_worth_snapshots (snapshot_date, total_assets, total_liabilities, net_worth)
       VALUES (app_today() - 1, $1, 0, $1)`,
      [AMOUNTS.netWorth]
    );
    seed.annotation = await one(
      `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'note', $2)`,
      [seed.transaction.id, m('annotation')]
    );
    seed.occurrence = await one(
      'INSERT INTO bill_occurrences (budget_item_id, due_date, expected_amount) VALUES ($1, $2, $3)',
      [seed.bill.id, today, AMOUNTS.bill]
    );
    mkdirSync(UPLOAD_DIR, { recursive: true });
    writeFileSync(path.join(UPLOAD_DIR, attachmentFile), `%PDF-1.4 ${marker}`);
    seed.attachment = await one(
      `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, transaction_id)
       VALUES ($1, $1, $2, 'pdf', $2, $3)`,
      [m('attachment'), attachmentFile, seed.transaction.id]
    );
    // A ledger image, as storeImage writes one (profile pictures are user_profile_images rows).
    seed.image = await one(
      `INSERT INTO stored_images (tenant_id, mime_type, byte_size, data)
       VALUES (current_setting('app.current_tenant_id')::int, 'image/png', 4, '\\x89504e47')`
    );

    // B's own transaction.
    const bAccount = await b.pool.query<Ref>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('B checking', 'checking', 'cash', 'Asset')
       RETURNING id, uuid`
    );
    bTransaction = (
      await b.pool.query<Ref>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -1, app_today(), 'expense', 'B transaction') RETURNING id, uuid`,
        [bAccount.rows[0].id]
      )
    ).rows[0];
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    rmSync(path.join(UPLOAD_DIR, attachmentFile), { force: true });
    if (!owner) return;
    try {
      const userIds = [a?.userId, b?.userId].filter((id) => id != null);
      await owner.query('DELETE FROM sessions WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM passkey_credentials WHERE user_id = ANY($1)', [userIds]);
      await owner.query('DELETE FROM organization_users WHERE user_id = ANY($1)', [userIds]);
      const orgIds = [a?.organizationId, b?.organizationId].filter((id) => id != null);
      for (const table of ['organization_simplefin_connections', 'organization_price_sync_settings', 'organization_price_sync_runs']) {
        await owner.query(`DELETE FROM ${table} WHERE organization_id = ANY($1)`, [orgIds]);
      }
      await owner.query('DELETE FROM system_settings WHERE setting_key = $1', [probeSetting]);
      const settled = await Promise.allSettled([a?.cleanup(), b?.cleanup()]);
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      await owner.end();
    }
  }, 60_000);

  /** A route's URL with A's ids for its path parameters, and the parameters it has no id for. */
  function urlFor(routePath: string, opts: { ownOrg?: boolean } = {}): { url: string; unmapped: string[] } {
    const byParam: Record<string, string | number> = {
      accountId: seed.account.id,
      accountUuid: seed.account.uuid,
      budgetItemId: seed.budgetItem.id,
      budgetItemUuid: seed.budgetItem.uuid,
      budgetPeriodItemId: seed.periodItem.id,
      budgetPeriodItemUuid: seed.periodItem.uuid,
      credentialId: ids.credentialId,
      invitationUuid: ids.invitationUuid,
      memberUuid: ids.orgMemberUuid,
      merchantUuid: seed.merchant.uuid,
      periodId: seed.period.id,
      periodUuid: seed.period.uuid,
      rootTagUuid: seed.tag.uuid,
      securityUuid: seed.security.uuid,
      tagId: seed.tag.id,
      tagUuid: seed.tag.uuid,
      transactionUuid: seed.transaction.uuid,
    };
    const bySegment: Record<string, string> = {
      accounts: seed.account.uuid,
      annotations: seed.annotation.uuid,
      attachments: seed.attachment.uuid,
      bills: seed.bill.uuid,
      'budget-items': seed.budgetItem.uuid,
      'budget-periods': seed.period.uuid,
      categories: seed.category.uuid,
      file: seed.attachment.uuid,
      goals: seed.goal.uuid,
      images: seed.image.uuid,
      institutions: seed.institution.uuid,
      'item-matching-rules': seed.budgetItemRule.uuid,
      items: seed.budgetItem.uuid,
      lots: seed.lot.uuid,
      'mcp-tokens': ids.tokenUuid,
      'merchant-spending': seed.merchant.uuid,
      members: ids.memberUuid,
      merchants: seed.merchant.uuid,
      occurrences: seed.occurrence.uuid,
      organizations: opts.ownOrg ? ids.bOrgUuid : ids.orgUuid,
      'period-items': seed.periodItem.uuid,
      periods: seed.period.uuid,
      rules: seed.merchantRule.uuid,
      securities: seed.security.uuid,
      sessions: sessions.a.uuid,
      tags: seed.tag.uuid,
      transactions: seed.transaction.uuid,
    };
    const segments = routePath.split('/');
    const unmapped: string[] = [];
    const url = segments
      .map((segment, i) => {
        if (!segment.startsWith(':')) return segment;
        const name = segment.slice(1);
        const value = byParam[name] ?? (name === 'uuid' ? bySegment[segments[i - 1]] : undefined);
        if (value === undefined) unmapped.push(segment);
        return encodeURIComponent(String(value ?? NIL_UUID));
      })
      .join('/');
    return { url, unmapped };
  }

  function send(who: 'a' | 'b', method: string, url: string, body?: object) {
    const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const req = request(server)[verb](url)
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessions[who].token}; csrf_token=${CSRF_TOKEN}`)
      .set('X-CSRF-Token', csrfTokenFor(sessions[who].token))
      .timeout(15_000);
    return body ? req.send(body) : req;
  }

  /**
   * Every row of ledger A, per table, as A's own RLS-scoped pool sees it, and the rows of its
   * tenant, organization (every table with organization_id) and user (every table with
   * user_id but no tenant_id, e.g. sessions).
   */
  async function fingerprint(): Promise<Map<string, string>> {
    const columns = (
      await owner.query<{ table_name: string; column_name: string }>(
        `SELECT c.table_name, c.column_name
           FROM information_schema.columns c
           JOIN information_schema.tables t USING (table_schema, table_name)
          WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND c.column_name IN ('tenant_id', 'organization_id', 'user_id')`
      )
    ).rows;
    const has = (table: string, column: string) => columns.some((c) => c.table_name === table && c.column_name === column);
    const tables = [...new Set(columns.map((c) => c.table_name))].sort();
    const prints = new Map<string, string>();
    const print = async (key: string, pool: Pool, from: string, params: unknown[]) => {
      const res = await pool.query<{ print: string }>(
        `SELECT count(*) || ':' || md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS print FROM ${from}`,
        params
      );
      prints.set(key, res.rows[0].print);
    };
    for (const table of tables) {
      if (has(table, 'tenant_id')) {
        const pool = table === 'tenant_users' || table === 'personal_access_tokens' ? owner : a.pool;
        await print(table, pool, `"${table}" t WHERE tenant_id = $1`, [a.tenantId]);
      } else if (has(table, 'organization_id')) {
        await print(table, owner, `"${table}" t WHERE organization_id = $1`, [a.organizationId]);
      } else {
        await print(table, owner, `"${table}" t WHERE user_id = $1`, [a.userId]);
      }
    }
    await print('tenants row', owner, 'tenants t WHERE id = $1', [a.tenantId]);
    await print('organizations row', owner, 'organizations t WHERE id = $1', [a.organizationId]);
    await print('users row', owner, 'users t WHERE id = $1', [a.userId]);
    return prints;
  }

  const textOf = (res: request.Response): string =>
    typeof res.text === 'string' ? res.text : Buffer.isBuffer(res.body) ? res.body.toString('latin1') : JSON.stringify(res.body ?? '');

  /** What in a response would reveal A: its marker, names, amounts, or an id of A's the request didn't send. */
  function revealed(url: string, res: request.Response): string[] {
    const text = textOf(res);
    const found: string[] = [];
    if (text.includes(marker)) found.push('the marker');
    // A's ledger, organization and user are all named after this label (createTestTenant).
    if (text.includes('Isolation A')) found.push("A's ledger, organization or user name");
    if (text.includes(a.userEmail)) found.push('user email');
    for (const [name, amount] of Object.entries(AMOUNTS)) if (text.includes(amount)) found.push(`${name} amount`);
    const uuids: Record<string, string> = { aSession: sessions.a.uuid };
    for (const [name, value] of Object.entries(ids)) if (name !== 'bOrgUuid') uuids[name] = value;
    for (const [name, ref] of Object.entries(seed)) uuids[name] = ref.uuid;
    for (const [name, value] of Object.entries(uuids)) {
      if (text.includes(value) && !url.includes(encodeURIComponent(value))) found.push(name);
    }
    return found;
  }

  // The main resources' own routes, with a body each route accepts (checked as A first).
  const resources = () => [
    { name: 'account', base: '/api/accounts', ref: seed.account, body: { name: `${marker}-account`, account_type: 'checking' } },
    { name: 'transaction', base: '/api/transactions', ref: seed.transaction, body: { description: `${marker}-transaction` } },
    { name: 'budget item', base: '/api/budgets/items', ref: seed.budgetItem, body: { name: `${marker}-budget-item` }, noGet: true },
    { name: 'goal', base: '/api/goals', ref: seed.goal, body: { name: `${marker}-goal` } },
    { name: 'merchant', base: '/api/merchants', ref: seed.merchant, body: { name: `${marker}-merchant` } },
    { name: 'tag', base: '/api/tags', ref: seed.tag, body: { name: `${marker}-tag` } },
    { name: 'category', base: '/api/categories', ref: seed.category, body: { name: `${marker}-category`, icon: 'Tag' }, noGet: true },
    { name: 'institution', base: '/api/institutions', ref: seed.institution, body: { name: `${marker}-institution` } },
    { name: 'security', base: '/api/investments/securities', ref: seed.security, body: { name: `${marker}-security` } },
  ];

  it("lets A reach its own data (the control)", async () => {
    const problems: string[] = [];
    const check = (ok: boolean, what: string, res: request.Response) => {
      if (!ok) problems.push(`${what}: ${res.status} ${textOf(res).slice(0, 300)}`);
    };
    for (const r of resources()) {
      const list = await send('a', 'GET', r.base);
      check(list.status === 200 && textOf(list).includes(r.ref.uuid), `GET ${r.base} lists the ${r.name}`, list);
      if (!r.noGet) {
        const one = await send('a', 'GET', `${r.base}/${r.ref.uuid}`);
        check(one.status === 200 && textOf(one).includes(marker), `GET ${r.base}/:uuid`, one);
      }
      const put = await send('a', 'PUT', `${r.base}/${r.ref.uuid}`, r.body);
      check(put.status < 300, `PUT ${r.base}/:uuid`, put);
    }
    // Reads that show the other seeded rows, so the sweep can see them leak.
    const shows: Array<[string, string]> = [
      [`/api/images/${seed.image.uuid}`, 'PNG'],
      [`/api/attachments/file/${seed.attachment.uuid}`, marker],
      [`/api/transactions/${seed.transaction.uuid}/attachments`, marker],
      ['/api/bills', seed.bill.uuid],
      ['/api/budgets/events', AMOUNTS.budgetEvent],
      ['/api/investments/holdings', seed.security.uuid],
      // Today's net worth, computed from the seeded transaction.
      ['/api/net-worth/current', AMOUNTS.transaction],
      ['/api/net-worth/history?period=day', AMOUNTS.netWorth],
      ['/api/auth/sessions', sessions.a.uuid],
      ['/api/auth/mcp-tokens', ids.tokenUuid],
      ['/api/passkeys', ids.credentialId],
      [`/api/organizations/${ids.orgUuid}/members`, ids.orgMemberUuid],
      [`/api/organizations/${ids.orgUuid}/invitations`, ids.invitationUuid],
      ['/api/tenants/current/members', ids.memberUuid],
    ];
    for (const [url, text] of shows) {
      const res = await send('a', 'GET', url);
      check(res.status === 200 && textOf(res).includes(text), `GET ${url} shows ${text}`, res);
    }
    expect(problems).toEqual([]);
    // Taken after A's own requests, which may update A's rows.
    fingerprintBefore = await fingerprint();
  });

  /**
   * Call each route as B with A's ids (with ownOrg, B's organization first); list what
   * would reveal A, and the writes that succeeded.
   */
  async function sweep(routes: Route[], opts: { ownOrg?: boolean } = {}) {
    const leaks: string[] = [];
    const successes: string[] = [];
    const details: string[] = [];
    const unmapped: string[] = [];
    for (const route of routes) {
      const { url, unmapped: missing } = urlFor(route.path, opts);
      if (missing.length > 0) unmapped.push(`${route.method} ${route.path}: ${missing.join(', ')}`);
      const res = await send('b', route.method, url, route.method === 'GET' ? undefined : { name: HIJACK });
      const found = revealed(url, res);
      if (found.length > 0) {
        leaks.push(`${route.method} ${route.path}`);
        details.push(`${route.method} ${url} (${res.status}): ${found.join(', ')}`);
      }
      if (route.method !== 'GET' && res.status < 300) {
        successes.push(`${route.method} ${route.path}`);
        details.push(`${route.method} ${url} succeeded (${res.status})`);
      }
    }
    // A new route whose parameter has no id here would only ever be probed with a nil uuid.
    expect(unmapped, 'add these parameters to urlFor').toEqual([]);
    return { leaks, successes, details: details.join('\n') };
  }

  const orgRoutes = (routes: Route[]) => routes.filter((r) => r.path.startsWith('/api/organizations/:uuid'));

  // Reads first, while A's rows still carry the marker: a write that wrongly reaches them
  // (checked next) could rename or delete what a later read would have shown.
  it("never shows B anything of A's on a read", async () => {
    const routes = sweptRoutes().filter((r) => r.method === 'GET');
    expect(routes.length).toBeGreaterThan(100);
    const ours = await sweep(routes);
    const inOwnOrg = await sweep(orgRoutes(routes), { ownOrg: true });
    const leaks = [...ours.leaks, ...inOwnOrg.leaks.map((k) => `${k} in B's org`)];
    const expected = KNOWN_LEAKS.filter((k) => k.startsWith('GET '));
    expect(leaks.sort(), `${ours.details}\n${inOwnOrg.details}`).toEqual([...expected].sort());
  }, 120_000);

  /**
   * Requests B must be refused. `check` sends one; `result` is what went wrong, and which
   * known wrong answers still happen, to compare with the ones this test sent.
   */
  function refusals() {
    const wrong: string[] = [];
    const stillWrong: string[] = [];
    const sent: string[] = [];
    const check = async (key: string, method: string, url: string, body?: object, allowed = [404]) => {
      sent.push(key);
      const res = await send('b', method, url, body);
      if (allowed.includes(res.status)) return;
      if (KNOWN_WRONG_ANSWERS.includes(key)) stillWrong.push(key);
      else wrong.push(`${key}: ${res.status} ${textOf(res).slice(0, 200)}`);
    };
    const expectResult = (extra: string[] = []) => {
      expect([...wrong, ...extra]).toEqual([]);
      expect(stillWrong.sort()).toEqual(KNOWN_WRONG_ANSWERS.filter((k) => sent.includes(k)).sort());
    };
    return { check, expectResult };
  }

  it("refuses B A's resources, memberships, sessions and ledger", async () => {
    const { check: refused, expectResult } = refusals();
    for (const r of resources()) {
      const url = `${r.base}/${r.ref.uuid}`;
      if (!r.noGet) await refused(`GET ${r.base}/:uuid`, 'GET', url);
      await refused(`PUT ${r.base}/:uuid`, 'PUT', url, { ...r.body, name: HIJACK, description: HIJACK });
      await refused(`DELETE ${r.base}/:uuid`, 'DELETE', url);
    }
    await refused('GET /api/images/:uuid', 'GET', `/api/images/${seed.image.uuid}`);
    await refused('GET /api/attachments/file/:uuid', 'GET', `/api/attachments/file/${seed.attachment.uuid}`);
    await refused('DELETE /api/attachments/:uuid', 'DELETE', `/api/attachments/${seed.attachment.uuid}`);
    // Writes the sweep's generic body can't reach (validation runs before the lookup).
    await refused('PUT /api/budgets/period-items/:uuid/budget', 'PUT', `/api/budgets/period-items/${seed.periodItem.uuid}/budget`, {
      amount: 1,
    });
    await refused('PUT /api/bills/occurrences/:uuid/resolution', 'PUT', `/api/bills/occurrences/${seed.occurrence.uuid}/resolution`, {
      resolution: 'skipped',
    });
    await refused('PATCH /api/accounts/:uuid/import-settings', 'PATCH', `/api/accounts/${seed.account.uuid}/import-settings`, {
      import_enabled: false,
    });
    await refused('POST /api/accounts/:uuid/connect-bank', 'POST', `/api/accounts/${seed.account.uuid}/connect-bank`, {
      import_account_id: `isolation-probe-${stamp}`,
    });
    await refused('POST /api/merchants/:uuid/rules', 'POST', `/api/merchants/${seed.merchant.uuid}/rules`, {
      method: 'contains',
      matching_text: HIJACK,
    });
    await refused('PUT /api/merchants/rules/:uuid', 'PUT', `/api/merchants/rules/${seed.merchantRule.uuid}`, {
      method: 'contains',
      matching_text: HIJACK,
    });
    // tenant_users, organization_users, sessions, tokens and passkeys have no RLS, so only
    // each route's own filter keeps B off A's.
    await refused('PATCH /api/tenants/current/members/:uuid', 'PATCH', `/api/tenants/current/members/${ids.memberUuid}`, {
      isAdmin: false,
    });
    await refused('DELETE /api/tenants/current/members/:uuid', 'DELETE', `/api/tenants/current/members/${ids.memberUuid}`);
    const orgRoute = `/api/organizations/${ids.orgUuid}`;
    await refused('GET /api/organizations/:uuid', 'GET', orgRoute, undefined, [403, 404]);
    await refused('PATCH /api/organizations/:uuid/members/:memberUuid', 'PATCH', `${orgRoute}/members/${ids.orgMemberUuid}`, {
      isAdmin: false,
    }, [403, 404]);
    // Through B's own organization, where only the member lookup's own filter keeps A's out.
    const bOrgMember = `/api/organizations/${ids.bOrgUuid}/members/${ids.orgMemberUuid}`;
    await refused("PATCH /api/organizations/:uuid/members/:memberUuid/flags in B's org", 'PATCH', `${bOrgMember}/flags`, {
      isLocked: true,
    });
    await refused("PATCH /api/organizations/:uuid/members/:memberUuid in B's org", 'PATCH', bOrgMember, { isAdmin: false });
    await refused("DELETE /api/organizations/:uuid/members/:memberUuid in B's org", 'DELETE', bOrgMember);
    // An invitation of A's organization, sent to A: B can't see or accept it, even with its token.
    await refused('POST /api/invitations/inspect', 'POST', '/api/invitations/inspect', { token: invitationToken });
    await refused('POST /api/invitations/accept', 'POST', '/api/invitations/accept', { token: invitationToken });
    await refused(
      "DELETE /api/organizations/:uuid/invitations/:invitationUuid in B's org",
      'DELETE',
      `/api/organizations/${ids.bOrgUuid}/invitations/${ids.invitationUuid}`
    );
    await refused('DELETE /api/auth/sessions/:uuid', 'DELETE', `/api/auth/sessions/${sessions.a.uuid}`);
    await refused('DELETE /api/auth/mcp-tokens/:uuid', 'DELETE', `/api/auth/mcp-tokens/${ids.tokenUuid}`);
    await refused('PUT /api/passkeys/:credentialId', 'PUT', `/api/passkeys/${ids.credentialId}`, { deviceName: HIJACK });
    await refused('DELETE /api/passkeys/:credentialId', 'DELETE', `/api/passkeys/${ids.credentialId}`);
    // The ledger gate: B can't switch its session to A's ledger.
    await refused('POST /api/auth/active-tenant', 'POST', '/api/auth/active-tenant', { tenantUuid: ids.tenantUuid }, [403, 404]);
    const active = await owner.query<{ active_tenant_id: number }>('SELECT active_tenant_id FROM sessions WHERE id = $1', [
      sessions.b.id,
    ]);
    expectResult(active.rows[0].active_tenant_id === b.tenantId ? [] : [`B's session moved to ledger ${active.rows[0].active_tenant_id}`]);
  });

  it("doesn't let B point its own rows at A's user", async () => {
    const found: string[] = [];
    const put = await send('b', 'PUT', `/api/transactions/${bTransaction.uuid}`, { assigned_to: a.userId });
    const after = await send('b', 'GET', `/api/transactions/${bTransaction.uuid}`);
    if (put.status < 300 || revealed('', after).length > 0) found.push('PUT /api/transactions/:uuid assigned_to');
    expect(found).toEqual(KNOWN_LEAKS.filter((k) => k.endsWith(' assigned_to')));
  });

  it("never lets B's writes with A's ids succeed or show anything of A's", async () => {
    // Writes without parameters are the next test's.
    const routes = sweptRoutes().filter((r) => r.method !== 'GET' && r.path.includes('/:'));
    expect(routes.length).toBeGreaterThan(60);
    const ours = await sweep(routes);
    // In B's own organization, only the routes that also take an id of A's.
    const withMember = orgRoutes(routes).filter((r) => r.path.split('/:').length > 2);
    expect(withMember.length).toBeGreaterThan(0);
    const inOwnOrg = await sweep(withMember, { ownOrg: true });
    const details = `${ours.details}\n${inOwnOrg.details}`;
    expect([...ours.leaks, ...inOwnOrg.leaks], details).toEqual([]);
    const successes = [...ours.successes, ...inOwnOrg.successes.map((k) => `${k} in B's org`)];
    expect(successes.sort(), details).toEqual([...KNOWN_SWEEP_SUCCESSES].sort());
  }, 120_000);

  it("keeps B's writes without ids in B's own ledger, organization and account", async () => {
    const { check: refused, expectResult } = refusals();
    // B's own ledger, organization and profile: allowed, and checked against A's rows by the
    // next test.
    const bOrg = `/api/organizations/${ids.bOrgUuid}`;
    const allowed: Array<[string, request.Response]> = [
      ['PATCH /api/tenants/current', await send('b', 'PATCH', '/api/tenants/current', { name: 'Isolation B renamed' })],
      [
        'PATCH /api/tenants/current/balance-adjustment-merchant',
        await send('b', 'PATCH', '/api/tenants/current/balance-adjustment-merchant', { merchantUuid: null }),
      ],
      ['PATCH /api/organizations/:uuid', await send('b', 'PATCH', bOrg, { name: 'Isolation B org renamed' })],
      ['PUT /api/organizations/:uuid/price-sync/settings', await send('b', 'PUT', `${bOrg}/price-sync/settings`, { enabled: false })],
      [
        'DELETE /api/organizations/:uuid/simplefin/connection',
        await owner
          .query(`INSERT INTO organization_simplefin_connections (organization_id, access_url) VALUES ($1, 'unused')`, [
            b.organizationId,
          ])
          .then(() => send('b', 'DELETE', `${bOrg}/simplefin/connection`)),
      ],
      ['PUT /api/auth/profile', await send('b', 'PUT', '/api/auth/profile', { first_name: 'Test', last_name: 'Isolation B renamed' })],
    ];
    await refused('POST /api/auth/mcp-token', 'POST', '/api/auth/mcp-token', { tenantUuid: ids.tenantUuid, label: HIJACK }, [403, 404]);
    // A key that isn't an import setting is refused; the import settings B may set are its own
    // ledger's.
    await refused('POST /api/import/settings', 'POST', '/api/import/settings', { settings: { [probeSetting]: HIJACK } }, [400]);
    // Adding a user from another organization takes their consent or a deployment admin.
    await refused('POST /api/organizations/:uuid/members', 'POST', `/api/organizations/${ids.bOrgUuid}/members`, {
      email: a.userEmail,
      isAdmin: false,
    }, [403]);
    await refused('POST /api/tenants/current/members', 'POST', '/api/tenants/current/members', { email: a.userEmail }, [404]);
    // Inviting A to B's organization is allowed: it changes nothing of A's until A accepts.
    allowed.push([
      'POST /api/organizations/:uuid/invitations',
      await send('b', 'POST', `${bOrg}/invitations`, { email: a.userEmail }),
    ]);
    const joined = await owner.query('SELECT 1 FROM organization_users WHERE organization_id = $1 AND user_id = $2', [
      b.organizationId,
      a.userId,
    ]);
    expectResult([
      ...allowed
        .filter(([, res]) => res.status >= 300)
        .map(([key, res]) => `${key} as B failed: ${res.status} ${textOf(res).slice(0, 200)}`),
      ...(joined.rowCount ? ["A became a member of B's organization"] : []),
    ]);
  });

  it("leaves A's rows exactly as they were", async () => {
    expect(fingerprintBefore, 'the control test runs first').toBeDefined();
    const after = await fingerprint();
    const changed = [...after].filter(([table, print]) => fingerprintBefore.get(table) !== print).map(([t]) => t);
    expect(changed).toEqual([]);
  });
});
