import { z } from 'zod';
import { emptyAsUndefined, queryEnum, queryPage } from './primitives.js';
import { regexRuleProblem } from './rulePattern.js';
import { websiteUrlProblem } from './urls.js';
import { dayText, instant, nullableInstant, responseAmount, responseCount } from './responses.js';

/**
 * A merchant's website as a client sends it: empty or absent for
 * none, else an http(s) URL with no user name or password in it. A bare host such as
 * `example.com` is taken as `https://example.com`. The parsed value is what gets stored.
 */
export const merchantWebsite = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value, ctx) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return null;
    const result = websiteUrlProblem(text);
    if (result.problem) {
      ctx.addIssue({ code: 'custom', message: result.problem });
      return z.NEVER;
    }
    return result.url;
  });

/** POST /api/merchants body. name required; other fields pass through. */
export const merchantCreateSchema = z.looseObject({
  name: z.string({ error: 'Name is required' }).trim().min(1, 'Name is required'),
  merchant_website: merchantWebsite.optional(),
});
export type MerchantCreateInput = z.infer<typeof merchantCreateSchema>;

/** PUT /api/merchants/:uuid body: the fields checked here; the route checks the name. */
export const merchantUpdateSchema = z.looseObject({
  merchant_website: merchantWebsite.optional(),
});

/** Matching methods a merchant rule can use. */
export const merchantRuleMethod = z.enum(['exact', 'contains', 'starts_with', 'ends_with', 'regex']);
export type MerchantRuleMethod = z.infer<typeof merchantRuleMethod>;

/** POST/PUT body for a merchant matching rule (the rules form, and the rule routes).
 * matching_text is required text, not blank; it is checked, not trimmed, so a rule keeps
 * the text it was given (`starts_with 'NU '`). Loose so the method (and anything else)
 * passes through: the routes check the method first. A regex rule's pattern must be one
 * that can't stall the server. */
export const merchantRuleCreateSchema = z
  .looseObject({
    matching_text: z
      .string({ error: (issue) => (issue.input === undefined ? 'Matching text is required' : 'Matching text must be text') })
      .refine((text) => text.trim().length > 0, 'Matching text is required'),
  })
  .superRefine((rule, ctx) => {
    const problem = (rule as { method?: unknown }).method === 'regex' ? regexRuleProblem(rule.matching_text.trim()) : null;
    if (problem) ctx.addIssue({ code: 'custom', path: ['matching_text'], message: problem });
  });
export type MerchantRuleCreateInput = z.infer<typeof merchantRuleCreateSchema>;

// ---------------------------------------------------------------------------
// Query strings and the merge and apply-rules bodies.

/** `fields=lite`: id, uuid, name and website (and image on a page) only, without the counts, which cost a pass over the transactions. */
const merchantFields = queryEnum(['lite']);

/** GET /api/merchants query. */
export const merchantListQuery = z.object({ fields: merchantFields });
export type MerchantListQuery = z.infer<typeof merchantListQuery>;

/** GET /api/merchants/paginated query: the page (50 by default, at most 100), a search of name, website and notes (sent once), fields. */
export const merchantPageQuery = z.object({
  ...queryPage({ defaultLimit: 50, maxLimit: 100 }),
  search: emptyAsUndefined(z.string({ error: 'search must be sent once' })),
  fields: merchantFields,
});
export type MerchantPageQuery = z.infer<typeof merchantPageQuery>;

/** GET /api/merchants/search query: `q`, the name to complete (blank: none found), sent once. Up to ten are answered. */
export const merchantSearchQuery = z.object({
  q: emptyAsUndefined(z.string({ error: 'q must be sent once' })),
});
export type MerchantSearchQuery = z.infer<typeof merchantSearchQuery>;

/** POST /api/merchants/:uuid/merge body: the merchant that takes this one's uses (by uuid; one that isn't one names none: 404). */
export const merchantMergeSchema = z.looseObject({
  targetMerchantUuid: z.string({ error: 'Target merchant UUID is required' }).min(1, 'Target merchant UUID is required'),
});
export type MerchantMergeInput = z.infer<typeof merchantMergeSchema>;

