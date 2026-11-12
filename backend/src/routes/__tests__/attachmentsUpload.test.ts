import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import path from 'path';
import { promises as fsp } from 'fs';
import { createAttachmentRoutes } from '../attachments.js';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Attachment upload/delete integration test (requires Postgres test DB).
// Exercises the finished upload/delete pipeline and the holding_event FK arm
// (attachments.holding_event_id).
describe('Attachments upload API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let accountUuid: string;
  let securityUuid: string;
  let holdingEventId: number;
  const uploadDir = path.join(process.cwd(), 'uploads');
  const writtenFiles: string[] = [];
  // Every upload names its file with this run's mark, and a check of the directory reads only
  // the files with it: other files' tests write to the same directory at the same time.
  const MARK = `au${process.pid}${Date.now().toString(36)}`;
  const marked = (name: string) => `${MARK}-${name}`;
  const ownFiles = async () => (await fsp.readdir(uploadDir)).filter((f) => f.includes(MARK)).sort();

  beforeAll(async () => {
    tenant = await createTestTenant('Attachments upload API');
    pool = tenant.pool;
    app = express();
    app.use(express.json()); // JSON bodies for the investment setup routes; multipart uploads bypass this and hit multer.
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    app.use('/api/attachments', createAttachmentRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'investment','investments','Asset') RETURNING id, uuid`, [`Att Brokerage ${Date.now()}`]);
    accountId = acct.rows[0].id;
    accountUuid = acct.rows[0].uuid;
    const sec = await request(app).post('/api/investments/securities').send({ ticker: `AT${Date.now() % 100000}`, name: 'Att Co', security_type: 'stock', asset_class: 'equity' }).expect(201);
    securityUuid = sec.body.uuid;
    await request(app).post('/api/investments/events/buy').send({ account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2025-01-02', shares: 10, price_per_share: 50 }).expect(201);
    const he = await pool.query(`SELECT id FROM holding_events WHERE account_id = $1 AND event_type = 'buy' ORDER BY id DESC LIMIT 1`, [accountId]);
    holdingEventId = he.rows[0].id;
  });

  afterAll(async () => {
    await Promise.all(writtenFiles.map((f) => fsp.unlink(path.join(uploadDir, f)).catch(() => undefined)));
    await tenant.cleanup();
  });

  it('uploads a document attached to a holding event and stores it', async () => {
    const res = await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(holdingEventId))
      .field('name', 'Trade confirmation')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'confirmation.pdf')
      .expect(201);

    expect(res.body.attachments).toHaveLength(1);
    const att = res.body.attachments[0];
    expect(att.holding_event_id).toBe(holdingEventId);
    expect(att.name).toBe('Trade confirmation');
    expect(att.file_extension).toBe('pdf');
    expect(att.safe_filename).toContain(att.uuid);
    writtenFiles.push(att.safe_filename);

    // Persisted to the DB and to disk.
    const row = await pool.query('SELECT uuid FROM attachments WHERE uuid = $1', [att.uuid]);
    expect(row.rowCount).toBe(1);
    await expect(fsp.access(path.join(uploadDir, att.safe_filename))).resolves.toBeUndefined();
  });

  // A name over 255 characters (attachments.name is varchar(255)) failed the INSERT, a 500;
  // a file name whose safe name (the uuid, '_' and the name) is longer than a file system's names
  // (255 bytes) failed the file's rename, a 500 too.
  it('refuses a name or a file name too long for its row with a 400, and keeps no file', async () => {
    const before = await ownFiles();
    const upload = (name: string | null, fileName: string) => {
      const req = request(app).post('/api/attachments/upload').field('holding_event_id', String(holdingEventId));
      if (name !== null) req.field('name', name);
      return req.attach('attachments', Buffer.from('%PDF-1.4 fake'), fileName);
    };
    const refused = (res: request.Response) => expect({ status: res.status, code: res.body.code }).toEqual({ status: 400, code: 'BAD_REQUEST' });
    const mark = `${MARK}-`;
    refused(await upload('é'.repeat(256), marked('confirmation.pdf')));
    // The file's name as the attachment's: 256 characters.
    refused(await upload(null, `${mark}${'é'.repeat(252 - mark.length)}.pdf`));
    // Its safe name 256 characters (with the uuid and '_'), its own 219.
    refused(await upload('Statement', `${mark}${'s'.repeat(215 - mark.length)}.pdf`));
    // Over 500 characters (original_filename's varchar(500)), its safe name short.
    refused(await upload('Statement', `${mark}${'é'.repeat(501)}.pdf`));
    expect(await ownFiles()).toEqual(before);
    // At the limits it is kept: 255 characters, and a file name whose safe name takes 255.
    const atLimit = await upload('é'.repeat(255), `${mark}${'s'.repeat(214 - mark.length)}.pdf`).expect(201);
    expect(atLimit.body.attachments[0].name).toBe('é'.repeat(255));
    expect(atLimit.body.attachments[0].safe_filename).toHaveLength(255);
    writtenFiles.push(atLimit.body.attachments[0].safe_filename);
  });

  // A bill date that isn't a real day reached the INSERT, which Postgres refused (a 500).
  it("refuses a bill date that isn't a real day, leaving no file, and keeps one that is", async () => {
    const before = await ownFiles();
    for (const billDate of ['2026-02-30', 'next tuesday', '0001-01-01', '20260301']) {
      const res = await request(app)
        .post('/api/attachments/upload')
        .field('holding_event_id', String(holdingEventId))
        .field('bill_date', billDate)
        .attach('attachments', Buffer.from('%PDF-1.4 fake'), marked('bill.pdf'));
      expect(res.status, billDate).toBe(400);
      expect(res.body.error).toMatch(/bill_date/);
    }
    expect(await ownFiles()).toEqual(before);

    const ok = await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(holdingEventId))
      .field('bill_date', '2026-03-01')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), marked('bill.pdf'))
      .expect(201);
    writtenFiles.push(ok.body.attachments[0].safe_filename);
    expect(ok.body.attachments[0].bill_date).toBe('2026-03-01');
    const empty = await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(holdingEventId))
      .field('bill_date', '')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'nobill.pdf')
      .expect(201);
    writtenFiles.push(empty.body.attachments[0].safe_filename);
    expect(empty.body.attachments[0].bill_date).toBeNull();
  });

  it('rejects an upload that references no entity', async () => {
    await request(app)
      .post('/api/attachments/upload')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'orphan.pdf')
      .expect(400);
  });

  it('rejects an upload referencing a non-existent holding event', async () => {
    await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', '999999999')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'ghost.pdf')
      .expect(404);
  });

  it('rejects a disallowed file type (no valid files)', async () => {
    await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(holdingEventId))
      .attach('attachments', Buffer.from('malware'), 'evil.exe')
      .expect(400);
  });

  it('deletes an attachment and removes its row', async () => {
    const up = await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(holdingEventId))
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'todelete.pdf')
      .expect(201);
    const att = up.body.attachments[0];

    await request(app).delete(`/api/attachments/${att.uuid}`).expect(200);

    const row = await pool.query('SELECT uuid FROM attachments WHERE uuid = $1', [att.uuid]);
    expect(row.rowCount).toBe(0);
  });

  it('returns 404 deleting an unknown attachment', async () => {
    await request(app).delete('/api/attachments/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('cascades: deleting the holding event removes its attachments (FK ON DELETE CASCADE)', async () => {
    // A fee event is a standalone holding_event with no dependent tax_lot, so it
    // can be hard-deleted to observe the attachment cascade in isolation.
    await request(app).post('/api/investments/events/fee').send({ account_uuid: accountUuid, fee_type: 'advisory', amount: 1, event_date: '2025-02-01' }).expect(201);
    const fee = await pool.query(`SELECT id FROM holding_events WHERE account_id = $1 AND event_type = 'fee' ORDER BY id DESC LIMIT 1`, [accountId]);
    const feeEventId = fee.rows[0].id;

    const up = await request(app)
      .post('/api/attachments/upload')
      .field('holding_event_id', String(feeEventId))
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'cascade.pdf')
      .expect(201);
    const att = up.body.attachments[0];
    writtenFiles.push(att.safe_filename);

    await pool.query('DELETE FROM holding_events WHERE id = $1', [feeEventId]);

    const row = await pool.query('SELECT uuid FROM attachments WHERE uuid = $1', [att.uuid]);
    expect(row.rowCount).toBe(0);
  });
});
