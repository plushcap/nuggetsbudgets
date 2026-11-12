import { sql } from 'kysely';
import type { AnnotationCreateInput, AnnotationManualResolveInput, AnnotationUpdateInput } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { isCalendarDate } from '../../utils/calendarDate.js';
import { manualResolutionBody } from '../../utils/annotationResolution.js';
import { isUuid } from '../../middleware/routeParams.js';
import { isReferencedType, lockSubjectsForReference } from '../transactions/locks.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { annotationAuthorKind, annotationFeedback, annotationKind, annotationStatus, transactionReviewStatus } from '@nuggets/shared';

const logger = createLogger({ service: 'AnnotationService' });

/**
 * Annotations: a polymorphic, self-threaded agent⇄human reasoning and discussion log on a
 * ledger's records. Phase 1 lists and starts threads on transactions;
 * a subject type is added by extending SUBJECT_TABLES. Every query runs on the request's
 * tenant transaction (getDb(), RLS); author_user_id is audit-only.
 */

/** An annotation request refused: answered with its status, `{ error, code, message }`. */
export class AnnotationError extends DomainError {
  constructor(status: 400 | 404 | 409, message: string, code: string = defaultErrorCode(status)) {
    super(status, code, message);
  }
}

const annotationNotFound = () => new AnnotationError(404, 'Annotation not found');
const parentNotFound = () => new AnnotationError(404, 'Parent annotation not found');
const subjectNotFound = () => new AnnotationError(404, 'Subject not found');

// subject_type -> the table whose `uuid` resolves to the subject's internal id.
const SUBJECT_TABLES: Record<string, 'transactions'> = {
  transaction: 'transactions',
};

// Agent reasoning/decisions are an append-only record; humans add follow-ups
// rather than rewrite them.
const APPEND_ONLY_KINDS = new Set(['reasoning', 'decision']);

/**
 * An ISO 8601 time both JavaScript and Postgres read alike (an inbox cursor): a day, or a
 * time with its zone (without one, JavaScript reads the process's zone and Postgres the
 * session's), and an offset Postgres takes (to ±15:59). The year is 1000 or later: V8 reads
 * '0049-06-15 12:00Z' as 2049.
 */
const ISO_TIME = /^[1-9]\d{3}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?))?$/;

async function resolveSubjectId(subjectType: string, subjectUuid: string): Promise<number | null> {
  const table = SUBJECT_TABLES[subjectType];
  if (!table) return null;
  const row = await getDb().selectFrom(table).select('id').where('uuid', '=', subjectUuid).executeTakeFirst();
  return row?.id ?? null;
}

type NoteSubject = { subject_type: string; subject_id: number };

/**
 * A note written on a record (a thread, a reply, an edit, a resolution) locks it first, in
 * id order (FOR KEY SHARE), as a tag does: a deletion under way is waited for, and
 * the record and its notes are then gone; one that starts now waits for this write and
 * sees it (Delete Transactions checks a range's notes are what its preview showed), and
 * deletes the note with its record. A transaction's, and since v2.0.0 any other subject's
 * (an account, a merchant, a budget item, …): lockSubjectsForReference. Answers the
 * `subjects` still there.
 */
async function lockNoteSubjects<T extends NoteSubject>(subjects: readonly T[]): Promise<T[]> {
  return lockSubjectsForReference(subjects);
}

/** lockNoteSubjects for one: whether its subject is still there. */
async function lockNoteSubject(subject: NoteSubject): Promise<boolean> {
  return (await lockNoteSubjects([subject])).length === 1;
}

export class AnnotationService {
  /** Tenant-wide counts for the nav badges: open threads, and how many of them want a banner. */
  async counts(): Promise<{ open: number; notify: number }> {
    const row = await getDb()
      .selectFrom('annotations')
      .where('parent_id', 'is', null)
      .where('status', '=', annotationStatus.enum.open)
      .select((eb) => [eb.fn.countAll<string>().as('open'), eb.fn.countAll<string>().filterWhere('notify', '=', true).as('notify')])
      .executeTakeFirst();
    return { open: Number(row?.open ?? 0), notify: Number(row?.notify ?? 0) };
  }