/**
 * DELETE /api/merchants/:uuid body, which a DELETE usually doesn't send: a merchant in use
 * names the one that takes over its uses by uuid (`replacementMerchantId`, a uuid despite
 * its name). Empty, null or absent is none; anything else that isn't a uuid is a 400 here
 * (it was read with no schema). A uuid that names no merchant of the ledger is the
 * service's 400 "Invalid replacement merchant".
 */
export const merchantDeleteSchema = z
  .looseObject({
    replacementMerchantId: emptyAsUndefined(
      z.uuid({ error: "replacementMerchantId must be the replacement merchant's uuid" }).nullable()
    ),
  })
  .default({});
export type MerchantDeleteInput = z.infer<typeof merchantDeleteSchema>;

const INT4_MAX = 2147483647;
const TRANSACTION_ID = 'Transaction IDs must be whole numbers';

/**
 * POST /api/merchants/:uuid/apply-rules body: the transactions (by id, from its rules'
 * preview) to give the merchant. An id that isn't a whole number failed in the query (a 500).
 */
export const merchantApplyRulesSchema = z.looseObject({
  transactionIds: z
    .array(z.number({ error: TRANSACTION_ID }).int(TRANSACTION_ID).positive(TRANSACTION_ID).max(INT4_MAX, TRANSACTION_ID), {
      error: 'Transaction IDs are required',
    })
    .min(1, 'Transaction IDs are required'),
});
export type MerchantApplyRulesInput = z.infer<typeof merchantApplyRulesSchema>;

// ---------------------------------------------------------------------------
// Answers.

/**
 * A merchant as one merchant (GET /api/merchants/:uuid), a create, an update and an image
 * upload answer it: its own columns. The full lists add its counts
 * ({@link merchantWithCountsResponseSchema}); they're optional here, so one type serves both.
 */
export const merchantResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  merchant_website: z.string().nullable(),
  merchant_accountid: z.string().nullable(),
  merchant_image: z.string().nullable(),
  notes: z.string().nullable(),
  /** For agents: how to treat the merchant's transactions. Distinct from notes. */
  instructions: z.string().nullable(),
  /** The tag its transactions get automatically, or null. */
  transaction_auto_tag_id: z.number().int().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
  /** The full lists only: how many transactions and matching rules it has. */
  transaction_count: responseCount.optional(),
  rule_count: responseCount.optional(),
});
export type MerchantResponse = z.infer<typeof merchantResponseSchema>;

/** A merchant as the full lists answer it (GET /api/merchants, /paginated): with its counts. */
export const merchantWithCountsResponseSchema = merchantResponseSchema.required({ transaction_count: true, rule_count: true });

/** GET /api/merchants?fields=lite: only what a selector needs, without the counts. */
export const merchantLiteResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  merchant_website: z.string().nullable(),
});
export type MerchantLite = z.infer<typeof merchantLiteResponseSchema>;

/** A merchant as the search (GET /api/merchants/search) and a lite page answer it: with its image. */
export const merchantBriefResponseSchema = merchantLiteResponseSchema.extend({ merchant_image: z.string().nullable() });
export type MerchantBrief = z.infer<typeof merchantBriefResponseSchema>;

/** GET /api/merchants (without `fields=lite`). */
export const merchantListResponseSchema = z.array(merchantWithCountsResponseSchema);
/** GET /api/merchants?fields=lite. */
export const merchantLiteListResponseSchema = z.array(merchantLiteResponseSchema);
/** GET /api/merchants/search. */
export const merchantSearchResponseSchema = z.array(merchantBriefResponseSchema);

const merchantPaging = z.object({
  total: z.number().int(),
  totalPages: z.number().int(),
  page: z.number().int(),
  limit: z.number().int(),
});

/** GET /api/merchants/paginated: a page of merchants with their counts. */
export const merchantPageResponseSchema = z.object({
  merchants: z.array(merchantWithCountsResponseSchema),
  pagination: merchantPaging,
});
export type MerchantPageResponse = z.infer<typeof merchantPageResponseSchema>;

