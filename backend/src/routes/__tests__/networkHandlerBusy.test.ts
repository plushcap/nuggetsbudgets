import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { tenantNetworkHandler, PARTLY_SAVED_MESSAGE } from '../../utils/routeHandler.js';
import { RECORD_BUSY_MESSAGE } from '../../utils/apiError.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A route with no request transaction (tenantNetworkHandler: a bank sync, a SimpleFin call) commits
 * its work in short transactions of its own, so a lock it then can't get (a deadlock, a lock
 * timeout, or a service's busy refusal) comes after what it saved. It answered the 409 that says
 * nothing was saved (a full sync's last health update, its accounts saved before);
 * it now says what was finished is saved.
 */
describe('A busy lock on a route with no request transaction', () => {
  let tenant: TestTenant;
  let app: Express;

  beforeAll(async () => {
    tenant = await createTestTenant('Network handler busy');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.post('/deadlock', tenantNetworkHandler(async (_req, _res, tenantId) => {
      await withTenant(tenantId, () => sql`INSERT INTO tags (name) VALUES ('Saved before the deadlock')`.execute(getDb()));
      throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
    }));
    app.post('/refused', tenantNetworkHandler(async () => {
      throw new ControlPlaneError(409, 'TRANSACTION_BUSY', 'Another change to these transactions was being saved at the same time, so nothing was saved. Try again.');
    }));
    app.post('/other', tenantNetworkHandler(async () => {
      throw new ControlPlaneError(409, 'TAG_EXISTS', 'That tag is there already.');
    }));
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("says what was finished is saved, not that nothing was, and keeps a busy refusal's code", async () => {
    const deadlock = await request(app).post('/deadlock');
    expect({ status: deadlock.status, code: deadlock.body.code, error: deadlock.body.error }).toEqual({ status: 409, code: 'RECORD_BUSY', error: PARTLY_SAVED_MESSAGE });
    expect(deadlock.body.error).not.toBe(RECORD_BUSY_MESSAGE);
    expect((await tenant.pool.query(`SELECT 1 FROM tags WHERE name = 'Saved before the deadlock'`)).rowCount).toBe(1);
    const refused = await request(app).post('/refused');
    expect({ status: refused.status, code: refused.body.code, error: refused.body.error }).toEqual({ status: 409, code: 'TRANSACTION_BUSY', error: PARTLY_SAVED_MESSAGE });
    // Another refusal is answered as it is.
    expect((await request(app).post('/other')).body).toMatchObject({ code: 'TAG_EXISTS', error: 'That tag is there already.' });
  });
});