  /**
   * The cross-record inbox of thread roots, newest first, for the Activity page: `status`
   * (all of them when absent or 'all'), only those that want a banner with `notifyOnly`.
   * Phase 1 resolves the 'transaction' subject for linking and labelling.
   */
  threads({ limit, status, notifyOnly }: { limit: number; status?: string | undefined; notifyOnly: boolean }) {
    let query = getDb()
      .selectFrom('annotations as a')
      .leftJoin('transactions as t', (join) =>
        join.onRef('t.id', '=', 'a.subject_id').on('a.subject_type', '=', 'transaction'))
      .leftJoin('users as u', 'u.id', 'a.author_user_id')
      .leftJoin('budget_items as bi', 'bi.id', 't.budget_item_id')
      .select([
        'a.uuid',
        'a.subject_type',
        'a.kind',
        'a.body',
        'a.status',
        'a.notify',
        'a.severity',
        'a.author_kind',
        'a.agent_name',
        'a.created_at',
        'u.first_name as author_first_name',
        't.uuid as subject_uuid',
        't.description as subject_label',
        // Review state of the subject transaction, so the Activity page can show
        // it per row and offer "resolve everything already reviewed".
        't.review_status as subject_review_status',
        'bi.name as subject_budget_item_name',
        sql<number>`(SELECT COUNT(*) FROM annotations c WHERE c.root_id = a.id)`.as('reply_count'),
      ])
      .where('a.parent_id', 'is', null)
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc')
      .limit(limit);

    if (status && status !== 'all') query = query.where('a.status', '=', status);
    if (notifyOnly) query = query.where('a.notify', '=', true);
    return query.execute();
  }

  /**
   * The agent's inbox: open or answered threads whose latest activity is a human's (so the
   * agent's own replies don't bring them back), oldest-waiting first, and the threads with
   * feedback the agent hasn't applied yet. Polled with a cursor, for idempotent,
   * no-double-reply polling: the threads come in (last_activity_at, uuid) order,
   * last_activity_at to the millisecond as the answer shows it, and the cursor is the last
   * one the agent processed, the answer's next_since and next_since_uuid, which it passes
   * back as `since` and `sinceUuid`. Only the threads after it are answered: with
   * last_activity_at alone, a page that ended inside a run of threads sharing one timestamp
   * skipped the rest of them, and the microseconds the answer leaves out brought the last
   * thread back. `since` alone is the old cursor and works as it did: threads whose activity
   * is later than it.
   */
  async inbox({ limit, since: sentSince, sinceUuid: sentSinceUuid }: { limit: number; since?: string | undefined; sinceUuid?: string | undefined }) {
    const since = sentSince || '1970-01-01T00:00:00Z';
    // Lowercase, as the answer's uuids are: compared as text below.
    const sinceUuid = sentSinceUuid ? sentSinceUuid.toLowerCase() : null;
    // A time JavaScript can't read ('today', which Postgres reads) let the cursor move back,
    // and one neither reads was a 500: the cursor is the ISO time an answer gave.
    if (!ISO_TIME.test(since) || !isCalendarDate(since.slice(0, 10)) || Number.isNaN(Date.parse(since))) {
      throw new AnnotationError(400, "since must be a time, as an answer's next_since gives it", 'INVALID_CURSOR');
    }
    if (sinceUuid !== null && !isUuid(sinceUuid)) {
      throw new AnnotationError(400, 'since_uuid must be the uuid of a thread', 'INVALID_CURSOR');
    }
    // The order and the cursor are on the activity's millisecond, as the answer shows it.
    const activity = sql`date_trunc('milliseconds', tl.last_activity_at, 'UTC')`;
    const after =
      sinceUuid === null
        ? sql`tl.last_activity_at > ${since}::timestamptz`
        : sql`(${activity}, tl.uuid) > (date_trunc('milliseconds', ${since}::timestamptz, 'UTC'), ${sinceUuid}::uuid)`;

    const result = await sql<{
      uuid: string;
      subject_type: string;
      subject_uuid: string | null;
      subject_label: string | null;
      status: string;
      body: string;
      last_activity_at: string;
      last_author_kind: string;
      last_body: string;
      agent_reply_count: number;
      feedback: string | null;
      feedback_reason: string | null;
      learning_status: string | null;
      inbox_reason: string;
    }>`
      WITH thread_latest AS (
        SELECT r.id AS root_id, r.uuid, r.subject_type, r.subject_id, r.status, r.body,
               r.feedback, r.feedback_reason, r.learning_status,
               m.author_kind AS last_author_kind, m.created_at AS last_activity_at, m.body AS last_body,
               (SELECT COUNT(*) FROM annotations a
                  WHERE (a.id = r.id OR a.root_id = r.id) AND a.author_kind = 'agent') AS agent_reply_count
        FROM annotations r
        JOIN LATERAL (
          SELECT author_kind, created_at, body
          FROM annotations x
          WHERE x.id = r.id OR x.root_id = r.id
          ORDER BY x.created_at DESC, x.id DESC
          LIMIT 1
        ) m ON TRUE
        WHERE r.parent_id IS NULL
      )
      SELECT tl.uuid, tl.subject_type, tl.status, tl.body,
             tl.last_author_kind, tl.last_activity_at, tl.last_body, tl.agent_reply_count,
             tl.feedback, tl.feedback_reason, tl.learning_status,
             CASE WHEN tl.learning_status = 'pending' THEN 'feedback' ELSE 'reply' END AS inbox_reason,
             t.uuid AS subject_uuid, t.description AS subject_label
      FROM thread_latest tl
      LEFT JOIN transactions t ON tl.subject_type = 'transaction' AND t.id = tl.subject_id
      WHERE
        -- a human replied to an open/answered thread since the cursor, OR
        (tl.last_author_kind = 'user' AND tl.status IN ('open', 'answered') AND ${after})
        -- a human flagged a decision incorrect and the agent hasn't applied it yet
        OR tl.learning_status = 'pending'
      ORDER BY ${activity} ASC, tl.uuid ASC
      LIMIT ${limit}
    `.execute(getDb());

    // The cursor after this answer: its last thread, unless that one comes before the
    // cursor given (a feedback thread is answered whatever the cursor), which then stays.
    const last = result.rows[result.rows.length - 1];
    const lastAt = last ? new Date(last.last_activity_at) : null;
    const sinceAt = new Date(since);
    const moves =
      lastAt !== null &&
      (lastAt.getTime() > sinceAt.getTime() ||
        (lastAt.getTime() === sinceAt.getTime() && (sinceUuid === null || last!.uuid > sinceUuid)));
    return {
      since,
      inbox: result.rows,
      next_since: moves ? lastAt!.toISOString() : since,
      next_since_uuid: moves ? last!.uuid : sinceUuid,
    };
  }

