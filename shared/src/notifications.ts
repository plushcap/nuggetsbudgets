/**
 * Notification rules: what a tenant's members get told about, and each
 * person's choice of which they get and how (email, push).
 *
 * A rule is one of five kinds:
 * - `budget_item`      a budget item in the current period whose figures match `when`
 * - `transaction`      a transaction added in the last week that matches `when`
 * - `review_reminder`  a nudge to the person transactions are assigned to, at most every few days, while `when` holds
 * - `digest`           a weekly summary, on a weekday and hour in the application time zone
 * - `bill`             a bill payment due (one per due date) whose status matches `when`
 *
 * `when` is a small condition language over the facts each kind computes.
 * Which facts exist, and what values they take, is listed here so the server,
 * the web app's condition editor and MCP all agree.
 */
import { z } from 'zod';
import { emptyAsUndefined, queryPage } from './primitives.js';
import { dayText, instant, nullableInstant, storedValue } from './responses.js';
import { transactionType } from './transactions.js';
import { NOTIFICATION_STATUSES } from './vocabulary.js';

export const notificationRuleKinds = ['budget_item', 'transaction', 'review_reminder', 'digest', 'bill'] as const;
export type NotificationRuleKind = (typeof notificationRuleKinds)[number];

/** A fact's type decides which comparisons and values make sense for it. */
export type NotificationFactType =
  | { type: 'boolean' }
  | { type: 'number' }
  | { type: 'choice'; values: readonly string[] }
  | { type: 'words' };

const transactionTypes = transactionType.options;

/** A budget item fact's kind: whether its money comes in or goes out. */
export const budgetItemFactKind = z.enum(['expense', 'income']);
export type BudgetItemFactKind = z.infer<typeof budgetItemFactKind>;

/**
 * The facts each condition-based kind computes. Money is in dollars and
 * positive: `spent`, `size` and the like are amounts, not pre-signed values;
 * a transaction's signed `amount` is the exception.
 */
export const notificationFacts = {
  budget_item: {
    name: { type: 'words' },
    category: { type: 'words' },
    kind: { type: 'choice', values: budgetItemFactKind.options },
    envelope: { type: 'boolean' },
    bill: { type: 'boolean' },
    budgeted: { type: 'number' },
    spent: { type: 'number' },
    received: { type: 'number' },
    remaining: { type: 'number' },
    percent_used: { type: 'number' },
    over_budget: { type: 'boolean' },
    days_left: { type: 'number' },
    percent_of_period: { type: 'number' },
  },
  transaction: {
    amount: { type: 'number' },
    size: { type: 'number' },
    direction: { type: 'choice', values: ['in', 'out'] },
    type: { type: 'choice', values: transactionTypes },
    description: { type: 'words' },
    merchant: { type: 'words' },
    account: { type: 'words' },
    budget_item: { type: 'words' },
    has_budget_item: { type: 'boolean' },
    review_status: { type: 'choice', values: ['needs review', 'reviewed', 'flagged'] },
    from_bank_sync: { type: 'boolean' },
    pending: { type: 'boolean' },
    days_since_added: { type: 'number' },
  },
  review_reminder: {
    unreviewed_count: { type: 'number' },
    unreviewed_total: { type: 'number' },
    oldest_unreviewed_days: { type: 'number' },
  },
  bill: {
    name: { type: 'words' },
    category: { type: 'words' },
    amount: { type: 'number' },
    paid: { type: 'boolean' },
    partly_paid: { type: 'boolean' },
    skipped: { type: 'boolean' },
    /** Days from today to the due date; negative once it has passed. */
    days_until_due: { type: 'number' },
    varies: { type: 'boolean' },
  },
} as const satisfies Record<Exclude<NotificationRuleKind, 'digest'>, Record<string, NotificationFactType>>;

export type ConditionRuleKind = keyof typeof notificationFacts;

/** The type of `fact` for a `kind`, or undefined when that kind doesn't compute it. */
export function notificationFactType(kind: ConditionRuleKind, fact: string): NotificationFactType | undefined {
  const facts: Record<string, NotificationFactType> = notificationFacts[kind];
  return Object.hasOwn(facts, fact) ? facts[fact] : undefined;
}

export const notificationRuleKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower case letters, digits and underscores, up to 40.');

const literalSchema = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
const operandSchema = z.union([
  z.number(),
  z.string().regex(/^-?\d+(\.\d+)?$/, 'Give a number.'),
]);
const factNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Name a fact.');

