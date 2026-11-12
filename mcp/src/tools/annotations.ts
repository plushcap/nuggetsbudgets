import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ANNOTATION_FEEDBACK,
  ANNOTATION_KINDS,
  ANNOTATION_SEVERITIES,
  ANNOTATION_SUBJECT_TYPES,
  annotationInboxQuery,
  annotationTimelineQuery,
  queryString,
} from '@nuggets/shared';
import { apiPath } from '../client.js';
import { registerTool, type ToolContext } from './helpers.js';

/**
 * Annotations — the agent's reasoning & discussion log on records.
 * Use these to explain *why* you flagged something, ask the human a question,
 * or record a decision. Entries are threaded per record and surface on the
 * record's page in Nuggets. Phase 1 supports subject type 'transaction'.
 */
const SUBJECT_TYPES = z.enum(ANNOTATION_SUBJECT_TYPES).extract(['transaction']);
const KINDS = ANNOTATION_KINDS;
const SEVERITIES = ANNOTATION_SEVERITIES;

export function registerAnnotationTools(server: McpServer, ctx: ToolContext): void {
  registerTool(server, ctx, {
    name: 'list_annotations',
    title: 'List annotations on a record',
    description:
      "Return the threaded annotation timeline for a record (the agent⇄human reasoning/discussion log). " +
      "Phase 1: subjectType 'transaction'. Read this before flagging to avoid duplicate threads.",
    inputSchema: {
      subjectType: SUBJECT_TYPES.describe("The record type. Phase 1: 'transaction'."),
      subjectUuid: z.string().uuid().describe('Public uuid of the record.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/annotations', queryString(annotationTimelineQuery, { subject_type: args.subjectType, subject_uuid: args.subjectUuid })),
  });

  registerTool(server, ctx, {
    name: 'create_annotation',
    title: 'Add an annotation to a record',
    description:
      'Record reasoning, ask a question, or log a decision on a record — this is how you explain *why* you ' +
      'flagged a transaction for review and what you need from the human. Create a thread root with ' +
      'subjectType + subjectUuid, or reply within a thread with parentUuid. Set notify=true (and ' +
      "severity='action_required') on a question that should surface as a banner on the record's page. " +
      'Put structured context (confidence, candidate budget items, rule hits) in `meta`.',
    inputSchema: {
      subjectType: SUBJECT_TYPES.optional().describe("Record type for a new thread (Phase 1: 'transaction')."),
      subjectUuid: z.string().uuid().optional().describe('Public uuid of the record (required for a new thread).'),
      parentUuid: z.string().uuid().optional().describe('Reply within an existing thread (omit subjectType/subjectUuid).'),
      kind: z
        .enum(KINDS)
        .describe("Entry type: 'reasoning' (why), 'question' (need an answer), 'decision', 'observation', 'flag', 'correction', 'note', 'answer'."),
      body: z.string().min(1).describe('The message (markdown). Be specific about the question or reasoning.'),
      notify: z.boolean().optional().describe('Surface as a banner at the top of the record (root entries only).'),
      severity: z.enum(SEVERITIES).optional().describe('Banner severity for a notify entry (root entries only).'),
      meta: z.record(z.string(), z.unknown()).optional().describe('Structured context, e.g. {confidence:0.62, candidates:[...]}.'),
      agentName: z.string().optional().describe('Identify the agent producing this entry.'),
      agentRunId: z.string().optional().describe('Correlate to a scheduled run (idempotency/traceability).'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const annotationBody: Record<string, unknown> = {
        kind: args.kind,
        body: args.body,
        author_kind: 'agent',
      };
      if (args.subjectType !== undefined) annotationBody.subject_type = args.subjectType;
      if (args.subjectUuid !== undefined) annotationBody.subject_uuid = args.subjectUuid;
      if (args.parentUuid !== undefined) annotationBody.parent_uuid = args.parentUuid;
      if (args.notify !== undefined) annotationBody.notify = args.notify;
      if (args.severity !== undefined) annotationBody.severity = args.severity;
      if (args.meta !== undefined) annotationBody.meta = args.meta;
      if (args.agentName !== undefined) annotationBody.agent_name = args.agentName;
      if (args.agentRunId !== undefined) annotationBody.agent_run_id = args.agentRunId;
      return client.post('/api/annotations', annotationBody);
    },
  });

  registerTool(server, ctx, {
    name: 'get_annotation_inbox',
    title: 'Get the agent annotation inbox',
    description:
      'Return open/answered threads whose latest activity is from a human (your own replies do not re-surface), ' +
      'oldest-waiting first — your queue of questions to answer and feedback to act on. Poll this on a schedule. ' +
      'For idempotent polling, so you never double-reply or miss a thread, pass back the cursor of the last answer: ' +
      'its `next_since` as `since` and its `next_since_uuid` as `sinceUuid`. Resolve a thread (resolve_annotation) ' +
      'or reply (reply_annotation) once handled.',
    inputSchema: {
      // nullish: an answer with no threads gives next_since_uuid null, and a model passes it back.
      since: z.string().nullish().describe("ISO-8601 cursor: the last answer's next_since. Only threads after it are returned."),
      sinceUuid: z
        .string()
        .uuid()
        .nullish()
        .describe("The last answer's next_since_uuid: with `since`, the thread the cursor is at, so threads sharing its timestamp aren't skipped."),
      limit: z.coerce.number().int().min(1).max(200).optional().describe('Max threads (default 50).'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get(
        '/api/annotations/inbox',
        queryString(annotationInboxQuery, { since: args.since ?? undefined, since_uuid: args.sinceUuid ?? undefined, limit: args.limit })
      ),
  });

  registerTool(server, ctx, {
    name: 'reply_annotation',
    title: 'Reply within an annotation thread',
    description:
      'Post a reply in an existing thread (e.g. answer the human, or record a decision). Use after acting on an ' +
      'inbox item. To also close the thread, call resolve_annotation.',
    inputSchema: {
      parentUuid: z.string().uuid().describe('uuid of the thread root (or any entry) you are replying to.'),
      kind: z.enum(KINDS).describe("Usually 'decision' or 'answer'."),
      body: z.string().min(1).describe('The reply (markdown).'),
      meta: z.record(z.string(), z.unknown()).optional().describe('Structured context for the reply.'),
      agentName: z.string().optional(),
      agentRunId: z.string().optional().describe('Correlate to a scheduled run (idempotency/traceability).'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const replyBody: Record<string, unknown> = {
        parent_uuid: args.parentUuid,
        kind: args.kind,
        body: args.body,
        author_kind: 'agent',
      };
      if (args.meta !== undefined) replyBody.meta = args.meta;
      if (args.agentName !== undefined) replyBody.agent_name = args.agentName;
      if (args.agentRunId !== undefined) replyBody.agent_run_id = args.agentRunId;
      return client.post('/api/annotations', replyBody);
    },
  });

  registerTool(server, ctx, {
    name: 'resolve_annotation',
    title: 'Resolve an annotation thread',
    description:
      'Close a thread once handled (status -> resolved). Optionally include a closing note, which is posted as a ' +
      "'decision' reply before resolving. Resolved threads stop appearing in the inbox.",
    inputSchema: {
      uuid: z.string().uuid().describe('uuid of the thread root to resolve.'),
      note: z.string().optional().describe('Optional closing note, posted as a decision reply.'),
      agentRunId: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      if (args.note) {
        const noteBody: Record<string, unknown> = {
          parent_uuid: args.uuid,
          kind: 'decision',
          body: args.note,
          author_kind: 'agent',
        };
        if (args.agentRunId !== undefined) noteBody.agent_run_id = args.agentRunId;
        await client.post('/api/annotations', noteBody);
      }
      return client.patch(apiPath`/api/annotations/${args.uuid}`, { status: 'resolved' });
    },
  });

  registerTool(server, ctx, {
    name: 'set_annotation_feedback',
    title: 'Record feedback on an annotation thread',
    description:
      "Mark a thread's decision 'correct' or 'incorrect' (with a reason). An 'incorrect' verdict queues the " +
      'learning loop (it appears in the inbox as a feedback item). Usually set by a human, but available so the ' +
      'agent can record self-assessment.',
    inputSchema: {
      uuid: z.string().uuid().describe('uuid of the thread root.'),
      feedback: z.enum(ANNOTATION_FEEDBACK).describe("Verdict on the agent's decision."),
      reason: z.string().optional().describe('Why — especially important for an incorrect verdict.'),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = { feedback: args.feedback };
      if (args.reason !== undefined) body.feedback_reason = args.reason;
      return client.patch(apiPath`/api/annotations/${args.uuid}`, body);
    },
  });

  registerTool(server, ctx, {
    name: 'apply_annotation_learning',
    title: 'Apply learning from incorrect feedback',
    description:
      'After acting on an incorrect verdict — typically by revising a budget item’s `instructions` via ' +
      'update_budget_item — call this to close the loop: it optionally logs a `correction` reply (the note), ' +
      'records what you changed in `appliedRef`, and sets learning_status=applied so the thread leaves the inbox.',
    inputSchema: {
      uuid: z.string().uuid().describe('uuid of the thread root that had incorrect feedback.'),
      note: z.string().optional().describe('What you changed and why; posted as a correction reply.'),
      appliedRef: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("What was changed, e.g. {type:'budget_item', uuid:'…', field:'instructions'}."),
      agentRunId: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      if (args.note) {
        const noteBody: Record<string, unknown> = {
          parent_uuid: args.uuid,
          kind: 'correction',
          body: args.note,
          author_kind: 'agent',
        };
        if (args.appliedRef !== undefined) noteBody.meta = args.appliedRef;
        if (args.agentRunId !== undefined) noteBody.agent_run_id = args.agentRunId;
        await client.post('/api/annotations', noteBody);
      }
      const patch: Record<string, unknown> = { learning_status: 'applied' };
      if (args.appliedRef !== undefined) patch.applied_ref = args.appliedRef;
      return client.patch(apiPath`/api/annotations/${args.uuid}`, patch);
    },
  });
}
