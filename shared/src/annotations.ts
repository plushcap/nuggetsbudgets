import { z } from 'zod';
import { emptyAsUndefined, queryBoolean, queryEnum, queryInt, queryUuid } from './primitives.js';
import { instant, responseCount, storedValue } from './responses.js';

/**
 * Annotations — a polymorphic, self-threaded agent⇄human reasoning & discussion
 * log attached to records. A root entry (no parent) carries the
 * thread-level lifecycle; replies reference it. Phase 1 covers Transactions.
 */

/**
 * Record types an annotation can attach to. Lowercase snake_case to match the
 * existing polymorphic convention (cf. taggings.taggable_type). Phase 1 ships
 * 'transaction'.
 */
export const annotationSubjectType = z.enum([
  'transaction',
  'account',
  'merchant',
  'security',
  'budget_item',
  'budget_period_item',
  'category',
  'tag',
]);
export type AnnotationSubjectType = z.infer<typeof annotationSubjectType>;

/** What an entry represents. */
export const annotationKind = z.enum([
  'reasoning',
  'question',
  'answer',
  'observation',
  'decision',
  'flag',
  'correction',
  'note',
]);
export type AnnotationKind = z.infer<typeof annotationKind>;

/** Who authored an entry. `author_user_id` is audit-only. */
export const annotationAuthorKind = z.enum(['agent', 'user', 'system']);
export type AnnotationAuthorKind = z.infer<typeof annotationAuthorKind>;

/** Thread lifecycle (root rows only). */
const ANNOTATION_STATUS_VALUES = ['open', 'answered', 'resolved', 'dismissed', 'acknowledged'] as const;
export const annotationStatus = z.enum(ANNOTATION_STATUS_VALUES);
export type AnnotationStatus = z.infer<typeof annotationStatus>;

/** Banner severity (root rows only). */
export const annotationSeverity = z.enum(['info', 'question', 'warning', 'action_required']);
export type AnnotationSeverity = z.infer<typeof annotationSeverity>;

/** Human verdict on an agent entry (drives the learning loop). */
export const annotationFeedback = z.enum(['correct', 'incorrect']);
export type AnnotationFeedback = z.infer<typeof annotationFeedback>;

/** Whether the agent has folded an `incorrect` verdict back into its instructions. */
export const annotationLearningStatus = z.enum(['pending', 'applied', 'ignored']);
export type AnnotationLearningStatus = z.infer<typeof annotationLearningStatus>;

/**
 * Create body. Either a root (subject_type + subject_uuid) or a reply
 * (parent_uuid). Thread-level fields (notify/severity) only apply to roots.
 */
export const annotationCreateSchema = z.looseObject({
  subject_type: annotationSubjectType.optional(),
  // A uuid when given: one that isn't failed casting in the lookup, a 500.
  subject_uuid: z.uuid({ error: 'subject_uuid must be a uuid' }).optional(),
  parent_uuid: z.uuid({ error: 'parent_uuid must be a uuid' }).optional(),
  kind: annotationKind,
  body: z.string().trim().min(1, 'body is required'),
  meta: z.unknown().optional(),
  // root-only surfacing
  notify: z.boolean().optional(),
  severity: annotationSeverity.optional(),
  status: annotationStatus.optional(),
  // provenance (agent callers set these)
  author_kind: annotationAuthorKind.optional(),
  agent_name: z.string().optional(),
  agent_run_id: z.string().optional(),
});
export type AnnotationCreateInput = z.infer<typeof annotationCreateSchema>;

/** Mutable fields on PATCH (lifecycle/surfacing; body edits gated server-side). */
export const annotationUpdateSchema = z.looseObject({
  status: annotationStatus.optional(),
  notify: z.boolean().optional(),
  severity: annotationSeverity.nullable().optional(),
  pinned: z.boolean().optional(),
  feedback: annotationFeedback.nullable().optional(),
  feedback_reason: z.string().nullable().optional(),
  // learning loop (agent folds an incorrect verdict back into instructions)
  learning_status: annotationLearningStatus.nullable().optional(),
  applied_ref: z.unknown().optional(),
  body: z.string().trim().min(1).optional(),
});
export type AnnotationUpdateInput = z.infer<typeof annotationUpdateSchema>;