export type ConditionLiteral = z.infer<typeof literalSchema>;
export type ConditionOperand = z.infer<typeof operandSchema>;

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { fact: string; is: ConditionLiteral }
  | { fact: string; in: ConditionLiteral[] }
  | { fact: string; lt: ConditionOperand }
  | { fact: string; lte: ConditionOperand }
  | { fact: string; gt: ConditionOperand }
  | { fact: string; gte: ConditionOperand }
  | { fact: string; hasWords: string[] };

/**
 * A condition: `all`/`any` of parts (an empty `all` is always true, an empty
 * `any` never), `not` of one, or a comparison of a fact. Which facts a rule may
 * name, and with which values, is checked by {@link conditionProblems}.
 */
export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(conditionSchema).max(50) }),
    z.strictObject({ any: z.array(conditionSchema).max(50) }),
    z.strictObject({ not: conditionSchema }),
    z.strictObject({ fact: factNameSchema, is: literalSchema }),
    z.strictObject({ fact: factNameSchema, in: z.array(literalSchema).min(1).max(50) }),
    z.strictObject({ fact: factNameSchema, lt: operandSchema }),
    z.strictObject({ fact: factNameSchema, lte: operandSchema }),
    z.strictObject({ fact: factNameSchema, gt: operandSchema }),
    z.strictObject({ fact: factNameSchema, gte: operandSchema }),
    z.strictObject({
      fact: factNameSchema,
      hasWords: z.array(z.string().trim().min(1).max(60)).min(1).max(100),
    }),
  ]),
);

/** Conditions nest at most this deep; a comparison at the top is depth 1. */
export const deepestCondition = 8;

type Comparison = Exclude<Condition, { all: Condition[] } | { any: Condition[] } | { not: Condition }>;

/** Visit every comparison in `condition`; returns the deepest nesting level. */
export function eachComparison(condition: Condition, visit: (comparison: Comparison) => void, depth = 1): number {
  if ('all' in condition || 'any' in condition) {
    const parts = 'all' in condition ? condition.all : condition.any;
    return parts.reduce((deepest, part) => Math.max(deepest, eachComparison(part, visit, depth + 1)), depth);
  }
  if ('not' in condition) return eachComparison(condition.not, visit, depth + 1);
  visit(condition);
  return depth;
}

function quoted(fact: string): string {
  return `“${fact}”`;
}

function fits(type: NotificationFactType, value: ConditionLiteral): boolean {
  switch (type.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' || value === null;
    case 'choice':
      return typeof value === 'string' && type.values.includes(value);
    case 'words':
      return typeof value === 'string' || value === null;
  }
}

function mismatch(fact: string, type: NotificationFactType, comparison: Comparison): string | undefined {
  if ('lt' in comparison || 'lte' in comparison || 'gt' in comparison || 'gte' in comparison) {
    return type.type === 'number' ? undefined : `${quoted(fact)} isn’t a number to compare.`;
  }
  if ('hasWords' in comparison) {
    return type.type === 'words' ? undefined : `${quoted(fact)} isn’t text to look for words in.`;
  }
  const values = 'is' in comparison ? [comparison.is] : comparison.in;
  if (values.every((value) => fits(type, value))) return undefined;
  switch (type.type) {
    case 'boolean':
      return `${quoted(fact)} is true or false.`;
    case 'number':
      return `${quoted(fact)} is a number.`;
    case 'choice':
      return `${quoted(fact)} is one of ${type.values.join(', ')}.`;
    case 'words':
      return `${quoted(fact)} is a word.`;
  }
}

/**
 * What is wrong with `condition` for a rule of `kind`, as sentences for a
 * person: facts the kind doesn't compute, values that don't fit a fact's type,
 * and nesting deeper than {@link deepestCondition}. Empty when it's fine.
 */
export function conditionProblems(condition: Condition, kind: ConditionRuleKind): string[] {
  const problems = new Set<string>();
  const depth = eachComparison(condition, (comparison) => {
    const type = notificationFactType(kind, comparison.fact);
    if (!type) {
      problems.add(`A ${kind.replace('_', ' ')} rule doesn’t know ${quoted(comparison.fact)}.`);
      return;
    }
    const problem = mismatch(comparison.fact, type, comparison);
    if (problem) problems.add(problem);
  });
  if (depth > deepestCondition) problems.add('Nest conditions at most eight deep.');
  return [...problems];
}

const labelSchema = z
  .string()
  .trim()
  .min(1, 'Give it a name.')
  .max(80, 'Keep the name to 80 characters.');