  /** The threaded timeline of one record, oldest first. */
  async timeline(subjectType: string | undefined, subjectUuid: string | undefined) {
    if (!subjectType || !SUBJECT_TABLES[subjectType]) throw new AnnotationError(400, `Unsupported subject_type: ${subjectType ?? ''}`);
    if (!subjectUuid) throw new AnnotationError(400, 'subject_uuid is required');
    const subjectId = await resolveSubjectId(subjectType, subjectUuid);
    if (subjectId === null) throw subjectNotFound();

    const annotations = await getDb()
      .selectFrom('annotations as a')
      .leftJoin('annotations as p', 'p.id', 'a.parent_id')
      .leftJoin('users as u', 'u.id', 'a.author_user_id')
      .select([
        'a.uuid',
        'p.uuid as parent_uuid',
        'a.kind',
        'a.body',
        'a.meta',
        'a.author_kind',
        'a.author_user_id',
        'a.agent_name',
        'u.first_name as author_first_name',
        'a.status',
        'a.notify',
        'a.severity',
        'a.pinned',
        'a.feedback',
        'a.feedback_reason',
        'a.learning_status',
        'a.created_at',
        'a.edited',
      ])
      .where('a.subject_type', '=', subjectType)
      .where('a.subject_id', '=', subjectId)
      .orderBy('a.created_at', 'asc')
      .orderBy('a.id', 'asc')
      .execute();
    return { subject_type: subjectType, subject_uuid: subjectUuid, annotations };
  }