/** GET /api/merchants/paginated?fields=lite: a page of merchants without their counts. */
export const merchantLitePageResponseSchema = z.object({
  merchants: z.array(merchantBriefResponseSchema),
  pagination: merchantPaging,
});

/** POST /api/merchants/:uuid/upload-image: the merchant with its new image. */
export const merchantImageResponseSchema = z.object({ message: z.string(), merchant: merchantResponseSchema });

/** POST /api/merchants/:uuid/merge. */
export const merchantMergeResponseSchema = z.object({ message: z.string(), targetMerchantUuid: z.string() });

/** A merchant's matching rule: GET /api/merchants/:uuid/rules lists them; a create or an update answers one. */
export const merchantRuleResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  merchant_id: z.number().int().nullable(),
  method: merchantRuleMethod,
  matching_text: z.string(),
  created_at: instant,
  updated_at: nullableInstant,
});
export type MerchantRuleResponse = z.infer<typeof merchantRuleResponseSchema>;

/** GET /api/merchants/:uuid/rules. */
export const merchantRuleListResponseSchema = z.array(merchantRuleResponseSchema);

const ruleSummary = { id: z.number().int(), method: merchantRuleMethod, matching_text: z.string() };

/**
 * POST /api/merchants/:uuid/test-rules: the transactions its rules would give it, each with
 * the rule that matched it, and the regex rules that couldn't be run. A merchant without
 * rules answers only `matchingTransactions` (none) and `message`.
 */
export const merchantRulePreviewResponseSchema = z.object({
  matchingTransactions: z.array(
    z.object({
      id: z.number().int(),
      uuid: z.uuid(),
      description: z.string().nullable(),
      import_payee: z.string().nullable(),
      /** Pre-signed. */
      amount: responseAmount,
      transaction_date: dayText,
      type: z.string(),
      account_name: z.string().nullable(),
      matchingRule: z.object(ruleSummary),
    })
  ),
  totalRules: z.number().int().optional(),
  skippedRules: z.array(z.object({ ...ruleSummary, reason: z.enum(['invalid_pattern', 'too_slow']) })).optional(),
  message: z.string(),
});
export type MerchantRulePreview = z.infer<typeof merchantRulePreviewResponseSchema>;

/** POST /api/merchants/:uuid/apply-rules. */
export const merchantApplyRulesResponseSchema = z.object({
  updatedCount: z.number().int(),
  merchantName: z.string(),
  message: z.string(),
});

/** POST /api/merchants/admin/remove-unused: the merchants deleted, by name. */
export const merchantRemoveUnusedResponseSchema = z.object({
  message: z.string(),
  removedCount: z.number().int(),
  removedMerchants: z.array(z.object({ uuid: z.uuid(), name: z.string() })),
});

/**
 * GET /api/merchant-spending/:uuid: the merchant's spending summary for its page,
 * over the 24 months to the household's today. Each total is the sum of the
 * transactions' sizes (ABS(amount)), a NUMERIC sum pg sends as text.
 */
export const merchantSpendingResponseSchema = z.object({
  merchant_uuid: z.uuid(),
  /** The first day counted: 24 months before the household's today. */
  since: dayText,
  /** All the merchant's transactions, any date. */
  transaction_count: z.number().int(),
  /** Its matching rules. */
  rule_count: z.number().int(),
  /** Per 'YYYY-MM' month, oldest first. */
  monthly: z.array(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), total: responseAmount })),
  /** Per budget item (null for none), largest first. */
  by_budget_item: z.array(
    z.object({ budget_item_uuid: z.uuid().nullable(), budget_item_name: z.string().nullable(), total: responseAmount })
  ),
});
/** The summary as the page reads it: totals as numbers. */
export type MerchantSpending = z.infer<typeof merchantSpendingResponseSchema>;
/** The summary as the route sends it (totals as pg's text): what the backend's service answers. */
export type MerchantSpendingAnswer = z.input<typeof merchantSpendingResponseSchema>;