// A model may send "false" as a string, which z.coerce.boolean would read as true.
const booleanInput = z.union([z.boolean(), z.stringbool()]);

/**
 * How a rule may reach people: both channels, or only one. Each person can
 * narrow it further for themselves, but never add a channel the rule leaves out.
 */
export const notificationSendBySchema = z.enum(['both', 'email', 'push']);
export type NotificationSendBy = z.infer<typeof notificationSendBySchema>;

/** Who a transaction rule reaches: every member of the ledger, or only the person it's assigned to. */
export const NOTIFICATION_AUDIENCES = ['everyone', 'assignee'] as const;
export const notificationAudienceSchema = z.enum(NOTIFICATION_AUDIENCES);
export type NotificationAudience = z.infer<typeof notificationAudienceSchema>;
/** The ways a rule may reach people, in the order the page offers them. */
export const NOTIFICATION_SEND_BY = notificationSendBySchema.options;

/** Whether a rule that sends by `sendBy` uses `channel`. */
export function sendsBy(sendBy: NotificationSendBy, channel: 'email' | 'push'): boolean {
  return sendBy === 'both' || sendBy === channel;
}

const ruleBase = {
  key: notificationRuleKeySchema,
  label: labelSchema,
  /** Whether the tenant sends it at all; each person can then turn it off for themselves. */
  enabled: booleanInput,
  // Rules saved before this setting existed read as both channels.
  sendBy: notificationSendBySchema.default('both'),
};

/** A budget item in the current budget period whose figures match `when`. Sent once per item per period. */
export const budgetItemNotificationRuleSchema = z.object({
  ...ruleBase,
  kind: z.literal('budget_item'),
  when: conditionSchema,
});

/**
 * A transaction added to Nuggets in the last week that matches `when`. Sent
 * once per transaction, to every member or only to the person it's assigned to.
 */
export const transactionNotificationRuleSchema = z.object({
  ...ruleBase,
  kind: z.literal('transaction'),
  audience: notificationAudienceSchema,
  when: conditionSchema,
});

/**
 * A reminder to each person about the transactions assigned to them that
 * need review, while `when` holds: from `hour` (0-23, application time zone)
 * on a day, and at most once every `everyDays` days.
 */
export const reviewReminderNotificationRuleSchema = z.object({
  ...ruleBase,
  kind: z.literal('review_reminder'),
  when: conditionSchema,
  everyDays: z.coerce.number().int().min(1).max(30),
  hour: z.coerce.number().int().min(0).max(23),
});

/**
 * A weekly summary for every member, sent on `weekday` (1 Monday, 7 Sunday)
 * from `hour` in the application time zone.
 */
export const digestNotificationRuleSchema = z.object({
  ...ruleBase,
  kind: z.literal('digest'),
  weekday: z.coerce.number().int().min(1).max(7),
  hour: z.coerce.number().int().min(0).max(23),
});

/** A bill payment due on a date whose status matches `when`. Sent once per due date. */
export const billNotificationRuleSchema = z.object({
  ...ruleBase,
  kind: z.literal('bill'),
  when: conditionSchema,
});

export const notificationRuleSchema = z.discriminatedUnion('kind', [
  budgetItemNotificationRuleSchema,
  transactionNotificationRuleSchema,
  reviewReminderNotificationRuleSchema,
  digestNotificationRuleSchema,
  billNotificationRuleSchema,
]);

export type NotificationRule = z.infer<typeof notificationRuleSchema>;

/** A tenant's notification rules. The whole list is saved at once. */
export const notificationRulesSchema = z.object({
  rules: z
    .array(notificationRuleSchema)
    .max(20, 'Keep it to 20 rules.')
    .refine((rules) => new Set(rules.map((rule) => rule.key)).size === rules.length, 'Give each rule its own key.')
    .superRefine((rules, context) => {
      rules.forEach((rule, index) => {
        if (rule.kind === 'digest') return;
        for (const message of conditionProblems(rule.when, rule.kind)) {
          context.addIssue({ code: 'custom', path: [index, 'when'], message });
        }
      });
    }),
});

export type NotificationRules = z.infer<typeof notificationRulesSchema>;
export type NotificationRulesInput = z.input<typeof notificationRulesSchema>;

/**
 * How deeply `value` nests, counted without recursion. Conditions nest at most eight
 * deep, but {@link notificationRulesSchema} parses recursively, so a body nested thousands
 * deep would exhaust the stack before it could say no.
 */
