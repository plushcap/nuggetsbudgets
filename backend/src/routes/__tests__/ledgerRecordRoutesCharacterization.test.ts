import {
  answerProblem,
  currentNetWorthAnswerSchema,
  netWorthHistoryAnswerSchema,
  transactionRangeDeleteResponseSchema,
  transactionRangePreviewResponseSchema,
} from '@nuggets/shared';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import path from 'path';
import { promises as fsp } from 'fs';
import type request from 'supertest';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';
import { addDays, daysBetween } from '../../utils/calendarDate.js';
import { appToday } from '../../utils/appDate.js';
import { withTenant } from '../../db/withTenant.js';

/**
 * What the ledger-record routes answer, whole (status and body), through the real app:
 * categories, institutions, annotations, attachments, the data-deletion preview and delete,
 * and net worth. Written before each route's database work moved into a service,
 * so the move is checked against what the routes answered before it.
 *
 * Ids, uuids, instants, request ids, hashes and today's date differ from run to run, and
 * are replaced with placeholders, so an answer reads the same every run.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

describeDb('Ledger record routes: whole answers', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let other: TestTenant;
  let session: string;
  let today: string;
  let accountId: number;
  const uploadDir = path.join(process.cwd(), 'uploads');
  const written: string[] = [];

  const one = async <T>(text: string, params: unknown[] = [], t: TestTenant = tenant) => (await t.pool.query(text, params)).rows[0] as T;

  const normalize = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => normalize(v, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
    }
    if (key === 'requestId' && typeof value === 'string') return '<requestId>';
    if (typeof value === 'string') {
      if (UUID.test(value)) return '<uuid>';
      if (INSTANT.test(value)) return '<instant>';
      if (HEX64.test(value)) return '<hex64>';
      if (CALENDAR_DAY.test(value) && Math.abs(daysBetween(today, value)) <= 10) {
        const n = daysBetween(today, value);
        return n === 0 ? '<today>' : `<today${n > 0 ? '+' : ''}${n}>`;
      }
      if (key === 'safe_filename' || key === 'file_name' || key === 'backupFileName') return `<${key}>`;
      return value;
    }
    if (typeof value === 'number' && (key === 'id' || key.endsWith('_id'))) return '<id>';
    return value;
  };
  /** The answer's status and body, normalized. */
  const answer = (res: request.Response) => ({ status: res.status, body: normalize(res.body) });
  const call = (verb: Parameters<RouteHarness['call']>[1], url: string, body?: object) => h.call(session, verb, url, body);

  beforeAll(async () => {
    h = await startRouteHarness('Ledger record characterization');
    tenant = await createTestTenant('Ledger record characterization');
    other = await createTestTenant('Ledger record characterization other');
    // The ledger's member is its admin too: data management takes a ledger admin.
    await h.owner.query('UPDATE tenant_users SET is_admin = true WHERE tenant_id = $1 AND user_id = $2', [tenant.tenantId, tenant.userId]);
    session = await h.signIn(tenant.userId, tenant.tenantId);
    today = await withTenant(tenant.tenantId, () => appToday());
    accountId = (
      await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(written.map((f) => fsp.unlink(path.join(uploadDir, f)).catch(() => undefined)));
    // The harness's people first: their sessions name this ledger.
    const settled = [...(await Promise.allSettled([h?.close()])), ...(await Promise.allSettled([tenant?.cleanup(), other?.cleanup()]))];
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  describe('categories', () => {
    it('lists, creates, renames and deletes, with each refusal', async () => {
      const created = await call('post', '/api/categories', { name: '  Housing ', icon: 'Home', priority: 'Need', description: ' rent ', notes: '' });
      const answers: Record<string, unknown> = { created: answer(created) };
      answers.duplicate = answer(await call('post', '/api/categories', { name: 'HOUSING', icon: 'Home' }));
      answers.noIcon = answer(await call('post', '/api/categories', { name: 'No icon' }));
      const food = await call('post', '/api/categories', { name: 'Food', icon: 'Utensils' });
      answers.list = answer(await call('get', '/api/categories'));

      answers.renamed = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: ' Groceries ', icon: 'Cart', notes: ' weekly ' }));
      answers.recased = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: 'GROCERIES', icon: 'Cart' }));
      answers.clash = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: 'housing', icon: 'Cart' }));
      answers.missingName = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: '  ', icon: 'Cart' }));
      answers.missingIcon = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: 'Groceries' }));
      answers.tooLong = answer(await call('put', `/api/categories/${food.body.uuid}`, { name: 'x'.repeat(101), icon: 'Cart' }));
      answers.updateMissing = answer(await call('put', '/api/categories/00000000-0000-7000-8000-000000000000', { name: 'Nothing', icon: 'X' }));

      await one(`INSERT INTO budget_items (name, category_id) VALUES ('Rent', $1) RETURNING id`, [created.body.id]);
      answers.deleteInUse = answer(await call('delete', `/api/categories/${created.body.uuid}`));
      answers.deleteMissing = answer(await call('delete', '/api/categories/00000000-0000-7000-8000-000000000000'));
      answers.deleted = answer(await call('delete', `/api/categories/${food.body.uuid}`));
      expect(answers).toMatchSnapshot();
    });
  });

  describe('institutions', () => {
    it('lists, reads, creates, renames and deletes, with each refusal', async () => {
      const created = await call('post', '/api/institutions', { name: ' First Bank ', notes: 'branch on Main' });
      const answers: Record<string, unknown> = { created: answer(created) };
      answers.blankCreate = answer(await call('post', '/api/institutions', { name: '  ' }));
      await one(`INSERT INTO accounts (name, account_type, account_group, type, institution_id) VALUES ('At bank', 'checking', 'cash', 'Asset', $1) RETURNING id`, [created.body.id]);
      answers.list = answer(await call('get', '/api/institutions'));
      answers.one = answer(await call('get', `/api/institutions/${created.body.uuid}`));
      answers.oneMissing = answer(await call('get', '/api/institutions/00000000-0000-7000-8000-000000000000'));
      answers.renamed = answer(await call('put', `/api/institutions/${created.body.uuid}`, { name: ' First National ', notes: '' }));
      answers.blankRename = answer(await call('put', `/api/institutions/${created.body.uuid}`, { name: '  ' }));
      answers.renameMissing = answer(await call('put', '/api/institutions/00000000-0000-7000-8000-000000000000', { name: 'Nobody' }));
      answers.deleteInUse = answer(await call('delete', `/api/institutions/${created.body.uuid}`));
      await tenant.pool.query('UPDATE accounts SET institution_id = NULL WHERE institution_id = $1', [created.body.id]);
      answers.deleted = answer(await call('delete', `/api/institutions/${created.body.uuid}`));
      answers.deleteMissing = answer(await call('delete', `/api/institutions/${created.body.uuid}`));
      expect(answers).toMatchSnapshot();
    });
  });

  describe('annotations', () => {
    let reviewed: Ref;
    let open: Ref;

    beforeAll(async () => {
      const item = await one<Ref>(`INSERT INTO budget_items (name) VALUES ('Groceries') RETURNING id, uuid`);
      reviewed = await one<Ref>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, review_status, budget_item_id)
         VALUES ($1, -12.50, '2026-03-02', 'expense', 'Market', 'reviewed', $2) RETURNING id, uuid`,
        [accountId, item.id]
      );
      open = await one<Ref>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -4.00, '2026-03-03', 'expense', 'Coffee') RETURNING id, uuid`,
        [accountId]
      );
    });

    it('creates threads and replies, lists them, counts them and answers the inbox', async () => {
      const answers: Record<string, unknown> = {};
      const root = await call('post', '/api/annotations', {
        subject_type: 'transaction', subject_uuid: reviewed.uuid, kind: 'question', body: 'Is this groceries?',
        author_kind: 'agent', agent_name: 'bot', notify: true, severity: 'action_required', meta: { confidence: 0.6 },
      });
      answers.root = answer(root);
      const second = await call('post', '/api/annotations', { subject_type: 'transaction', subject_uuid: open.uuid, kind: 'note', body: 'Coffee again' });
      answers.second = answer(second);
      answers.reply = answer(await call('post', '/api/annotations', { parent_uuid: root.body.uuid, kind: 'answer', body: 'Yes' }));
      answers.replyMissingParent = answer(await call('post', '/api/annotations', { parent_uuid: '00000000-0000-7000-8000-000000000000', kind: 'answer', body: 'x' }));
      answers.unsupportedSubject = answer(await call('post', '/api/annotations', { subject_type: 'planet', subject_uuid: open.uuid, kind: 'note', body: 'x' }));
      answers.noSubjectUuid = answer(await call('post', '/api/annotations', { subject_type: 'transaction', kind: 'note', body: 'x' }));
      answers.subjectMissing = answer(await call('post', '/api/annotations', { subject_type: 'transaction', subject_uuid: '00000000-0000-7000-8000-000000000000', kind: 'note', body: 'x' }));
      answers.invalidBody = answer(await call('post', '/api/annotations', { subject_type: 'transaction', subject_uuid: open.uuid, kind: 'nonsense', body: 'x' }));

      answers.timeline = answer(await call('get', `/api/annotations?subject_type=transaction&subject_uuid=${reviewed.uuid}`));
      answers.timelineUnsupported = answer(await call('get', `/api/annotations?subject_type=planet&subject_uuid=${reviewed.uuid}`));
      answers.timelineNoType = answer(await call('get', `/api/annotations?subject_uuid=${reviewed.uuid}`));
      answers.timelineNoUuid = answer(await call('get', '/api/annotations?subject_type=transaction'));
      answers.timelineMissing = answer(await call('get', '/api/annotations?subject_type=transaction&subject_uuid=00000000-0000-7000-8000-000000000000'));

      answers.counts = answer(await call('get', '/api/annotations/counts'));
      answers.threads = answer(await call('get', '/api/annotations/threads'));
      answers.threadsNotify = answer(await call('get', '/api/annotations/threads?notify=true&status=answered&limit=1'));
      answers.threadsAll = answer(await call('get', '/api/annotations/threads?status=all&limit=-5'));
      answers.threadsNone = answer(await call('get', '/api/annotations/threads?status=resolved'));

      const inbox = await call('get', '/api/annotations/inbox?limit=10');
      answers.inbox = answer(inbox);
      answers.inboxAfter = answer(
        await call('get', `/api/annotations/inbox?since=${encodeURIComponent(inbox.body.next_since)}&since_uuid=${inbox.body.next_since_uuid}`)
      );
      answers.inboxOldCursor = answer(await call('get', '/api/annotations/inbox?since=2026-01-01'));
      answers.inboxBadSince = answer(await call('get', '/api/annotations/inbox?since=today'));
      answers.inboxBadSinceUuid = answer(await call('get', '/api/annotations/inbox?since=2026-01-01T00:00:00Z&since_uuid=nope'));
      expect(answers).toMatchSnapshot();
    });

    // A uuid that isn't one failed casting in the lookup (a 500); a status or flag that isn't
    // one was read as no filter. Each is 400 VALIDATION_ERROR now.
    it('refuses a query or body value that is not one with 400', async () => {
      const refused = async (res: request.Response, field: string) => {
        expect({ status: res.status, code: res.body.code, fields: res.body.details?.map((d: { field: string }) => d.field) }).toEqual({
          status: 400,
          code: 'VALIDATION_ERROR',
          fields: [field],
        });
      };
      await refused(await call('get', '/api/annotations?subject_type=transaction&subject_uuid=not-a-uuid'), 'subject_uuid');
      await refused(await call('get', '/api/annotations/threads?status=bogus'), 'status');
      await refused(await call('get', '/api/annotations/threads?notify=yes'), 'notify');
      await refused(await call('get', '/api/annotations/inbox?since=2026-01-01&since=2026-02-01'), 'since');
      await refused(await call('post', '/api/annotations', { parent_uuid: 'not-a-uuid', kind: 'answer', body: 'x' }), 'parent_uuid');
      await refused(await call('post', '/api/annotations', { subject_type: 'transaction', subject_uuid: 'nope', kind: 'note', body: 'x' }), 'subject_uuid');
      await refused(await call('post', '/api/annotations/manual-resolve', { uuid: 'nope' }), 'uuid');
    });

    it('edits and resolves threads, with each refusal', async () => {
      const answers: Record<string, unknown> = {};
      const agentDecision = await call('post', '/api/annotations', {
        subject_type: 'transaction', subject_uuid: open.uuid, kind: 'decision', body: 'Left as is', author_kind: 'agent',
      });
      const human = await call('post', '/api/annotations', { subject_type: 'transaction', subject_uuid: open.uuid, kind: 'note', body: 'Hmm' });
      const humanReply = await call('post', '/api/annotations', { parent_uuid: human.body.uuid, kind: 'note', body: 'Reply' });

      answers.editAppendOnly = answer(await call('patch', `/api/annotations/${agentDecision.body.uuid}`, { body: 'Changed' }));
      answers.editBody = answer(await call('patch', `/api/annotations/${human.body.uuid}`, { body: 'Hmm, coffee', pinned: true }));
      answers.feedback = answer(await call('patch', `/api/annotations/${agentDecision.body.uuid}`, { feedback: 'incorrect', feedback_reason: 'wrong' }));
      answers.applied = answer(
        await call('patch', `/api/annotations/${agentDecision.body.uuid}`, { learning_status: 'applied', applied_ref: { pr: 1 } })
      );
      answers.resolve = answer(await call('patch', `/api/annotations/${human.body.uuid}`, { status: 'resolved' }));
      answers.reopen = answer(await call('patch', `/api/annotations/${human.body.uuid}`, { status: 'open', notify: true, severity: 'info' }));
      answers.replyThreadFields = answer(await call('patch', `/api/annotations/${humanReply.body.uuid}`, { status: 'resolved' }));
      answers.editMissing = answer(await call('patch', '/api/annotations/00000000-0000-7000-8000-000000000000', { pinned: true }));

      answers.resolveOneMissing = answer(await call('post', '/api/annotations/manual-resolve', { uuid: '00000000-0000-7000-8000-000000000000' }));
      answers.resolveOne = answer(await call('post', '/api/annotations/manual-resolve', { uuid: human.body.uuid }));
      answers.resolveReviewed = answer(await call('post', '/api/annotations/manual-resolve', { scope: 'reviewed' }));
      answers.resolveAll = answer(await call('post', '/api/annotations/manual-resolve', { scope: 'all' }));
      answers.resolveAgain = answer(await call('post', '/api/annotations/manual-resolve', { scope: 'all' }));
      answers.resolveNeither = answer(await call('post', '/api/annotations/manual-resolve', {}));
      answers.timeline = answer(await call('get', `/api/annotations?subject_type=transaction&subject_uuid=${open.uuid}`));
      expect(answers).toMatchSnapshot();
    });
  });

  describe('attachments', () => {
    it('uploads, serves and deletes a file, with each refusal', async () => {
      const transaction = await one<Ref>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -9, '2026-04-01', 'expense', 'Receipt') RETURNING id, uuid`,
        [accountId]
      );
      const elsewhere = await one<Ref>(`INSERT INTO budget_items (name) VALUES ('Theirs') RETURNING id, uuid`, [], other);
      const answers: Record<string, unknown> = {};
      answers.noFiles = answer(await call('post', '/api/attachments/upload').field('transaction_id', String(transaction.id)));
      answers.wrongType = answer(
        await call('post', '/api/attachments/upload').field('transaction_id', String(transaction.id)).attach('attachments', Buffer.from('<svg/>'), 'x.svg')
      );
      answers.noEntity = answer(await call('post', '/api/attachments/upload').attach('attachments', Buffer.from('%PDF-1.4 a'), 'a.pdf'));
      answers.entityMissing = answer(
        await call('post', '/api/attachments/upload').field('budget_item_id', String(elsewhere.id)).attach('attachments', Buffer.from('%PDF-1.4 a'), 'a.pdf')
      );
      // The entity is checked before the bytes.
      answers.entityMissingBadBytes = answer(
        await call('post', '/api/attachments/upload').field('budget_item_id', String(elsewhere.id)).attach('attachments', Buffer.from('not a pdf'), 'a.pdf')
      );
      answers.badBytes = answer(
        await call('post', '/api/attachments/upload').field('transaction_id', String(transaction.id)).attach('attachments', Buffer.from('not a pdf'), 'a.pdf')
      );
      const uploaded = await call('post', '/api/attachments/upload')
        .field('transaction_id', String(transaction.id))
        .field('name', ' Receipt scan ')
        .field('notes', ' paid ')
        .field('bill_date', '2026-04-02')
        .attach('attachments', Buffer.from('%PDF-1.4 receipt'), 'receipt.pdf')
        .attach('attachments', Buffer.from('%PDF-1.4 second'), 'second.pdf');
      answers.uploaded = answer(uploaded);
      for (const row of uploaded.body.attachments ?? []) written.push(row.safe_filename);
      const [first] = uploaded.body.attachments;

      const file = await call('get', `/api/attachments/file/${first.uuid}`).buffer(true);
      answers.file = {
        status: file.status,
        body: Buffer.from(file.body as Buffer).toString(),
        headers: Object.fromEntries(['content-type', 'content-disposition', 'cache-control', 'x-content-type-options'].map((k) => [k, file.headers[k]])),
      };
      answers.fileMissing = answer(await call('get', '/api/attachments/file/00000000-0000-7000-8000-000000000000'));
      answers.list = answer(await call('get', `/api/transactions/${transaction.uuid}/attachments`));

      answers.deleted = answer(await call('delete', `/api/attachments/${first.uuid}`));
      answers.deletedAgain = answer(await call('delete', `/api/attachments/${first.uuid}`));
      answers.fileGone = answer(await call('get', `/api/attachments/file/${first.uuid}`));
      expect(answers).toMatchSnapshot();
    });
  });

  describe('data management', () => {
    it('previews and deletes a range, with each refusal', async () => {
      const day = '2019-05-15';
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -20, $2, 'expense', 'Old one'), ($1, 35, $2, 'income', 'Old two') RETURNING id`,
        [accountId, day]
      );
      const range = { dateFrom: addDays(day, -1), dateTo: addDays(day, 1), excludeBudgetPeriod: true };
      const answers: Record<string, unknown> = {};
      answers.previewNoDates = answer(await call('post', '/api/data-management/preview-delete-transactions', { dateFrom: range.dateFrom }));
      answers.previewBadDate = answer(await call('post', '/api/data-management/preview-delete-transactions', { ...range, dateTo: '2026-02-30' }));
      answers.previewReversed = answer(await call('post', '/api/data-management/preview-delete-transactions', { ...range, dateFrom: range.dateTo, dateTo: range.dateFrom }));
      answers.previewFuture = answer(await call('post', '/api/data-management/preview-delete-transactions', { ...range, dateTo: addDays(today, 1) }));
      const preview = await call('post', '/api/data-management/preview-delete-transactions', range);
      answers.preview = answer(preview);
      // Exactly what the shared schemas name.
      expect(answerProblem(transactionRangePreviewResponseSchema, preview.body)).toBeNull();

      answers.deleteNoDates = answer(await call('post', '/api/data-management/delete-transactions', { selectionKey: preview.body.selectionKey }));
      answers.deleteNoKey = answer(await call('post', '/api/data-management/delete-transactions', range));
      answers.deleteBadDate = answer(await call('post', '/api/data-management/delete-transactions', { ...range, dateFrom: 'soon', selectionKey: preview.body.selectionKey }));
      answers.deleteReversed = answer(
        await call('post', '/api/data-management/delete-transactions', { ...range, dateFrom: range.dateTo, dateTo: range.dateFrom, selectionKey: preview.body.selectionKey })
      );
      answers.deleteFuture = answer(
        await call('post', '/api/data-management/delete-transactions', { ...range, dateTo: addDays(today, 1), selectionKey: preview.body.selectionKey })
      );
      answers.deleteOutdated = answer(await call('post', '/api/data-management/delete-transactions', { ...range, selectionKey: '0'.repeat(64) }));
      answers.backupRefused = answer(
        await call('post', '/api/data-management/delete-transactions', { ...range, createBackup: true, selectionKey: preview.body.selectionKey })
      );
      const deleted = await call('post', '/api/data-management/delete-transactions', { ...range, createBackup: false, selectionKey: preview.body.selectionKey });
      expect(answerProblem(transactionRangeDeleteResponseSchema, deleted.body)).toBeNull();
      answers.deleted = answer(deleted);
      const empty = await call('post', '/api/data-management/preview-delete-transactions', range);
      answers.emptyPreview = answer(empty);
      answers.deletedNone = answer(await call('post', '/api/data-management/delete-transactions', { ...range, selectionKey: empty.body.selectionKey }));
      expect(answers).toMatchSnapshot();
    });
  });

  describe('data management body checks', () => {
    // A flag that isn't a boolean reached the query as text, which Postgres read as one
    // ('yes') or failed on ('maybe': a 500). The bodies are checked by
    // validateBody now.
    it('refuses a flag that is not true or false with 400', async () => {
      const range = { dateFrom: '2019-05-01', dateTo: '2019-05-02' };
      for (const [url, body] of [
        ['/api/data-management/preview-delete-transactions', { ...range, excludeBudgetPeriod: 'maybe' }],
        ['/api/data-management/delete-transactions', { ...range, excludeBudgetPeriod: 'maybe', selectionKey: '0'.repeat(64) }],
      ] as const) {
        const res = await call('post', url, body);
        expect({ url, status: res.status, code: res.body.code, field: res.body.details?.[0]?.field }).toEqual({
          url,
          status: 400,
          code: 'VALIDATION_ERROR',
          field: 'excludeBudgetPeriod',
        });
      }
    });
  });

  describe('net worth', () => {
    // A ledger of its own, so the history holds only these two days.
    let worth: TestTenant;
    let member: string;
    let admin: string;
    const at = (verb: Parameters<RouteHarness['call']>[1], url: string, as: string, body?: object) => h.call(as, verb, url, body);

    beforeAll(async () => {
      worth = await createTestTenant('Ledger record characterization net worth');
      member = await h.signIn(worth.userId, worth.tenantId);
      const deploymentAdmin = await h.addUser('net-worth-admin');
      await h.makeDeploymentAdmin(deploymentAdmin.id);
      admin = await h.signIn(deploymentAdmin.id, worth.tenantId);
    }, 60_000);

    afterAll(async () => {
      await worth?.cleanup();
    }, 60_000);

    it('answers today, the history, and clears and rebuilds it for a deployment admin only', async () => {
      const answers: Record<string, unknown> = {};
      answers.rebuildEmpty = answer(await at('post', '/api/net-worth/rebuild', admin, {}));
      const account = await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Worth', 'checking', 'cash', 'Asset') RETURNING id`, [], worth
      );
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, 100, $2, 'income', 'Pay'), ($1, -30, $3, 'expense', 'Shop') RETURNING id`,
        [account.id, addDays(today, -2), addDays(today, -1)],
        worth
      );
      const current = await at('get', '/api/net-worth/current', member);
      // Exactly what the shared schemas name, so the frontend's parse drops nothing.
      expect(answerProblem(currentNetWorthAnswerSchema, current.body)).toBeNull();
      answers.current = answer(current);
      answers.clearMember = answer(await at('delete', '/api/net-worth/clear', member));
      answers.rebuildMember = answer(await at('post', '/api/net-worth/rebuild', member, {}));
      const rebuilt = await at('post', '/api/net-worth/rebuild', admin, {});
      // How many weekly and monthly aggregates there are depends on the day the test runs.
      expect(rebuilt.body).toMatchObject({ weekly_aggregates: expect.any(Number), monthly_aggregates: expect.any(Number) });
      const stored = rebuilt.body.snapshots_created + rebuilt.body.weekly_aggregates + rebuilt.body.monthly_aggregates;
      answers.rebuilt = answer(rebuilt);
      Object.assign((answers.rebuilt as { body: object }).body, { weekly_aggregates: '<count>', monthly_aggregates: '<count>' });
      const historyDays = await at('get', '/api/net-worth/history?period=day&limit=3', member);
      expect(answerProblem(netWorthHistoryAnswerSchema, historyDays.body)).toBeNull();
      answers.historyDays = answer(historyDays);
      const meta = async (url: string) => {
        const res = await at('get', url, member);
        expect(res.body.meta.count).toBe(res.body.history.length);
        return { status: res.status, meta: { ...res.body.meta, count: '<count>' } };
      };
      answers.historyDefault = await meta('/api/net-worth/history');
      answers.historyNoGaps = await meta('/api/net-worth/history?period=week&fill_gaps=false&limit=0');
      answers.historyOdd = await meta('/api/net-worth/history?fill_gaps=false&limit=5000');
      // A period or flag that isn't one was read as a day, or as false: 400 now.
      for (const query of ['period=hour', 'fill_gaps=yes']) {
        const res = await at('get', `/api/net-worth/history?${query}`, member);
        expect({ query, status: res.status, code: res.body.code }).toEqual({ query, status: 400, code: 'VALIDATION_ERROR' });
      }
      const cleared = await at('delete', '/api/net-worth/clear', admin);
      expect(cleared.body.deleted_count).toBe(stored);
      answers.cleared = { status: cleared.status, body: { ...cleared.body, deleted_count: '<count>', message: cleared.body.message.replace(String(stored), '<count>') } };
      expect(answers).toMatchSnapshot();
    });
  });
});
