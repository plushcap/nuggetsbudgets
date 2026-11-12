import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  ACCOUNT_GROUPS,
  CONTROL_PLANE_VOCABULARIES,
  TENANT_VOCABULARIES,
  REVIEW_STATUSES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from '@nuggets/shared';
import { inputSchemaOf, makeFetchStub, registeredTools } from './harness.js';

/**
 * What a tool takes for a fixed list is the list's own value: the
 * tools' enums come from @nuggets/shared's vocabulary.ts, and the server checks a value
 * against its list exactly, so an enum value in another case or spelling ('Cleared',
 * 'needs_review') would be one no call could send successfully.
 */

const VOCABULARY: Record<string, readonly string[]> = { ...TENANT_VOCABULARIES, ...CONTROL_PLANE_VOCABULARIES };
const loose = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const EXACT = new Set(Object.values(VOCABULARY).flat());
const NEAR = new Map<string, string[]>();
for (const [column, values] of Object.entries(VOCABULARY)) {
  for (const value of values) NEAR.set(loose(value), [...(NEAR.get(loose(value)) ?? []), `${column} '${value}'`]);
}

type JsonSchema = {
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
};

/** Every enum in a JSON schema, with where it is. */
function enumsIn(schema: JsonSchema | undefined, path: string): { path: string; values: unknown[] }[] {
  if (!schema || typeof schema !== 'object') return [];
  const found = schema.enum ? [{ path, values: schema.enum }] : [];
  for (const [key, prop] of Object.entries(schema.properties ?? {})) found.push(...enumsIn(prop, `${path}.${key}`));
  found.push(...enumsIn(schema.items, `${path}[]`));
  for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) found.push(...enumsIn(branch, path));
  if (typeof schema.additionalProperties === 'object') found.push(...enumsIn(schema.additionalProperties, `${path}{}`));
  return found;
}

/** The values in `schema`'s enums that are nearly a list's value and exactly none. */
function nearMisses(schema: JsonSchema, at: string): string[] {
  return enumsIn(schema, at).flatMap(({ path, values }) =>
    values
      .filter((v): v is string => typeof v === 'string' && !EXACT.has(v) && NEAR.has(loose(v)))
      .map((v) => `${path} '${v}': nearly ${NEAR.get(loose(v))!.join(' / ')}`),
  );
}

const jsonSchema = (shape: z.ZodRawShape) => z.toJSONSchema(z.object(shape), { io: 'input' }) as JsonSchema;
const tools = registeredTools(makeFetchStub().fetchImpl);
const enumOf = (tool: string, ...path: string[]) => {
  let schema = z.toJSONSchema(inputSchemaOf(tools.get(tool)!), { io: 'input' }) as JsonSchema;
  for (const key of path) schema = key === '[]' ? schema.items! : schema.properties![key]!;
  return schema.enum ?? schema.anyOf?.flatMap((b) => b.enum ?? []);
};

describe("the tools' fixed lists", () => {
  it('take every value as the server checks it, never in another spelling', () => {
    const problems = [...tools.values()].flatMap((tool) => nearMisses(jsonSchema(tool.config.inputSchema), tool.name));
    expect(problems).toEqual([]);
  });

  it('would catch a value in another spelling', () => {
    expect(nearMisses(jsonSchema({ status: z.enum(['Cleared', 'pending']) }), 'probe')).toEqual([
      "probe.status 'Cleared': nearly transactions.status 'cleared'",
    ]);
    expect(nearMisses(jsonSchema({ rows: z.array(z.object({ review: z.enum(['needs_review']).optional() })) }), 'probe')).toHaveLength(1);
    expect(nearMisses(jsonSchema({ merger: z.enum(['cash', 'stock']) }), 'probe')).toEqual([]);
  });

  it('are the shared lists, with the subsets the tools have always offered', () => {
    for (const [tool, path] of [
      ['list_transactions', ['type']],
      ['create_transaction', ['type']],
      ['create_transactions', ['transactions', '[]', 'type']],
    ] as const) {
      expect(enumOf(tool, ...path), `${tool}.${path.join('.')}`).toEqual([...TRANSACTION_TYPES]);
    }
    for (const [tool, path] of [
      ['list_transactions', ['reviewStatus']],
      ['create_transaction', ['reviewStatus']],
      ['bulk_classify', ['reviewStatus']],
    ] as const) {
      expect(enumOf(tool, ...path), `${tool}.${path.join('.')}`).toEqual([...REVIEW_STATUSES]);
    }
    // A new transaction is pending or cleared; an account group never the legacy spelling.
    expect(enumOf('create_transaction', 'status')).toEqual(TRANSACTION_STATUSES.filter((s) => s !== 'reconciled'));
    expect(enumOf('create_account', 'accountGroup')).toEqual(ACCOUNT_GROUPS.filter((g) => g !== 'credit_cards'));
  });
});