export function nestingDepth(value: unknown): number {
  let deepest = 0;
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!; // non-empty: checked by the loop condition
    if (typeof node !== 'object' || node === null) continue;
    deepest = Math.max(deepest, depth);
    for (const child of Object.values(node)) stack.push([child, depth + 1]);
  }
  return deepest;
}

/** The deepest a body of rules may nest: rules → rule → when → eight levels of condition, with room to spare. */
const deepestRulesBody = 40;

/**
 * PUT /api/notifications/rules: {@link notificationRulesSchema}, after a check that the body
 * isn't nested too deep to parse (the pipe stops there when it is).
 */
export const saveNotificationRulesRequestSchema = z
  .unknown()
  .superRefine((value, context) => {
    if (nestingDepth(value) > deepestRulesBody) context.addIssue({ code: 'custom', message: 'Nest conditions at most eight deep.' });
  })
  .pipe(notificationRulesSchema);

/** GET /api/notifications/history: a page of the tenant's sent and queued notifications, optionally of one status or kind. */
export const notificationHistoryQuery = z.object({
  ...queryPage({ defaultLimit: 20, maxLimit: 100 }),
  status: emptyAsUndefined(z.string({ error: 'Give one status.' }).max(50, 'Give one status.')),
  type: emptyAsUndefined(z.string({ error: 'Give one type.' }).max(50, 'Give one type.')),
});

/** The made-up messages a deployment admin can send as a test, or preview. */
export const NOTIFICATION_SAMPLE_TYPES = ['transaction-review', 'budget-overspending'] as const;
export type NotificationSampleType = (typeof NOTIFICATION_SAMPLE_TYPES)[number];
export const NOTIFICATION_SAMPLE_TYPE_ERROR = 'Invalid templateType. Must be transaction-review or budget-overspending';

const requiredForTest = 'Recipient and templateType are required';

/**
 * POST /api/admin/notifications/test: a sample message to `recipient`, through the
 * deployment's SMTP account. The address is one mailbox: no spaces, control characters
 * (\p{Cc}), quotes, angle brackets or separators, which could add a recipient or a header.
 */
export const testNotificationEmailRequestSchema = z.object({
  recipient: z
    .string({ error: requiredForTest })
    .trim()
    .min(1, requiredForTest)
    .max(320, 'Must be an email address')
    .regex(/^[^\s\p{Cc}@<>"(),;:\\]+@[^\s\p{Cc}@<>"(),;:\\]+$/u, 'Must be an email address'),
  templateType: z.enum(NOTIFICATION_SAMPLE_TYPES, {
    error: (issue) => (issue.input === undefined || issue.input === '' ? requiredForTest : NOTIFICATION_SAMPLE_TYPE_ERROR),
  }),
});

export type TestNotificationEmailRequest = z.infer<typeof testNotificationEmailRequestSchema>;

/**
 * Bill reminders: one when a bill is due within 3 days and not paid, one when
 * it's past due. Also added to tenants that had saved their rules before bills
 * were tracked (by a migration before v3.0.0).
 */
export const defaultBillNotificationRules: NotificationRule[] = [
  {
    key: 'bill_due_soon',
    label: 'A bill due soon',
    enabled: true,
    sendBy: 'both',
    kind: 'bill',
    when: {
      all: [
        { fact: 'paid', is: false },
        { fact: 'skipped', is: false },
        { fact: 'days_until_due', gte: 0 },
        { fact: 'days_until_due', lte: 3 },
      ],
    },
  },
  {
    key: 'bill_overdue',
    label: 'A bill overdue',
    enabled: true,
    sendBy: 'both',
    kind: 'bill',
    when: { all: [{ fact: 'paid', is: false }, { fact: 'skipped', is: false }, { fact: 'days_until_due', lt: 0 }] },
  },
];

/**
 * The rules a tenant has until someone saves its own. The first two are the
 * alerts Nuggets always sent (review reminders at 10 waiting, at most every 3
 * days, from 9am; overspent budget items); the large-purchase rule and the
 * digest start off, as examples to turn on; the bill reminders start on. A
 * tenant that has saved its rules keeps them.
 */