  /** A root annotation (subject_type + subject_uuid) or a reply (parent_uuid), written by `userId` unless an agent's. */
  async create(input: AnnotationCreateInput, userId: number) {
    const {
      subject_type, subject_uuid, parent_uuid, kind, body, meta,
      notify, severity, status, author_kind, agent_name, agent_run_id,
    } = input;

    let parentId: number | null = null;
    let threadRootId: number | null = null;
    let resolvedSubjectType: string;
    let resolvedSubjectId: number;

    if (parent_uuid) {
      // Reply: inherit subject from the parent; thread-level fields stay unset.
      const parent = await getDb()
        .selectFrom('annotations')
        .select(['id', 'root_id', 'subject_type', 'subject_id'])
        .where('uuid', '=', parent_uuid)
        .executeTakeFirst();
      if (!parent) throw parentNotFound();
      // A thread on a subject type notes aren't written on any more (a legacy value the row
      // kept) takes no reply: the database refuses a new note of that type, which answered
      // a 500. It can still be resolved or dismissed.
      if (!isReferencedType(parent.subject_type)) {
        throw new AnnotationError(
          409,
          "This thread is on a kind of record notes aren't written on any more, so it can't take a reply. Resolve or dismiss it instead.",
          'SUBJECT_TYPE_RETIRED'
        );
      }
      // Its transaction deleted meanwhile took the thread with it.
      if (!(await lockNoteSubject(parent))) throw parentNotFound();
      parentId = parent.id;
      threadRootId = parent.root_id ?? parent.id;
      resolvedSubjectType = parent.subject_type;
      resolvedSubjectId = parent.subject_id;
    } else {
      // Root: requires a supported subject.
      if (!subject_type || !SUBJECT_TABLES[subject_type]) {
        throw new AnnotationError(400, `Unsupported or missing subject_type: ${subject_type}`);
      }
      if (!subject_uuid) throw new AnnotationError(400, 'subject_uuid is required for a new thread');
      const subjectId = await resolveSubjectId(subject_type, subject_uuid);
      // Locked as a reply locks it: one deleted meanwhile isn't found.
      if (subjectId === null || !(await lockNoteSubject({ subject_type, subject_id: subjectId }))) throw subjectNotFound();
      resolvedSubjectType = subject_type;
      resolvedSubjectId = subjectId;
    }

    const isAgent = author_kind === annotationAuthorKind.enum.agent;
    const isReply = parentId !== null;

    const inserted = await getDb()
      .insertInto('annotations')
      .values({
        subject_type: resolvedSubjectType,
        subject_id: resolvedSubjectId,
        parent_id: parentId,
        author_kind: isAgent ? 'agent' : author_kind === annotationAuthorKind.enum.system ? 'system' : 'user',
        author_user_id: isAgent ? null : userId,
        agent_name: isAgent ? (agent_name ?? null) : null,
        agent_run_id: isAgent ? (agent_run_id ?? null) : null,
        kind,
        body,
        meta: meta === undefined ? null : sql`${JSON.stringify(meta)}::jsonb`,
        // Thread-level fields apply to roots only (the CHECK enforces this).
        status: isReply ? 'open' : (status ?? 'open'),
        notify: isReply ? false : (notify ?? false),
        severity: isReply ? null : (severity ?? null),
      })
      .returning(['uuid', 'subject_type', 'kind', 'status', 'created_at'])
      .executeTakeFirstOrThrow();

    // A human answering an open thread moves it to 'answered' so it surfaces in
    // the agent's inbox for follow-up (the agent's own replies don't).
    if (isReply && !isAgent && kind === annotationKind.enum.answer && threadRootId !== null) {
      await getDb()
        .updateTable('annotations')
        .set({ status: 'answered' })
        .where('id', '=', threadRootId)
        .where('status', '=', annotationStatus.enum.open)
        .execute();
    }

    logger.info({ uuid: inserted.uuid, subjectType: resolvedSubjectType, kind, isReply }, 'Annotation created');
    return { ...inserted, subject_uuid: subject_uuid ?? null, parent_uuid: parent_uuid ?? null };
  }

