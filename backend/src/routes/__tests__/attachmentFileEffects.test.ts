import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import fs, { promises as fsp } from 'fs';
import { createAttachmentRoutes } from '../attachments.js';
import { UPLOAD_DIR } from '../../services/attachments/AttachmentService.js';
import { answerError } from '../../utils/apiError.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * An attachment's file and its row change together:
 *   - a refused upload writes no file at all: the entity it names is checked before multer
 *     writes one (it used to write every file, then remove them once the handler refused);
 *   - an upload whose later file's insert fails leaves none of its files behind (the earlier
 *     ones had been moved to their final names, which the cleanup of temporary paths missed);
 *   - a delete removes the file only once the row's delete has committed (it removed it
 *     inside the request's transaction, so a rollback left the row naming a missing file).
 */
describe('attachment files and their rows', () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let transactionId: number;
  let theirTransactionId: number;
  const pdf = () => Buffer.from('%PDF-1.4 file effects');
  const written: string[] = [];

  const transactionOf = async (t: TestTenant, name: string) => {
    const account = await t.pool.query<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
      [name]
    );
    return (
      await t.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -5, '2026-03-01', 'expense', 'Receipt') RETURNING id`,
        [account.rows[0]!.id]
      )
    ).rows[0]!.id;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Attachment file effects');
    other = await createTestTenant('Attachment file effects, other ledger');
    transactionId = await transactionOf(tenant, 'File effects checking');
    theirTransactionId = await transactionOf(other, 'Their checking');
    app = express();
    app.use(tenant.context());
    app.use('/api/attachments', createAttachmentRoutes());
    // As the app answers an error raised before a handler (routes.ts).
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => answerError(err, res));
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all(written.map((f) => fsp.unlink(path.join(UPLOAD_DIR, f)).catch(() => undefined)));
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const upload = () => request(app).post('/api/attachments/upload');
  // Every upload names its file with this run's mark, and a check of the directory reads only the
  // files with it: other files' tests write to the same directory at the same time.
  const MARK = `afe${process.pid}${Date.now().toString(36)}`;
  const marked = (name: string) => `${MARK}-${name}`;
  const filesInUploads = async () => (await fsp.readdir(UPLOAD_DIR)).filter((f) => f.includes(MARK)).sort();
  /** The paths in the uploads directory a write stream was opened on while `fn` ran. */
  async function writesDuring(fn: () => Promise<request.Response>) {
    const spy = vi.spyOn(fs, 'createWriteStream');
    const res = await fn();
    const paths = spy.mock.calls.map(([p]) => String(p)).filter((p) => p.startsWith(UPLOAD_DIR));
    spy.mockRestore();
    return { res, paths };
  }

  it("writes no file for an upload naming another ledger's transaction, or none", async () => {
    const before = await filesInUploads();
    const theirs = await writesDuring(() =>
      upload().field('transaction_id', String(theirTransactionId)).attach('attachments', pdf(), marked('a.pdf')).attach('attachments', pdf(), marked('b.pdf'))
    );
    expect([theirs.res.status, theirs.res.body.code]).toEqual([404, 'NOT_FOUND']);
    expect(theirs.paths).toEqual([]);

    const missing = await writesDuring(() => upload().field('transaction_id', '2147483000').attach('attachments', pdf(), marked('a.pdf')));
    expect(missing.res.status).toBe(404);
    expect(missing.paths).toEqual([]);

    const none = await writesDuring(() => upload().attach('attachments', pdf(), marked('a.pdf')));
    expect([none.res.status, none.res.body.error]).toEqual([
      400,
      'An attachment must reference one of: transaction_id, budget_item_id, merchant_id, holding_event_id',
    ]);
    expect(none.paths).toEqual([]);

    // Named after the files: they were sent before anything said what they attach to.
    const late = await writesDuring(() => upload().attach('attachments', pdf(), marked('a.pdf')).field('transaction_id', String(transactionId)));
    expect([late.res.status, late.res.body.error]).toEqual([400, 'Send transaction_id before the files it names']);
    expect(late.paths).toEqual([]);

    expect(await filesInUploads()).toEqual(before);
    expect((await other.pool.query('SELECT 1 FROM attachments')).rowCount).toBe(0);
  });

  // The entity was checked as the first file found it, and a later field could
  // change it; and a file after one sent before the entity was still written.
  it('writes no file after the entity changes, or after a file sent before it', async () => {
    const before = await filesInUploads();
    const theirMerchant = (await other.pool.query<{ id: number }>(`INSERT INTO merchants (name) VALUES ('Their merchant') RETURNING id`)).rows[0]!.id;
    const changed = await writesDuring(() =>
      upload()
        .field('transaction_id', String(transactionId))
        .attach('attachments', pdf(), marked('a.pdf'))
        .field('merchant_id', String(theirMerchant))
        .attach('attachments', pdf(), marked('b.pdf'))
    );
    expect([changed.res.status, changed.res.body.code]).toEqual([400, 'BAD_REQUEST']);
    // a.pdf was written for the transaction checked; b.pdf, after the change, wasn't.
    expect(changed.paths).toHaveLength(1);

    const late = await writesDuring(() =>
      upload().attach('attachments', pdf(), marked('a.pdf')).field('transaction_id', String(transactionId)).attach('attachments', pdf(), marked('b.pdf'))
    );
    expect([late.res.status, late.res.body.error]).toEqual([400, 'Send transaction_id before the files it names']);
    expect(late.paths).toEqual([]);

    // A field after the last file: refused too, as it isn't what was checked.
    const ownMerchant = (await tenant.pool.query<{ id: number }>(`INSERT INTO merchants (name) VALUES ('Own merchant') RETURNING id`)).rows[0]!.id;
    const after = await upload()
      .field('transaction_id', String(transactionId))
      .attach('attachments', pdf(), marked('a.pdf'))
      .field('merchant_id', String(ownMerchant));
    expect([after.status, after.body.code]).toEqual([400, 'BAD_REQUEST']);

    expect(await filesInUploads()).toEqual(before);
    expect((await tenant.pool.query('SELECT 1 FROM attachments WHERE original_filename = ANY($1)', [[marked('a.pdf'), marked('b.pdf')]])).rowCount).toBe(0);
  });

  it('writes the files of an upload naming its own transaction first', async () => {
    const ok = await writesDuring(() => upload().field('transaction_id', String(transactionId)).attach('attachments', pdf(), marked('ok.pdf')));
    expect(ok.res.status, JSON.stringify(ok.res.body)).toBe(201);
    expect(ok.paths).toHaveLength(1);
    const [row] = ok.res.body.attachments as Array<{ safe_filename: string }>;
    written.push(row!.safe_filename);
    await expect(fsp.access(path.join(UPLOAD_DIR, row!.safe_filename))).resolves.toBeUndefined();
  });

  it("leaves none of an upload's files when a later file's row can't be saved", async () => {
    const before = await filesInUploads();
    // The second file can't take its final name, after the first file's row went in and the file
    // took its own. (A name longer than attachments.name holds failed the insert; it is refused
    // before anything is written now.)
    const rename = fsp.rename.bind(fsp);
    let renames = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (++renames === 2) throw Object.assign(new Error('the second file could not be renamed'), { code: 'EIO' });
      return rename(from, to);
    });
    const res = await upload()
      .field('transaction_id', String(transactionId))
      .attach('attachments', pdf(), marked('first.pdf'))
      .attach('attachments', pdf(), marked('second.pdf'));
    expect(res.status).toBe(500);
    expect(await filesInUploads()).toEqual(before);
    expect((await tenant.pool.query('SELECT 1 FROM attachments WHERE original_filename = $1', [marked('first.pdf')])).rowCount).toBe(0);
  });

  it("removes a deleted attachment's file only once the delete has committed", async () => {
    const up = await upload().field('transaction_id', String(transactionId)).attach('attachments', pdf(), marked('delete-me.pdf')).expect(201);
    const att = up.body.attachments[0] as { uuid: string; safe_filename: string };
    const file = path.join(UPLOAD_DIR, att.safe_filename);
    const unlink = fsp.unlink.bind(fsp);
    let rowWhenUnlinked: number | null = null;
    vi.spyOn(fsp, 'unlink').mockImplementation(async (target) => {
      if (String(target) === file) {
        rowWhenUnlinked = (await tenant.pool.query('SELECT 1 FROM attachments WHERE uuid = $1', [att.uuid])).rowCount;
      }
      return unlink(target);
    });

    await request(app).delete(`/api/attachments/${att.uuid}`).expect(200);
    expect(rowWhenUnlinked, 'the file should have been removed').not.toBeNull();
    // Another connection no longer sees the row: its delete had committed.
    expect(rowWhenUnlinked).toBe(0);
    await expect(fsp.access(file)).rejects.toThrow();
  });
});