export const defaultNotificationRules: NotificationRules = {
  rules: [
    {
      key: 'review_reminder',
      label: 'Transactions waiting for review',
      enabled: true,
      sendBy: 'both',
      kind: 'review_reminder',
      when: { fact: 'unreviewed_count', gte: 10 },
      everyDays: 3,
      hour: 9,
    },
    {
      key: 'over_budget',
      label: 'A budget item over budget',
      enabled: true,
      sendBy: 'both',
      kind: 'budget_item',
      // An item with no budget this period is "over" at its first purchase; that's noise.
      when: { all: [{ fact: 'over_budget', is: true }, { fact: 'budgeted', gt: 0 }] },
    },
    {
      key: 'large_purchase',
      label: 'A large purchase',
      enabled: false,
      sendBy: 'both',
      kind: 'transaction',
      audience: 'everyone',
      // Expenses only: transfers and card payments move money out too.
      when: { all: [{ fact: 'type', is: 'expense' }, { fact: 'size', gte: 500 }] },
    },
    {
      key: 'weekly_digest',
      label: 'The week in review',
      enabled: false,
      sendBy: 'both',
      kind: 'digest',
      weekday: 7,
      hour: 18,
    },
    ...defaultBillNotificationRules,
  ],
};

/** One rule as a person sees it: whether it reaches them by email and by push. */
export const notificationPreferenceSchema = z.object({
  rule: z.string(),
  label: z.string(),
  kind: z.enum(notificationRuleKinds),
  /** The channels the rule itself uses; `email`/`push` below only count within these. */
  sendBy: notificationSendBySchema,
  email: z.boolean(),
  push: z.boolean(),
});

export type NotificationPreference = z.infer<typeof notificationPreferenceSchema>;

/**
 * A person's choices for the active tenant's enabled rules. `emailAvailable`
 * is false while no SMTP server is set up, so email choices have no effect.
 */
export const notificationPreferencesSchema = z.object({
  emailAvailable: z.boolean(),
  rules: z.array(notificationPreferenceSchema),
});

export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

/** Changing some of one's own choices; a channel left out stays as it is. */
export const setNotificationPreferencesRequestSchema = z.object({
  rules: z
    .array(
      z.object({
        rule: notificationRuleKeySchema,
        email: booleanInput.optional(),
        push: booleanInput.optional(),
      }),
    )
    .min(1)
    .max(20),
});

export type SetNotificationPreferencesRequest = z.input<typeof setNotificationPreferencesRequestSchema>;

/** Stopping one rule's email from the link in it; the token is the link's. */
export const unsubscribeRequestSchema = z.object({
  token: z.string().min(10).max(500),
});

/** What stopping did: which rule's email stopped. */
export const unsubscribeResultSchema = z.object({ label: z.string() });

export type UnsubscribeResult = z.infer<typeof unsubscribeResultSchema>;

// ---- Answers ---------------------------------------------------------------------

/** GET /api/notifications/rules, and PUT's answer: the tenant's rules (its saved ones, or the defaults). */
export const notificationRulesResponseSchema = notificationRulesSchema;

/** GET /api/notifications/preferences, and PUT's answer: the signed-in person's choices. */
export const notificationPreferencesResponseSchema = notificationPreferencesSchema;

/**
 * What a queued notification names (`notifications.template_data`), by the kind of rule that
 * queued it: the rule's key and its subject, by uuid or day. The message is built from them
 * when it goes (NotificationRulesEngine), so nothing else is stored.
 */
export const queuedNotificationDataSchemas = {
  budget_item: z.object({ rule: z.string().min(1), periodItem: z.uuid() }),
  transaction: z.object({ rule: z.string().min(1), transaction: z.uuid() }),
  review_reminder: z.object({ rule: z.string().min(1), day: dayText }),
  digest: z.object({ rule: z.string().min(1), dueOn: dayText }),
  bill: z.object({ rule: z.string().min(1), occurrence: z.uuid() }),
} satisfies Record<NotificationRuleKind, z.ZodType>;
export type QueuedNotificationData = z.infer<(typeof queuedNotificationDataSchemas)[NotificationRuleKind]>;

/**
 * The kinds the notification system before the rules queued. A row
 * of one still pending (sent and failed ones are gone after RETENTION_NOTIFICATION_DAYS) holds
 * that system's own template data, which nothing writes or reads any more: shown as it is.
 */
export const RETIRED_NOTIFICATION_TYPES = ['transaction_review', 'budget_overspending'] as const;

const notificationHistoryFields = {
  id: z.number().int(),
  uuid: z.uuid(),
  user_id: z.number().int(),
  user_email: z.string(),
  user_name: z.string(),
  /** pending, processing, then sent or failed (delivered and bounced for delivery tracking). */
  status: storedValue(NOTIFICATION_STATUSES).nullable(),
  scheduled_for: nullableInstant,
  sent_at: nullableInstant,
  last_attempt_at: nullableInstant,
  error_message: z.string().nullable(),
  retry_count: z.number().int().nullable(),
  ses_message_id: z.string().nullable(),
  created_at: instant,
};
const queuedAs = <K extends NotificationRuleKind>(kind: K) =>
  z.object({ ...notificationHistoryFields, notification_type: z.literal(kind), template_data: queuedNotificationDataSchemas[kind] });

