import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeFetchStub, registeredTools } from './harness.js';

/**
 * A ledger's amounts are in its own currency (its General Settings), so no tool says they are
 * dollars, and a tool can read which currency they are in (get_general_settings).
 */
describe("the tools' amounts are in the tenant's currency", () => {
  const tools = registeredTools(makeFetchStub().fetchImpl);

  /** Every text a tool shows a model: its title, description, and its arguments' descriptions. */
  const textsOf = (name: string): string[] => {
    const tool = tools.get(name)!;
    const args = Object.values(tool.config.inputSchema).map((arg) => JSON.stringify(z.toJSONSchema(arg as z.ZodType, { io: 'input', unrepresentable: 'any' })));
    return [tool.config.title ?? '', tool.config.description ?? '', ...args];
  };

  it('no tool says its amounts are dollars', () => {
    const found = [...tools.keys()].flatMap((name) =>
      textsOf(name).filter((text) => /\bdollars?\b|\$\s?\d/i.test(text)).map((text) => `${name}: ${text.match(/.{0,40}(\bdollars?\b|\$\s?\d).{0,20}/i)?.[0]}`)
    );
    expect(found).toEqual([]);
  });

  it('a read-only tool answers the currency and locale, from General Settings', async () => {
    const tool = tools.get('get_general_settings');
    expect(tool?.config.annotations?.readOnlyHint).toBe(true);
    expect(tool?.config.description).toMatch(/application_currency/);
    expect(tool?.config.description).toMatch(/application_locale/);
    for (const name of ['list_budget_period_items', 'get_notification_rules', 'find_tax_loss_harvest_candidates']) {
      expect(textsOf(name).join(' '), name).toMatch(/get_general_settings/);
    }
  });
});