  /**
   * Resolves open thread(s) by hand, from the Activity page: one (`uuid`), or a bulk
   * `scope` ('all', or 'reviewed': those on a transaction already reviewed). "Manually
   * resolved" means what a human doing it by hand means: an `answer` reply stating what
   * happened, which moves the root from 'open' to 'answered', so the resolution shows in
   * the thread's timeline and the agent inbox works as before. A bulk scope touches only
   * open roots, so running it again is a no-op rather than another answer on settled
   * threads. Answers how many were resolved.
   */
  async manualResolve({ uuid, scope }: AnnotationManualResolveInput, userId: number): Promise<number> {
    let targets = getDb()
      .selectFrom('annotations as a')
      .leftJoin('transactions as t', (join) =>
        join.onRef('t.id', '=', 'a.subject_id').on('a.subject_type', '=', 'transaction'))
      .leftJoin('budget_items as bi', 'bi.id', 't.budget_item_id')
      .select([
        'a.id',
        'a.uuid',
        'a.subject_type',
        'a.subject_id',
        'bi.name as budget_item_name',
      ])
      .where('a.parent_id', 'is', null)
      .where('a.status', '=', annotationStatus.enum.open);

    if (uuid) {
      targets = targets.where('a.uuid', '=', uuid);
    } else if (scope === 'reviewed') {
      // Only threads hanging off a transaction that has already been reviewed.
      targets = targets.where('t.review_status', '=', transactionReviewStatus.enum.reviewed);
    }

    // Their transactions locked first, in id order; a thread whose transaction was deleted
    // meanwhile went with it.
    const rows = await lockNoteSubjects(await targets.execute());

    // Either it doesn't exist or it isn't open: both are "nothing to do", but the caller
    // is told rather than answered a silent success.
    if (uuid && rows.length === 0) throw new AnnotationError(404, 'No open annotation thread with that uuid');

    for (const row of rows) {
      // A thread on a subject type notes aren't written on any more (a legacy value the
      // row kept) can't take the answer: the database refuses a new note of that type,
      // which failed the whole resolve with a 500. It is resolved without one.
      if (isReferencedType(row.subject_type)) {
        await getDb()
          .insertInto('annotations')
          .values({
            subject_type: row.subject_type,
            subject_id: row.subject_id,
            parent_id: row.id,
            author_kind: 'user',
            author_user_id: userId,
            kind: 'answer',
            body: manualResolutionBody(row.budget_item_name),
            // Thread-level fields belong to the root only (enforced by CHECK).
            status: 'open',
            notify: false,
            severity: null,
          })
          .execute();
      }

      await getDb()
        .updateTable('annotations')
        .set({ status: 'answered', resolved_at: sql`NOW()`, resolved_by_user_id: userId })
        .where('id', '=', row.id)
        .where('status', '=', annotationStatus.enum.open)
        .execute();
    }
    return rows.length;
  }

  /** Changes an annotation's lifecycle and surfacing, and its body (except an agent's append-only entry). */
  async update(uuid: string, input: AnnotationUpdateInput, userId: number) {
    const current = await getDb()
      .selectFrom('annotations')
      .select(['id', 'kind', 'author_kind', 'parent_id', 'subject_type', 'subject_id'])
      .where('uuid', '=', uuid)
      .executeTakeFirst();
    // A note whose transaction was deleted meanwhile went with it.
    if (!current || !(await lockNoteSubject(current))) throw annotationNotFound();

    const { status, notify, severity, pinned, feedback, feedback_reason, learning_status, applied_ref, body } = input;
    const isReply = current.parent_id !== null;
    const updates: Record<string, unknown> = {};

    if (body !== undefined) {
      if (current.author_kind === annotationAuthorKind.enum.agent && APPEND_ONLY_KINDS.has(current.kind)) {
        throw new AnnotationError(400, 'Agent reasoning/decision entries are append-only and cannot be edited');
      }
      updates.body = body;
      updates.edited = true;
    }
    if (pinned !== undefined) updates.pinned = pinned;

    // Thread-level fields only apply to root rows (the CHECK constraint enforces it).
    if (!isReply) {
      if (notify !== undefined) updates.notify = notify;
      if (severity !== undefined) updates.severity = severity;
      if (feedback !== undefined) updates.feedback = feedback;
      if (feedback_reason !== undefined) updates.feedback_reason = feedback_reason;
      // A new 'incorrect' verdict queues the learning loop; the agent later sets
      // learning_status='applied' + applied_ref once it updates its instructions.
      if (feedback === annotationFeedback.enum.incorrect && learning_status === undefined) updates.learning_status = 'pending';
      if (learning_status !== undefined) updates.learning_status = learning_status;
      if (applied_ref !== undefined) {
        updates.applied_ref = applied_ref === null ? null : sql`${JSON.stringify(applied_ref)}::jsonb`;
      }
      if (status !== undefined) {
        updates.status = status;
        if (status === annotationStatus.enum.resolved) {
          updates.resolved_at = sql`NOW()`;
          updates.resolved_by_user_id = userId;
        } else {
          // Reopening (or any non-resolved transition) clears the resolution stamp.
          updates.resolved_at = null;
          updates.resolved_by_user_id = null;
        }
      }
    }

    if (Object.keys(updates).length === 0) throw new AnnotationError(400, 'No updatable fields supplied');

    return getDb()
      .updateTable('annotations')
      .set(updates)
      .where('id', '=', current.id)
      .returning(['uuid', 'status', 'notify', 'severity', 'feedback', 'pinned', 'edited'])
      .executeTakeFirstOrThrow();
  }
}
