import { describe, it, expect, beforeAll, vi } from 'vitest';
import Handlebars from 'handlebars';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

/**
 * Unit tests for EmailTemplateService.
 *
 * renderTemplate() reads the logo URL from the DB and loads the actual MJML from
 * src/email-templates. We mock the module-level globalDb so these become pure,
 * deterministic rendering tests — which also guard the mjml 5 upgrade (mjml2html
 * is async in v5).
 */

// Route Kysely's compiled SQL to canned rows. Kysely acquires a client via
// pool.connect() and runs client.query(sql, params); expose the same routed
// query fn on both the pool and the checked-out client.
const { routedPool } = vi.hoisted(() => {
  const query = vi.fn(async (sql: string) => {
    if (/system_settings/i.test(sql)) {
      return { rows: [{ setting_value: 'https://cdn.example.com/logo.png' }] };
    }
    return { rows: [] };
  });
  return {
    routedPool: {
      query,
      connect: vi.fn(async () => ({ query, release: () => {} })),
    },
  };
});

// The logo URL is read through systemSettings.ts (currentDbOrGlobal), the templates on globalDb.
vi.mock('../../db/withTenant.js', () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: routedPool as unknown as Pool }) });
  return { globalDb: db, currentDbOrGlobal: () => db, inTenantTransaction: () => false, withSavepoint: <T>(fn: () => Promise<T>) => fn() };
});

import { EmailTemplateService } from '../../services/EmailTemplateService.js';