/**
 * Manually resolve open thread(s) from the Activity page.
 *
 * Either one thread (`uuid`) or a bulk scope:
 *   - 'all'      — every open thread
 *   - 'reviewed' — open threads whose subject transaction is already reviewed
 *
 * The server posts an `answer` reply on each thread (which moves the root to
 * `answered`, the same path a human answering by hand takes), so the resolution
 * is recorded in the timeline rather than silently flipping a status.
 */
export const annotationManualResolveSchema = z
  .object({
    uuid: z.uuid({ error: 'uuid must be the uuid of a thread' }).optional(),
    scope: z.enum(['all', 'reviewed']).optional(),
  })
  .refine((v) => (v.uuid ? !v.scope : !!v.scope), {
    message: "Provide exactly one of 'uuid' or 'scope'",
  });
export type AnnotationManualResolveInput = z.infer<typeof annotationManualResolveSchema>;

/** The most threads GET /api/annotations/threads and /inbox answer at once, and how many by default. */
const THREAD_PAGE = { min: 1, max: 200, default: 50 } as const;

/**
 * GET /api/annotations/threads query: `status` (one of the thread statuses, or `all` for
 * every one), `notify=true` for the threads that want a banner, `limit` (1 to 200, 50 when
 * not given; read as pagination reads one, never refused).
 */
export const annotationThreadsQuery = z.object({
  limit: queryInt(THREAD_PAGE),
  status: queryEnum([...ANNOTATION_STATUS_VALUES, 'all']),
  notify: queryBoolean({ default: false }),
});
export type AnnotationThreadsQuery = z.infer<typeof annotationThreadsQuery>;

/**
 * GET /api/annotations/inbox query: the cursor (`since`, the last answer's next_since, and
 * `since_uuid`, its next_since_uuid) and `limit`. Each is sent once; the cursor's own form
 * (an ISO time, a thread's uuid) is checked by the service, which answers 400
 * INVALID_CURSOR, as before.
 */
export const annotationInboxQuery = z.object({
  limit: queryInt(THREAD_PAGE),
  since: emptyAsUndefined(z.string({ error: "since must be a time, as an answer's next_since gives it" })),
  since_uuid: emptyAsUndefined(z.string({ error: 'since_uuid must be the uuid of a thread' })),
});
export type AnnotationInboxQuery = z.infer<typeof annotationInboxQuery>;

/**
 * GET /api/annotations query: the record whose timeline to answer. Its type is checked by
 * the service (a type notes aren't listed for is 400 "Unsupported subject_type"); the uuid
 * is a uuid (one that wasn't failed casting in the lookup, a 500).
 */
export const annotationTimelineQuery = z.object({
  subject_type: emptyAsUndefined(z.string({ error: 'subject_type must be sent once' })),
  subject_uuid: queryUuid({ message: 'subject_uuid must be a uuid' }),
});
export type AnnotationTimelineQuery = z.infer<typeof annotationTimelineQuery>;

// ---------------------------------------------------------------------------
// Answers. Kinds, statuses and the other words are today's values, or one an
// older row holds (the columns have no CHECK): storedValue.

const kindValue = storedValue(annotationKind.options);
const statusValue = storedValue(annotationStatus.options);
const authorKindValue = storedValue(annotationAuthorKind.options);
const severityValue = storedValue(annotationSeverity.options).nullable();
const feedbackValue = storedValue(annotationFeedback.options).nullable();
const learningStatusValue = storedValue(annotationLearningStatus.options).nullable();

/**
 * One entry of a record's timeline (GET /api/annotations): a thread's root or a reply
 * (`parent_uuid`), oldest first. `author_user_id` is audit-only; `author_first_name` is the
 * author's, for a person's entry.
 */