/**
 * One notification queued or sent to a member of the tenant (GET /api/notifications/history),
 * its `template_data` what its kind of rule queued; a retired kind's as it is.
 */
export const notificationHistoryItemResponseSchema = z.union([
  queuedAs('budget_item'),
  queuedAs('transaction'),
  queuedAs('review_reminder'),
  queuedAs('digest'),
  queuedAs('bill'),
  z.object({ ...notificationHistoryFields, notification_type: z.enum(RETIRED_NOTIFICATION_TYPES), template_data: z.unknown() }),
]);
export type NotificationHistoryItem = z.infer<typeof notificationHistoryItemResponseSchema>;

/** GET /api/notifications/history: a page of the tenant's notifications, newest first. */
export const notificationHistoryResponseSchema = z.object({
  success: z.literal(true),
  notifications: z.array(notificationHistoryItemResponseSchema),
  pagination: z.object({
    page: z.number().int(),
    limit: z.number().int(),
    totalCount: z.number().int(),
    totalPages: z.number().int(),
    hasMore: z.boolean(),
  }),
});
export type NotificationHistoryResponse = z.infer<typeof notificationHistoryResponseSchema>;

/** DELETE /api/notifications/history: how many of the tenant's notifications it deleted. */
export const notificationHistoryClearedResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  deletedCount: z.number().int(),
});

/** A deployment notification setting as the admin page shows it (the SMTP password never: only whether it is set). */
const notificationSettingView = z.object({
  value: z.string().nullable(),
  type: z.string().nullable(),
  description: z.string().nullable(),
});
/** GET /api/admin/notifications/settings. */
export const notificationAdminSettingsResponseSchema = z.object({
  settings: z.record(z.string(), notificationSettingView),
  passwordConfigured: z.boolean(),
});
export type NotificationAdminSettings = z.infer<typeof notificationAdminSettingsResponseSchema>;
export type NotificationSettingsMap = NotificationAdminSettings['settings'];

/**
 * GET /api/admin/notifications/status: whether email is set up and on, the scheduler (its
 * settings null while none is running), and the queue across every ledger.
 */
export const notificationStatusResponseSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  scheduler: z.object({
    running: z.boolean(),
    shuttingDown: z.boolean(),
    hasRunningOperations: z.boolean(),
    settings: z
      .object({
        systemEnabled: z.boolean(),
        rulesCheckIntervalMinutes: z.number().int(),
        queueProcessIntervalMinutes: z.number().int(),
      })
      .nullable(),
  }),
  queue: z.object({
    pending: z.number().int(),
    processing: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    total: z.number().int(),
  }),
});
export type NotificationSystemStatus = z.infer<typeof notificationStatusResponseSchema>;

/**
 * POST /api/admin/notifications/settings and the scheduler's start, stop and restart: done,
 * and what to say.
 */
export const notificationAdminActionResponseSchema = z.object({ success: z.literal(true), message: z.string() });

/** POST /api/admin/notifications/test: the sample was sent; `messageId` is the SMTP server's. */
export const notificationTestEmailResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  messageId: z.string(),
});

// ---- Web Push (/api/push: a person's own devices) ----------------------------------

/** GET /api/push/public-key: the server's VAPID key, for the browser to subscribe with. */
export const pushPublicKeyResponseSchema = z.object({ publicKey: z.string() });
/** GET /api/push/subscriptions/count: how many of the signed-in person's devices get push. */
export const pushDeviceCountResponseSchema = z.object({ count: z.number().int() });
/** POST /api/push/subscriptions (201): the subscription saved. */
export const pushSubscribedResponseSchema = z.object({ uuid: z.uuid() });
/** POST /api/push/subscriptions/remove: whether there was one to remove. */
export const pushUnsubscribedResponseSchema = z.object({ removed: z.boolean() });
/**
 * What sending to a person's devices did (POST /api/push/test, and the notification
 * scheduler's sends): delivered, failed, and removed (subscriptions the push service said are
 * gone).
 */
export const pushSendResultSchema = z.object({
  sent: z.number().int(),
  failed: z.number().int(),
  removed: z.number().int(),
});
export type PushSendResult = z.infer<typeof pushSendResultSchema>;