const ruleData = {
  subject: 'Test Subject',
  heading: 'Groceries',
  paragraphs: ['Hi Alex,', 'Groceries has spent $650.00 of its $500.00 budget (130%) in October.'],
  buttonUrl: 'https://app.example.com/budget-items/abc/view',
  buttonText: 'Open the budget item',
  fromName: 'The Smiths',
  unsubscribeUrl: 'https://app.example.com/unsubscribe#token',
};
describe('EmailTemplateService', () => {
  beforeAll(() => {
    // Templates use the currency/formatDate/pluralize helpers; they register on
    // the shared Handlebars singleton, so once is enough for the whole suite.
    new EmailTemplateService().registerHelpers();
  });

  describe('renderTemplate', () => {
    it('renders the rule message to valid email HTML', async () => {
      const out = await new EmailTemplateService().renderTemplate('rule_message', ruleData);

      expect(out.html).toMatch(/<!doctype html>/i);
      expect(out.html).toContain('<table');
      // If a partial ({{> footer}}) or handlebars var hadn't been resolved, the
      // render would have thrown; assert nothing handlebars-shaped survived.
      expect(out.html).not.toContain('{{');
    });

    it('lays out the heading, every paragraph, the button and the unsubscribe link', async () => {
      const out = await new EmailTemplateService().renderTemplate('rule_message', ruleData);

      expect(out.html).toContain('Groceries');
      expect(out.html).toContain('Hi Alex,');
      expect(out.html).toContain('$650.00 of its $500.00 budget');
      expect(out.html).toContain('href="https://app.example.com/budget-items/abc/view"');
      expect(out.html).toContain('From The Smiths in Nuggets.');
      expect(out.html).toContain('href="https://app.example.com/unsubscribe#token"');
    });

    it('escapes text that came from people (a budget item name is user input)', async () => {
      const out = await new EmailTemplateService().renderTemplate('rule_message', {
        ...ruleData,
        heading: '<img src=x onerror=alert(1)>',
        paragraphs: ['<script>alert(1)</script>'],
      });

      expect(out.html).not.toContain('<img src=x');
      expect(out.html).not.toContain('<script>alert(1)');
      expect(out.html).toContain('&lt;script&gt;');
    });

    it('produces a plain-text version with the HTML stripped', async () => {
      const out = await new EmailTemplateService().renderTemplate('rule_message', ruleData);

      expect(out.text).toContain('Hi Alex,');
      expect(out.text).not.toMatch(/<[a-z!/][\s\S]*?>/i); // no tags / doctype left
    });

    it('answers the subject it was given', async () => {
      const { subject } = await new EmailTemplateService().renderTemplate('rule_message', ruleData);

      expect(subject).toBe('Test Subject');
    });

    it('refuses data without a field the template needs', async () => {
      const svc = new EmailTemplateService();
      for (const field of ['subject', 'heading', 'paragraphs', 'buttonUrl', 'buttonText', 'unsubscribeUrl']) {
        await expect(svc.renderTemplate('rule_message', { ...ruleData, [field]: undefined })).rejects.toThrow(
          `Template data missing required fields: ${field}`
        );
      }
      await expect(svc.renderTemplate('rule_message', { ...ruleData, heading: null })).rejects.toThrow(/heading/);
    });

    // The templates were rows of notification_templates_registry: rendering reads
    // nothing from the database but the logo.
    it('throws for a template it does not have, and reads no template from the database', async () => {
      const svc = new EmailTemplateService();
      routedPool.query.mockClear();
      await svc.renderTemplate('rule_message', ruleData);
      const statements = routedPool.query.mock.calls.map(([text]) => String(text));
      expect(statements.filter((text) => !/^(begin|commit|rollback)$/i.test(text))).toEqual([
        expect.stringMatching(/from "system_settings"/),
      ]);

      await expect(svc.renderTemplate('does_not_exist', {})).rejects.toThrow("Template 'does_not_exist' not found");
      await expect(svc.renderTemplate('toString', {})).rejects.toThrow("Template 'toString' not found");
    });
  });

  describe('Handlebars helpers', () => {
    it('currency formats a number as USD', () => {
      expect(Handlebars.compile('{{currency amount}}')({ amount: 1234.5 })).toBe('$1,234.50');
      expect(Handlebars.compile('{{currency amount}}')({ amount: 0 })).toBe('$0.00');
    });

    it('currency coerces numeric strings (pg NUMERIC comes back as a string)', () => {
      expect(Handlebars.compile('{{currency amount}}')({ amount: '1234.5' })).toBe('$1,234.50');
    });

    it("currency shows the ledger's money format the template's data names, or the call's", () => {
      const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
      const money = { currency: 'EUR', locale: 'de-DE' };
      expect(plain(Handlebars.compile('{{currency amount}}')({ amount: '-1234.5', money }))).toBe('-1.234,50 €');
      expect(Handlebars.compile('{{currency amount currency="GBP" locale="en-GB"}}')({ amount: 3, money })).toBe('£3.00');
      // Inside a block, the data's root is still the template's.
      expect(plain(Handlebars.compile('{{#each rows}}{{currency this}};{{/each}}')({ rows: [1, 2], money }))).toBe('1,00 €;2,00 €;');
    });

    it('currency returns empty (not "$NaN") for missing or non-numeric amounts', () => {
      const tpl = Handlebars.compile('[{{currency amount}}]');
      expect(tpl({})).toBe('[]'); // undefined
      expect(tpl({ amount: null })).toBe('[]');
      expect(tpl({ amount: 'abc' })).toBe('[]');
    });

    it('pluralize picks singular for 1 and plural otherwise', () => {
      const tpl = Handlebars.compile('{{pluralize count "item" "items"}}');
      expect(tpl({ count: 1 })).toBe('item');
      expect(tpl({ count: 0 })).toBe('items');
      expect(tpl({ count: 5 })).toBe('items');
    });

    it('formatDate renders a long human-readable date', () => {
      const result = Handlebars.compile('{{formatDate d}}')({ d: '2026-01-15T12:00:00Z' });
      expect(result).toMatch(/January/);
      expect(result).toMatch(/2026/);
    });

    it('formatDate returns empty (does not throw) for missing or invalid dates', () => {
      const tpl = Handlebars.compile('[{{formatDate d}}]');
      expect(tpl({})).toBe('[]'); // undefined
      expect(tpl({ d: null })).toBe('[]');
      expect(tpl({ d: '' })).toBe('[]');
      expect(tpl({ d: 'not-a-date' })).toBe('[]');
    });
  });
});
