import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { sql } from 'kysely';
import { withTenant } from '../../db/withTenant.js';
import { EmailTemplateService } from '../../services/EmailTemplateService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The logo URL read while an email is rendered in the caller's transaction. The read
 * runs there (systemSettings.ts), and a failure is caught so the email goes without a logo;
 * but a failed statement aborts the transaction, so without a savepoint every statement after
 * it failed ("current transaction is aborted"), and the request with it. Here the read fails
 * on a lock it can't get in time (another session holds system_settings).
 */
describe("Rendering an email when the logo URL can't be read", () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Email logo read');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('renders without the logo, and the transaction carries on', async () => {
    const holder = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE system_settings IN ACCESS EXCLUSIVE MODE');
      const after = await withTenant(tenant.tenantId, async (trx) => {
        await sql`SET LOCAL lock_timeout = '100ms'`.execute(trx);
        const rendered = await new EmailTemplateService().renderTemplate('rule_message', {
          subject: 'Test Subject',
          heading: 'Groceries',
          paragraphs: ['Hi Alex,'],
          buttonUrl: 'https://app.example.com/budget-items/abc/view',
          buttonText: 'Open the budget item',
          fromName: 'The Smiths',
          unsubscribeUrl: 'https://app.example.com/unsubscribe#token',
        });
        // The transaction is still usable: before, this failed with 25P02.
        const { rows } = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(trx);
        return { html: rendered.html, ok: rows[0]?.ok };
      });
      expect(after.ok).toBe(1);
      expect(after.html).toContain('Groceries');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });
});
