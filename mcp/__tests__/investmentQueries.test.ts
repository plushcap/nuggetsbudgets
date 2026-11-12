import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';
import * as shared from '@nuggets/shared';
import { LOT_OBJECTIVES, SECURITY_DATA_NEEDS } from '@nuggets/shared';
import { NuggetsApiClient } from '../src/client.js';
import { callTool, describeCall, inputSchemaOf, makeFetchStub, registeredTools, resultJson } from './harness.js';

/**
 * The investments tools build their query strings from the routes' own query schemas
 * (`queryString`), and take the shared lists for a fixed choice.
 */

/**
 * The lists @nuggets/shared exports, by their values: each exported list of
 * strings, and each exported z.enum's options. A tool that writes one out again keeps offering
 * the old values when the list changes.
 */
const SHARED_LISTS = (() => {
  const lists = new Map<string, string>();
  const add = (values: unknown, name: string) => {
    if (Array.isArray(values) && values.length > 1 && values.every((v) => typeof v === 'string')) {
      const key = [...values].sort().join('|');
      if (!lists.has(key)) lists.set(key, name);
    }
  };
  for (const [name, value] of Object.entries(shared)) {
    add(value, name);
    if (value instanceof z.ZodEnum) add(value.options, `${name}.options`);
  }
  return lists;
})();

/** Every array literal of two or more strings in `source` that is one of shared's lists, in any spelling. */
function writtenOutLists(source: string, file: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.length > 1 && node.elements.every((e) => ts.isStringLiteralLike(e))) {
      const values = node.elements.map((e) => (e as ts.StringLiteralLike).text);
      const list = SHARED_LISTS.get([...values].sort().join('|'));
      if (list) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1} writes out ${list}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The TypeScript files under `dir`, recursively. */
function sourceFiles(dir: URL): URL[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(new URL(`${entry.name}/`, dir)) : entry.name.endsWith('.ts') ? [new URL(entry.name, dir)] : []
  );
}

const ACCOUNT = '019a3b2c-1d2e-7f00-8a00-000000000001';
const SECURITY = '019a3b2c-1d2e-7f00-8a00-000000000003';

describe("the investments tools' query strings", () => {
  it("refuse a value the route's query schema refuses, with its message, before any request", async () => {
    for (const [tool, args, message] of [
      ['list_holding_events', { accountUuid: 'not-a-uuid' }, 'account must be a uuid'],
      ['list_holding_events', { startDate: '2025-02-30' }, 'start_date must be a real YYYY-MM-DD date'],
      ['preview_sell_tax_impact', { accountUuid: ACCOUNT, securityUuid: SECURITY, shares: 0 }, 'shares must be a positive number'],
      ['find_tax_loss_harvest_candidates', { minLoss: '1e2' }, 'min_loss must be an amount in dollars'],
      // What the API answers a NUL in any field with, before its route (nulText), word for word.
      ['list_unused_securities', { search: 'a\u0000b' }, "search can't contain a NUL character (\\u0000)"],
    ] as const) {
      const { fetchImpl, calls } = makeFetchStub();
      const result = await callTool(fetchImpl, tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      // As the route answers it: a 400 VALIDATION_ERROR with its message.
      expect(resultJson(result)).toEqual({ status: 400, code: 'VALIDATION_ERROR', message: expect.stringContaining(message) });
      expect(calls).toHaveLength(0);
    }
  });

  it('send what the schema reads, as the route reads it', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    await callTool(fetchImpl, 'suggest_lot_selection', { accountUuid: ACCOUNT, securityUuid: SECURITY, objective: 'highest_cost', pricePerShare: 12.5 });
    expect(calls.map(describeCall)).toEqual([{
      method: 'GET',
      path: '/api/investments/reports/lot-suggestions',
      query: { account: ACCOUNT, security: SECURITY, objective: 'highest_cost', price: '12.5' },
      body: undefined,
    }]);
  });

  it('the client takes the built text as the query, and only as parameters', async () => {
    const { fetchImpl, calls } = makeFetchStub();
    const client = new NuggetsApiClient({ baseUrl: 'http://test.local', authorization: 'Bearer t', fetchImpl });
    await client.get('/api/investments/holdings', '?account=a%26b&x=1');
    await client.get('/api/investments/holdings', '');
    await client.get('/api/investments/holdings', '?a=1#/../admin');
    expect(calls.map((c) => new URL(c.url).search)).toEqual(['?account=a%26b&x=1', '', '?a=1%23%2F..%2Fadmin']);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(Array(3).fill('/api/investments/holdings'));
  });
});

describe("the investments tools' fixed lists", () => {
  const tools = registeredTools(makeFetchStub().fetchImpl);
  const options = (tool: string, key: string) => {
    const field = inputSchemaOf(tools.get(tool)!).shape[key] as unknown as { unwrap?: () => { options: string[] }; options?: string[] };
    return field.options ?? field.unwrap?.().options;
  };

  it('are never a shared list written out, anywhere in the MCP source', () => {
    const problems = sourceFiles(new URL('../src/', import.meta.url)).flatMap((file) => writtenOutLists(readFileSync(file, 'utf8'), file.pathname.replace(/^.*\/mcp\//, 'mcp/')));
    expect(problems).toEqual([]);
  });

  it('would catch a list written out in any form', () => {
    for (const source of [
      "z.enum(['Essential', 'Optional'])",
      "z\n  .enum([\n    'Essential',\n    'Optional',\n  ])",
      'z.enum(["Optional", "Essential"])',
      "const PRIORITIES = ['Essential', `Optional`] as const; z.enum(PRIORITIES);",
      "const ui = { objectives: ['minimize_gain', 'maximize_loss', 'longest_held', 'highest_cost'] };",
    ]) {
      expect(writtenOutLists(source, 'probe.ts'), source).toHaveLength(1);
    }
    // A list that isn't one of shared's, or one value of it, is the tool's own.
    expect(writtenOutLists("z.enum(['cash', 'stock']); z.enum(['Essential']); f(['Essential', 'Optional', 'Other']);", 'probe.ts')).toEqual([]);
  });

  it('are the shared lists the routes check', () => {
    expect(options('suggest_lot_selection', 'objective')).toEqual([...LOT_OBJECTIVES]);
    expect(options('get_securities_needing_data', 'category')).toEqual([...SECURITY_DATA_NEEDS]);
  });
});