export const annotationResponseSchema = z.object({
  uuid: z.uuid(),
  parent_uuid: z.uuid().nullable(),
  kind: kindValue,
  body: z.string(),
  meta: z.unknown(),
  author_kind: authorKindValue,
  author_user_id: z.number().int().nullable(),
  agent_name: z.string().nullable(),
  author_first_name: z.string().nullable(),
  status: statusValue,
  notify: z.boolean(),
  severity: severityValue,
  pinned: z.boolean(),
  feedback: feedbackValue,
  feedback_reason: z.string().nullable(),
  learning_status: learningStatusValue,
  created_at: instant,
  edited: z.boolean(),
});
export type AnnotationResponse = z.infer<typeof annotationResponseSchema>;

/** GET /api/annotations: the record's timeline, with the record it is for as asked. */
export const annotationTimelineResponseSchema = z.object({
  subject_type: z.string(),
  subject_uuid: z.string(),
  annotations: z.array(annotationResponseSchema),
});
export type AnnotationTimelineResponse = z.infer<typeof annotationTimelineResponseSchema>;

/** POST /api/annotations (201): the entry written, and the record or thread it is on as sent. */
export const annotationCreatedResponseSchema = z.object({
  uuid: z.uuid(),
  subject_type: z.string(),
  kind: kindValue,
  status: statusValue,
  created_at: instant,
  subject_uuid: z.string().nullable(),
  parent_uuid: z.string().nullable(),
});
export type AnnotationCreated = z.infer<typeof annotationCreatedResponseSchema>;

/** PATCH /api/annotations/:uuid: the entry's lifecycle and surfacing as they are now. */
export const annotationUpdatedResponseSchema = z.object({
  uuid: z.uuid(),
  status: statusValue,
  notify: z.boolean(),
  severity: severityValue,
  feedback: feedbackValue,
  pinned: z.boolean(),
  edited: z.boolean(),
});
export type AnnotationUpdated = z.infer<typeof annotationUpdatedResponseSchema>;

/**
 * One thread of the Activity page (GET /api/annotations/threads): its root, newest first. A
 * transaction's thread names it (`subject_uuid`, `subject_label`), its review state and its
 * budget item; a thread on anything else has them null.
 */
export const annotationThreadResponseSchema = z.object({
  uuid: z.uuid(),
  subject_type: z.string(),
  kind: kindValue,
  body: z.string(),
  status: statusValue,
  notify: z.boolean(),
  severity: severityValue,
  author_kind: authorKindValue,
  agent_name: z.string().nullable(),
  created_at: instant,
  author_first_name: z.string().nullable(),
  subject_uuid: z.uuid().nullable(),
  subject_label: z.string().nullable(),
  subject_review_status: z.string().nullable(),
  subject_budget_item_name: z.string().nullable(),
  reply_count: responseCount,
});
export type AnnotationThread = z.infer<typeof annotationThreadResponseSchema>;

/** GET /api/annotations/threads. */
export const annotationThreadsResponseSchema = z.object({ threads: z.array(annotationThreadResponseSchema) });

/** GET /api/annotations/counts: the open threads, and how many of them want a banner. */
export const annotationCountsResponseSchema = z.object({ open: z.number().int(), notify: z.number().int() });
export type AnnotationCounts = z.infer<typeof annotationCountsResponseSchema>;

/** POST /api/annotations/manual-resolve: how many threads were resolved. */
export const annotationManualResolveResponseSchema = z.object({ resolved: z.number().int() });

/**
 * GET /api/annotations/inbox: the agent's inbox after the cursor (`since`, as read), in
 * (last_activity_at, uuid) order, and the cursor to pass back next (`next_since`,
 * `next_since_uuid`).
 */
export const annotationInboxResponseSchema = z.object({
  since: z.string(),
  inbox: z.array(
    z.object({
      uuid: z.uuid(),
      subject_type: z.string(),
      status: statusValue,
      body: z.string(),
      last_author_kind: authorKindValue,
      last_activity_at: instant,
      last_body: z.string(),
      agent_reply_count: responseCount,
      feedback: feedbackValue,
      feedback_reason: z.string().nullable(),
      learning_status: learningStatusValue,
      inbox_reason: z.enum(['feedback', 'reply']),
      subject_uuid: z.uuid().nullable(),
      subject_label: z.string().nullable(),
    })
  ),
  next_since: z.string(),
  next_since_uuid: z.string().nullable(),
});
export type AnnotationInbox = z.infer<typeof annotationInboxResponseSchema>;
