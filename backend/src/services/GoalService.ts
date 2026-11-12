import { sql, type RawBuilder } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { accountBalanceService } from './AccountBalanceService.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { DomainError } from './domainErrors.js';
import { isLockConflict } from './transactions/locks.js';
import { firstMissingReference, missingReferenceError, type TenantReferenceField } from './tenantReferences.js';
import { deleteImageByUrl, imageUrl, storeImage } from './ImageService.js';
import { appToday } from '../utils/appDate.js';
import { addMonths, daysBetween, firstOfMonth, lastOfMonth, yearMonthOf } from '../utils/calendarDate.js';
import { centsToAmount, centsToNumber, invalidAmountAnswer, numericToCents, readCents } from '../utils/money.js';
import { CALENDAR_DAY_YEARS, type GOAL_HISTORY_PERIODS, type GoalCreateInput, type GoalUpdateInput, budgetItemStatus, budgetExpenseType } from '@nuggets/shared';
import { oneRow } from '../utils/present.js';

/** The average length of a month in days (365.25 / 12). */
const DAYS_PER_MONTH = 30.4375;

/**
 * A goal refusal: a goal that isn't there (or is another ledger's, which RLS
 * hides), an amount its NUMERIC(12,2) column can't hold, no image to delete. Thrown by
 * GoalService and answered by the route wrapper, which rolls back what was written.
 */
export class GoalError extends DomainError {}

/** A numeric id that names no row of this ledger: 400 INVALID_REFERENCE, naming the field. */
async function refuseMissingReference(field: Extract<TenantReferenceField, 'account_id' | 'budget_item_id'>, id: number): Promise<void> {
    if (await firstMissingReference({ [field]: id })) {
        const { error, code } = missingReferenceError(field);
        throw new GoalError(400, code, error, { field });
    }
}

/** No such goal in this ledger: 404. */
const goalNotFound = (): GoalError => new GoalError(404, 'NOT_FOUND', 'Goal not found');

/** The columns a goal answers with, under the names the goal routes use. */
const GOAL_COLUMNS = [
    'id',
    'uuid',
    'name',
    'description',
    'goal_target_amount as target_amount',
    'goal_target_date as target_date',
    'default_budget_amount as estimated_monthly_contribution',
    'image_path',
    'status',
    'created_at',
    'updated_at',
] as const;

/**
 * A goal's amount from the body (goalCreateSchema's moneyInput: a number or decimal text,
 * as sent) as exact text for its NUMERIC(12,2) column, null when not given; more than 2
 * decimals or more than the column holds is a 400 INVALID_AMOUNT.
 */
function goalAmount(value: number | string | null | undefined, field: string): string | null {
    if (value == null) return null;
    const read = readCents(value);
    if ('cents' in read) return centsToAmount(read.cents);
    const answer = invalidAmountAnswer(field, read.problem);
    throw new GoalError(400, answer.code, answer.error);
}

/** The step a goal's balance history is drawn at, as a constant make_interval() fragment. */
const HISTORY_STEP: Record<(typeof GOAL_HISTORY_PERIODS)[number], RawBuilder<unknown>> = {
    day: sql`make_interval(days => 1)`,
    week: sql`make_interval(weeks => 1)`,
    month: sql`make_interval(months => 1)`,
    year: sql`make_interval(years => 1)`,
};

/** The dates a goal's balance history is drawn at: `limit` steps of `period` back from today, and today (at most ten years of days). */
function historyDates(range: GoalBalanceHistoryRange): RawBuilder<unknown> {
    const step = HISTORY_STEP[range.period];
    return sql`
        SELECT g.d::DATE AS date_point, g.n
          FROM generate_series(app_today() - (${range.limit} * ${step}), app_today(), ${step}) WITH ORDINALITY AS g(d, n)`;
}

/** How far back a goal's balance history goes: `limit` steps of `period` (goalBalanceHistoryQuery). */
export interface GoalBalanceHistoryRange {
    limit: number;
    period: (typeof GOAL_HISTORY_PERIODS)[number];
}

/**
 * The longest progress history one request may ask for: ten years of month ends.
 * A longer range is refused; with no start date, the goal's life is cut to its latest ten
 * years.
 */
export const PROGRESS_HISTORY_MAX_MONTHS = 120;

/**
 * A goal's progress on one day, computed from the balances when it is read and
 * never stored. The amounts are decimal text with two places, as the NUMERIC columns of
 * the retired goal_progress_history table answered them.
 */
export interface GoalProgressPoint {
    /** The calendar day ('YYYY-MM-DD') the progress is taken at the end of. */
    snapshot_date: string;
    total_from_accounts: string;
    total_from_budget_items: string;
    total_progress: string;
}

/**
 * `today` moved by `months`, or null past the last year a calendar date may be in
 * (CALENDAR_DAY_YEARS): a goal saving a cent a month toward a million would be met in the
 * year 8 million, which a Date can't hold (a RangeError: the goals list answered 500), and a
 * year past 9999 isn't a 'YYYY-MM-DD' date at all.
 */
function projectedDay(today: string, months: number): string | null {
    const { year, month } = yearMonthOf(today);
    if (!Number.isFinite(months) || year + Math.floor((month - 1 + months) / 12) > CALENDAR_DAY_YEARS.max) return null;
    return addMonths(today, months);
}

/** Months since year 0 of a calendar date's month: whole-month arithmetic without a Date. */
function monthIndex(day: string): number {
    const { year, month } = yearMonthOf(day);
    return year * 12 + month - 1;
}

/**
 * The days a goal's progress history is drawn at, ascending: each month end from `start`
 * to `end`, none after `today` (it is history, not a forecast), and `today` itself when
 * it falls in the range. Calendar dates ('YYYY-MM-DD'), compared as text.
 */
export function progressHistoryDates(start: string, end: string, today: string): string[] {
    const last = end < today ? end : today;
    const dates: string[] = [];
    for (let monthEnd = lastOfMonth(start); monthEnd <= last; monthEnd = lastOfMonth(addMonths(firstOfMonth(monthEnd), 1))) {
        dates.push(monthEnd);
    }
    if (start <= today && today <= end && dates[dates.length - 1] !== today) dates.push(today);
    return dates;
}

/**
 * A goal's two kinds of link: its accounts and its envelopes, each a table of
 * ranges of days. A link is in effect on day d when `valid_from <= d AND (valid_to IS NULL
 * OR d < valid_to)`. At most one per goal and account (or envelope) is open (`valid_to IS
 * NULL`, a unique index); the closed ones are written only here, under the goal's lock.
 *
 * Today is the ledger's (app_today()), so a change of its time zone can move today back a
 * day or two, before the first day of a link made or the last day of one closed under the
 * old zone. Linking again then goes on with that link rather than open one beside it, and
 * unlinking one whose first day is after today deletes it, as one made today is.
 */
const LINKS = {
    account: { table: 'budget_item_accounts', goal: 'budget_item_id', linked: 'account_id' },
    envelope: { table: 'goal_budget_items', goal: 'goal_id', linked: 'budget_item_id' },
} as const;
type LinkKind = keyof typeof LINKS;

/** Another change held a goal's or an envelope's row past the lock timeout, or deadlocked with this one: try again. */
const goalBusy = (): GoalError =>
    new GoalError(409, 'RECORD_BUSY', 'Another change to this goal or its budget items was being saved at the same time, so nothing was changed. Try again.');

/**
 * Lock the goal's row before changing its links, so two changes of one goal's links run
 * one after the other, each reading the ranges the other wrote. Raw: a lock timeout or a
 * deadlock is the caller's to answer (a merge answers its own 409).
 */
async function lockGoalRow(goalId: number): Promise<void> {
    await getDb().selectFrom('budget_items').select('id').where('id', '=', goalId).forNoKeyUpdate().execute();
}

/** {@link lockGoalRow}, a lock timeout or a deadlock answered as a 409 RECORD_BUSY (not a 500). */
async function lockGoal(goalId: number): Promise<void> {
    try {
        await lockGoalRow(goalId);
    } catch (err) {
        if (!isLockConflict(err)) throw err;
        throw goalBusy();
    }
}

/**
 * Link `linkedId` to the goal from the ledger's today (valid_from's default, app_today()).
 * Nothing changes when it is linked now. A link that ends today or later goes on (the
 * latest such one): it was in effect up to today, so a new range would meet or overlap it.
 * Returns the open link's id.
 */
async function openLink(kind: LinkKind, goalId: number, linkedId: number): Promise<number> {
    const { table, goal, linked } = LINKS[kind];
    await lockGoal(goalId);
    const pair = sql`${sql.ref(goal)} = ${goalId} AND ${sql.ref(linked)} = ${linkedId}`;
    const open = await sql<{ id: number }>`
        SELECT id FROM ${sql.table(table)} WHERE ${pair} AND valid_to IS NULL
    `.execute(getDb());
    if (open.rows[0]) return open.rows[0].id;
    const reopened = await sql<{ id: number }>`
        UPDATE ${sql.table(table)} SET valid_to = NULL
         WHERE id = (SELECT id FROM ${sql.table(table)}
                      WHERE ${pair} AND valid_to >= app_today()
                      ORDER BY valid_from DESC, id DESC LIMIT 1)
        RETURNING id
    `.execute(getDb());
    if (reopened.rows[0]) return reopened.rows[0].id;
    const added = await sql<{ id: number }>`
        INSERT INTO ${sql.table(table)} (${sql.ref(goal)}, ${sql.ref(linked)}) VALUES (${goalId}, ${linkedId}) RETURNING id
    `.execute(getDb());
    return oneRow(added.rows, 'INSERT … RETURNING id').id;
}

/**
 * Unlink `linkedId` from the goal from the ledger's today: its open link ends today, so it
 * counts up to the end of yesterday. One made today (or on a later day, under a time zone
 * that has moved today back) is deleted instead: it counted at the end of no day before
 * today. Nothing happens when it isn't linked now.
 */
async function closeLink(kind: LinkKind, goalId: number, linkedId: number): Promise<void> {
    const { table, goal, linked } = LINKS[kind];
    await lockGoal(goalId);
    const pair = sql`${sql.ref(goal)} = ${goalId} AND ${sql.ref(linked)} = ${linkedId}`;
    await sql`
        DELETE FROM ${sql.table(table)} WHERE ${pair} AND valid_to IS NULL AND valid_from >= app_today()
    `.execute(getDb());
    await sql`
        UPDATE ${sql.table(table)} SET valid_to = app_today() WHERE ${pair} AND valid_to IS NULL
    `.execute(getDb());
}

/** A range of days a link is in effect: valid_from, up to (not including) valid_to; open when valid_to is null. */
interface LinkRange {
    valid_from: string;
    valid_to: string | null;
}

/**
 * `ranges` as the fewest ranges that cover the same days, earliest first: two that overlap or
 * meet ([a, b) and [b, c)) become one. Days are 'YYYY-MM-DD' text, which sorts as the days do.
 */
export function unionOfRanges(ranges: readonly LinkRange[]): LinkRange[] {
    const sorted = [...ranges].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    const out: LinkRange[] = [];
    for (const range of sorted) {
        const last = out[out.length - 1];
        if (last && (last.valid_to === null || range.valid_from <= last.valid_to)) {
            if (last.valid_to !== null && (range.valid_to === null || range.valid_to > last.valid_to)) last.valid_to = range.valid_to;
        } else {
            out.push({ valid_from: range.valid_from, valid_to: range.valid_to });
        }
    }
    return out;
}

/** Whether `inner` lies within `outer`. */
const within = (inner: LinkRange, outer: LinkRange): boolean =>
    inner.valid_from >= outer.valid_from &&
    (outer.valid_to === null || (inner.valid_to !== null && inner.valid_to <= outer.valid_to));

/**
 * Make the goal's links to envelope `linkedId` cover every day of `ranges` too:
 * its links become the union of the ranges it had and `ranges`. Each range of the union keeps
 * one of the rows it holds (the open one, else the earliest), so a link the goal had keeps its
 * row; the other rows it holds are folded into it, and a range that holds none is added. The
 * open row, if any, is in the open range (the union's last), so no write makes a second open
 * link. The caller holds the goal's lock.
 */
async function coverRanges(goalId: number, linkedId: number, ranges: readonly LinkRange[]): Promise<void> {
    const own = await getDb()
        .selectFrom('goal_budget_items')
        .select(['id', 'valid_from', 'valid_to'])
        .where('goal_id', '=', goalId)
        .where('budget_item_id', '=', linkedId)
        .orderBy('valid_from')
        .orderBy('id')
        .execute();
    const folded: number[] = [];
    const kept: Array<{ id: number; range: LinkRange }> = [];
    const added: LinkRange[] = [];
    for (const range of unionOfRanges([...own, ...ranges])) {
        const inside = own.filter((row) => within(row, range));
        const keep = inside.find((row) => row.valid_to === null) ?? inside[0];
        if (!keep) {
            added.push(range);
            continue;
        }
        folded.push(...inside.filter((row) => row !== keep).map((row) => row.id));
        if (keep.valid_from !== range.valid_from || keep.valid_to !== range.valid_to) kept.push({ id: keep.id, range });
    }
    if (folded.length > 0) await sql`DELETE FROM goal_budget_items WHERE id = ANY(${folded}::int[])`.execute(getDb());
    for (const { id, range } of kept) {
        await sql`
            UPDATE goal_budget_items SET valid_from = ${range.valid_from}::date, valid_to = ${range.valid_to}::date WHERE id = ${id}
        `.execute(getDb());
    }
    for (const range of added) {
        await sql`
            INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from, valid_to)
            VALUES (${goalId}, ${linkedId}, ${range.valid_from}::date, ${range.valid_to}::date)
        `.execute(getDb());
    }
}

/**
 * The goals' links to envelope `fromId`, moved to `toId` (a budget item merge,
 * which moves `fromId`'s whole history, its budget events and transactions in every
 * period, onto `toId`, and archives it). Each goal that links `fromId`, or did, has `toId`
 * linked, with `linkTarget`, on every day it linked `fromId`, its closed ranges as well as
 * its open one (coverRanges), so the goal's readings on
 * those days keep the money they counted, which is `toId`'s now, and count `toId`'s own money
 * then too. A goal that had unlinked `fromId` before the merge is moved as well. The open link
 * to `fromId` is then closed today (closeLink); its closed ones stay as they are.
 *
 * Each goal is locked as any change of its links locks it, one at a time in id order, and
 * its links to `fromId` are read again under the lock. `linkTarget` is false when `toId`
 * doesn't roll over: a goal counts only envelopes (associateBudgetItem refuses another). The
 * number of goals whose links moved.
 */
export async function moveEnvelopeLinks(fromId: number, toId: number, options: { linkTarget: boolean }): Promise<number> {
    const rows = await getDb()
        .selectFrom('goal_budget_items')
        .select('goal_id')
        .distinct()
        .where('budget_item_id', '=', fromId)
        .orderBy('goal_id')
        .execute();
    let moved = 0;
    for (const { goal_id: goalId } of rows) {
        await lockGoalRow(goalId);
        const ranges = await getDb()
            .selectFrom('goal_budget_items')
            .select(['valid_from', 'valid_to'])
            .where('goal_id', '=', goalId)
            .where('budget_item_id', '=', fromId)
            .execute();
        if (ranges.length === 0) continue;
        // A goal merged into is not an envelope of its own.
        if (options.linkTarget && goalId !== toId) await coverRanges(goalId, toId, ranges);
        await closeLink('envelope', goalId, fromId);
        moved += 1;
    }
    return moved;
}

/**
 * GoalService - Manages financial goal tracking and progress calculations
 *
 * Goals track progress toward financial targets by combining balances from:
 * - Associated accounts (full account balance)
 * - Associated envelope budget items (rollover=true, full budget item balance)
 *
 * Supports:
 * - Current progress calculation
 * - Progress history: the same figure at each month end, computed from the balances
 *   when it is read (nothing is stored)
 * - Growth rate analysis (past performance), from that history
 * - Projection to completion
 */
export class GoalService {
    // Every query runs on the request's tenant transaction via getDb() (callers run
    // inside tenantHandler), so the service takes no pool.

    /**
     * Current progress for a goal: its progress as of today ({@link progressAt}), so this
     * figure and the last point of its history are one definition.
     */
    async calculateCurrentProgress(goalId: number): Promise<{
        totalFromAccounts: number;
        totalFromBudgetItems: number;
        totalProgress: number;
    }> {
        // One date asked for, one point.
        const now = oneRow(await this.progressQuery(goalId, sql`SELECT app_today()`), 'the progress query');
        return {
            totalFromAccounts: centsToNumber(numericToCents(now.total_from_accounts)),
            totalFromBudgetItems: centsToNumber(numericToCents(now.total_from_budget_items)),
            totalProgress: centsToNumber(numericToCents(now.total_progress))
        };
    }

    /**
     * A goal's progress at the end of each of `dates`, ascending, one point per distinct
     * date. Computed from the balances in one query, never from a stored figure:
     *
     * - **Accounts:** the balances as of each date of the accounts linked to the goal on
     *   that date and not hidden on it, from account_balances_as_of: one pass over their
     *   transactions for every date, with the one balance definition, so a
     *   transaction counts from its date on. A failure propagates rather than
     *   counting them as $0.
     * - **Envelopes:** for each rollover envelope linked to the goal on the date, the
     *   remaining of its period item in the budget period that contains the date, as the
     *   current figure takes the period containing today; an envelope with no period item
     *   there counts 0. calculate_remaining_for_period_items gives every point's in one
     *   pass over the envelopes' budget events and spending, the figure
     *   calculate_remaining_for_period_item gives each (one call per envelope per
     *   point took seconds, or minutes with stale planner statistics). The budget event
     *   log places a budget event or a transaction in a period, not on a day, so an
     *   envelope's balance is known at period granularity: on a date it is the balance
     *   after every event and transaction of that date's period and the earlier ones. At
     *   a month end, the last day of its monthly period, that is the period's closing
     *   balance; for today it is the current figure, which counts the whole current
     *   period. An event's created_at is when it was recorded, not when it took effect (a
     *   budget set for a past month is recorded later), so it isn't used to cut a period
     *   short.
     *
     * Links and hiding have a history: a link counts on day d when
     * `valid_from <= d AND (valid_to IS NULL OR d < valid_to)`, and an account is hidden on
     * d when it is within one of its account_hidden_ranges, the same half-open days. So
     * adding or removing a link, or hiding or showing an account, changes the history only
     * from that day: a point at the end of that day takes the change, the ones before it
     * don't. From today on, a point takes the links open now and the accounts'
     * `hide_account` flags, as the goal's lists do: a change of the ledger's time zone can
     * move today back before the first day a range was stored with.
     *
     * `linksAsOf` takes the links and hiding of that one day at every date instead: the
     * growth rate measures the accounts and envelopes the goal counts now, so linking an
     * account that already holds money isn't growth, nor unlinking one a loss.
     */
    async progressAt(
        goalId: number,
        dates: readonly string[],
        options: { linksAsOf?: string | undefined } = {}
    ): Promise<GoalProgressPoint[]> {
        if (dates.length === 0) return [];
        return this.progressQuery(goalId, sql`SELECT unnest(${[...dates]}::date[])`, options.linksAsOf ?? null);
    }

    /**
     * {@link progressAt}'s query, at the dates `dates` selects (one date column), with the
     * links and hiding of `linksAsOf` (a calendar date) at every date when it is given: the
     * current progress asks for app_today() in the same query, not in another first.
     */
    private async progressQuery(goalId: number, dates: RawBuilder<unknown>, linksAsOf: string | null = null): Promise<GoalProgressPoint[]> {
        // Set-returning functions and range joins: raw sql.
        const { rows } = await sql<GoalProgressPoint>`
            WITH points AS (
                SELECT DISTINCT d.as_of FROM (${dates}) AS d(as_of)
            ), dates AS (
                -- Each point, the day whose links and hiding it takes (its own, or
                -- linksAsOf), and whether that day is today or later: then the links open
                -- now and the hide_account flags, whatever days the ranges were stored with.
                SELECT p.as_of, s.links_day, s.links_day >= app_today() AS is_now
                  FROM points p
                  CROSS JOIN LATERAL (SELECT COALESCE(${linksAsOf}::date, p.as_of) AS links_day) s
            ), counted_accounts AS (
                -- On each date, the accounts the goal counts: linked to it then, and not
                -- hidden then. DISTINCT: an account counts once, however its links fall.
                SELECT DISTINCT d.as_of, bia.account_id
                  FROM dates d
                  JOIN budget_item_accounts bia
                    ON bia.budget_item_id = ${goalId}
                   AND CASE WHEN d.is_now THEN bia.valid_to IS NULL
                            ELSE bia.valid_from <= d.links_day AND (bia.valid_to IS NULL OR d.links_day < bia.valid_to) END
                  JOIN accounts a ON a.id = bia.account_id
                 WHERE CASE WHEN d.is_now THEN NOT a.hide_account
                            ELSE NOT EXISTS (
                                SELECT 1 FROM account_hidden_ranges h
                                 WHERE h.account_id = bia.account_id
                                   AND (h.hidden_from IS NULL OR h.hidden_from <= d.links_day)
                                   AND (h.hidden_to IS NULL OR d.links_day < h.hidden_to)) END
            ), from_accounts AS (
                SELECT ca.as_of, SUM(b.balance) AS total
                  FROM counted_accounts ca
                  JOIN account_balances_as_of(ARRAY(SELECT DISTINCT account_id FROM counted_accounts), ARRAY(SELECT as_of FROM dates)) b
                    ON b.account_id = ca.account_id AND b.as_of = ca.as_of
                 GROUP BY ca.as_of
            ), envelope_points AS (
                -- On each date, the period items, in the period containing it, of the
                -- rollover envelopes linked to the goal then.
                SELECT d.as_of, bpi.id AS period_item_id
                  FROM dates d
                  JOIN budget_period bp ON d.as_of BETWEEN bp.start_date AND bp.end_date
                  JOIN budget_period_items bpi ON bpi.budget_period_id = bp.id
                  JOIN budget_items bi ON bi.id = bpi.budget_item_id
                 WHERE bi.rollover = true
                   AND EXISTS (
                        SELECT 1 FROM goal_budget_items gbi
                         WHERE gbi.goal_id = ${goalId}
                           AND gbi.budget_item_id = bpi.budget_item_id
                           AND CASE WHEN d.is_now THEN gbi.valid_to IS NULL
                                    ELSE gbi.valid_from <= d.links_day AND (gbi.valid_to IS NULL OR d.links_day < gbi.valid_to) END)
            ), from_envelopes AS (
                -- Their remaining, all in one pass over the envelopes' budget events and
                -- spending, not one calculate_remaining_for_period_item call each.
                SELECT ep.as_of, SUM(r.remaining) AS total
                  FROM envelope_points ep
                  JOIN calculate_remaining_for_period_items(ARRAY(SELECT period_item_id FROM envelope_points)) r
                    ON r.budget_period_item_id = ep.period_item_id
                 GROUP BY ep.as_of
            )
            SELECT d.as_of::text AS snapshot_date,
                   round(COALESCE(fa.total, 0), 2)::text AS total_from_accounts,
                   round(COALESCE(fe.total, 0), 2)::text AS total_from_budget_items,
                   round(COALESCE(fa.total, 0) + COALESCE(fe.total, 0), 2)::text AS total_progress
              FROM dates d
              LEFT JOIN from_accounts fa ON fa.as_of = d.as_of
              LEFT JOIN from_envelopes fe ON fe.as_of = d.as_of
             ORDER BY d.as_of
        `.execute(getDb());
        return rows;
    }

    /** The goal's first day (the day it was created, in the application time zone) and today. */
    private async goalLife(goalId: number): Promise<{ firstDay: string; today: string }> {
        const { rows } = await sql<{ first_day: string; today: string }>`
            SELECT (created_at AT TIME ZONE app_timezone())::date::text AS first_day, app_today()::text AS today
              FROM budget_items
             WHERE id = ${goalId}
        `.execute(getDb());
        const [life] = rows;
        if (!life) {
            throw new ControlPlaneError(404, 'GOAL_NOT_FOUND', 'Goal not found');
        }
        return { firstDay: life.first_day, today: life.today };
    }

    /**
     * Average growth per month over the latest `months + 1` points of the goal's progress
     * history over its life so far (month ends, and today; {@link getProgressHistory}):
     * the change from the oldest of them to the newest, divided by the months between
     * their dates. Needs at least 3 points, so a goal begun this month or last has
     * no rate yet: null.
     *
     * Every point counts the accounts and envelopes the goal counts at the newest one
     * (`linksAsOf`): growth is what they gained, not what linking, unlinking, hiding
     * or showing one added or took away.
     */
    async calculateGrowthRate(goalId: number, months: number = 3): Promise<number | null> {
        const { firstDay, today } = await this.goalLife(goalId);
        // Far enough back to hold `months + 1` points, and not before the goal began.
        const earliest = addMonths(firstOfMonth(today), -(months + 1));
        const dates = progressHistoryDates(firstDay > earliest ? firstDay : earliest, today, today).slice(-(months + 1));
        if (dates.length < 3) {
            // Not enough history to calculate growth rate
            return null;
        }

        const points = await this.progressAt(goalId, dates, { linksAsOf: dates[dates.length - 1] });
        const newest = points.at(-1);
        const oldest = points[0];
        if (!newest || !oldest) return null;
        const elapsedMonths = daysBetween(oldest.snapshot_date, newest.snapshot_date) / DAYS_PER_MONTH;
        if (elapsedMonths <= 0) return null;

        const changeCents = numericToCents(newest.total_progress) - numericToCents(oldest.total_progress);
        return centsToNumber(changeCents) / elapsedMonths;
    }

    /**
     * Project completion date based on growth rates
     * Returns two projections:
     * - Based on past performance (actual growth rate)
     * - Based on planned contributions (estimated_monthly_contribution)
     */
    async projectCompletion(goalId: number, knownProgress?: { totalProgress: number }): Promise<{
        currentProgress: number;
        targetAmount: number | null;
        remainingAmount: number | null;
        pastPerformanceMonths: number | null;
        plannedContributionMonths: number | null;
        /** Calendar dates ('YYYY-MM-DD'). */
        pastPerformanceDate: string | null;
        plannedContributionDate: string | null;
    }> {
        // Get goal details
        const goalRows = await getDb()
            .selectFrom('budget_items')
            .select([
                'goal_target_amount as target_amount',
                'default_budget_amount as estimated_monthly_contribution',
                'goal_target_date as target_date'
            ])
            .where('id', '=', goalId)
            .where('expense_type', '=', budgetExpenseType.enum.Savings)
            .where('type', '=', 'Goal')
            .execute();

        const goal = goalRows[0];
        if (!goal) {
            throw new Error(`Goal not found with id: ${goalId}`);
        }

        const estimatedMonthlyContribution = parseFloat(goal.estimated_monthly_contribution || '0');

        // Current progress: reuse the caller's when it already computed it.
        const progress = knownProgress ?? await this.calculateCurrentProgress(goalId);
        const currentProgress = progress.totalProgress;
        // No target (a goal made through the budget item routes): nothing to reach,
        // so no remaining and no date. It read as reached today (NaN target, 0 - progress left).
        if (goal.target_amount == null) {
            return {
                currentProgress,
                targetAmount: null,
                remainingAmount: null,
                pastPerformanceMonths: null,
                plannedContributionMonths: null,
                pastPerformanceDate: null,
                plannedContributionDate: null,
            };
        }
        const targetAmount = centsToNumber(numericToCents(goal.target_amount));
        // In cents: as floats, 160.25 - 159.95 came out as 0.30000000000001137.
        const remainingAmount = centsToNumber(numericToCents(goal.target_amount) - numericToCents(currentProgress));
        const today = await appToday();

        // If already at or over target, return immediately
        if (remainingAmount <= 0) {
            return {
                currentProgress,
                targetAmount,
                remainingAmount,
                pastPerformanceMonths: 0,
                plannedContributionMonths: 0,
                pastPerformanceDate: today,
                plannedContributionDate: today
            };
        }

        // Calculate based on past performance (3+ months of history)
        const growthRate = await this.calculateGrowthRate(goalId, 3);
        let pastPerformanceMonths: number | null = null;
        let pastPerformanceDate: string | null = null;

        if (growthRate !== null && growthRate > 0) {
            pastPerformanceMonths = Math.ceil(remainingAmount / growthRate);
            pastPerformanceDate = projectedDay(today, pastPerformanceMonths);
        }

        // Calculate based on planned contributions
        let plannedContributionMonths: number | null = null;
        let plannedContributionDate: string | null = null;

        if (estimatedMonthlyContribution > 0) {
            plannedContributionMonths = Math.ceil(remainingAmount / estimatedMonthlyContribution);
            plannedContributionDate = projectedDay(today, plannedContributionMonths);
        }

        return {
            currentProgress,
            targetAmount,
            remainingAmount,
            pastPerformanceMonths,
            plannedContributionMonths,
            pastPerformanceDate,
            plannedContributionDate
        };
    }

    /**
     * A goal's progress history: its progress ({@link progressAt}) at each month end
     * from `startDate` to `endDate`, and today when it falls in the range; never after
     * today. Without an end date the range ends today. Without a start date it begins on
     * the day the goal was created (its life so far), at most
     * {@link PROGRESS_HISTORY_MAX_MONTHS} months before the range's last day. A start
     * date after the end date given, or a range of more months than that up to its last
     * day, is refused (a 400), so a request can't build more than about 120 points. A
     * range wholly after today has none.
     */
    async getProgressHistory(goalId: number, range: { startDate?: string | undefined; endDate?: string | undefined } = {}): Promise<GoalProgressPoint[]> {
        const { firstDay, today } = await this.goalLife(goalId);
        const end = range.endDate ?? today;
        // The last day a point is drawn at.
        const last = end < today ? end : today;
        let start: string;
        if (range.startDate !== undefined) {
            start = range.startDate;
            if (range.endDate !== undefined && start > range.endDate) {
                throw new ControlPlaneError(400, 'INVALID_DATE_RANGE', 'start_date must be on or before end_date');
            }
            if (start > last) return [];
            if (monthIndex(last) - monthIndex(start) > PROGRESS_HISTORY_MAX_MONTHS) {
                throw new ControlPlaneError(
                    400,
                    'DATE_RANGE_TOO_LONG',
                    `A goal's progress history covers at most ${PROGRESS_HISTORY_MAX_MONTHS / 12} years: ask for a shorter range`
                );
            }
        } else {
            const earliest = addMonths(last, -PROGRESS_HISTORY_MAX_MONTHS);
            start = firstDay > earliest ? firstDay : earliest;
        }
        return this.progressAt(goalId, progressHistoryDates(start, end, today));
    }

    /**
     * Link an account to a goal, from today on: a no-op when it is linked now.
     * Returns the link's id.
     */
    async associateAccount(goalId: number, accountId: number): Promise<number> {
        // An account of this ledger (RLS hides the others): a 400 INVALID_REFERENCE otherwise,
        // as for every numeric id in a body, not the foreign-key error's 500.
        await refuseMissingReference('account_id', accountId);

        return openLink('account', goalId, accountId);
    }

    /**
     * Unlink an account from a goal, from today on: the link is closed, so the
     * goal's history before today still counts it.
     */
    async removeAccountAssociation(goalId: number, accountId: number): Promise<void> {
        await closeLink('account', goalId, accountId);
    }

    /**
     * Link a budget item to a goal, from today on (it must be rollover=true): a
     * no-op when it is linked now. Returns the link's id.
     *
     * The goal's and the envelope's rows are locked first (FOR NO KEY UPDATE, in id order, in
     * one statement, as a merge locks its two items), and the envelope is read under the lock:
     * a merge or an archive of it holds its row while it moves its goal links and
     * archives it, and a link made meanwhile, which waited for nothing (its foreign key takes
     * FOR KEY SHARE), stayed open on the archived item. Now it waits, and then finds the
     * envelope archived: a 400 BUDGET_ITEM_ARCHIVED, as a budget change on an archived item is.
     * In id order, a link and a merge of the envelope into the same goal wait for each other at
     * the first row (the envelope first deadlocked with it when the goal's id was lower), and so
     * do a link and a merge into the envelope of an item the goal links, which takes the goals
     * linking that item with its two items. A wait past the lock timeout, or a deadlock
     * with a write outside these, is a 409 RECORD_BUSY, nothing linked (or merged).
     */
    async associateBudgetItem(goalId: number, budgetItemId: number): Promise<number> {
        // A budget item of this ledger (400 INVALID_REFERENCE otherwise) that rolls over.
        await refuseMissingReference('budget_item_id', budgetItemId);
        let envelope: { name: string; rollover: boolean; status: string | null } | undefined;
        try {
            const rows = await getDb()
                .selectFrom('budget_items')
                .select(['id', 'name', 'rollover', 'status'])
                .where('id', 'in', [goalId, budgetItemId])
                .orderBy('id')
                .forNoKeyUpdate()
                .execute();
            envelope = rows.find((row) => row.id === budgetItemId);
        } catch (err) {
            if (!isLockConflict(err)) throw err;
            throw goalBusy();
        }

        if (!envelope?.rollover) {
            throw new ControlPlaneError(400, 'BUDGET_ITEM_NOT_ROLLOVER', 'Only rollover (envelope) budget items can be associated with goals');
        }
        if (envelope.status === budgetItemStatus.enum.archived) {
            throw new GoalError(400, 'BUDGET_ITEM_ARCHIVED', `${envelope.name} is archived. Restore it first to link it to a goal.`);
        }

        return openLink('envelope', goalId, budgetItemId);
    }

    /**
     * Unlink a budget item from a goal, from today on: the link is closed, so the
     * goal's history before today still counts it.
     */
    async removeBudgetItemAssociation(goalId: number, budgetItemId: number): Promise<void> {
        await closeLink('envelope', goalId, budgetItemId);
    }

    /**
     * The accounts linked to a goal now and not hidden, each with the day it is linked
     * since (`linked_since`, a calendar date).
     */
    async getAssociatedAccounts(goalId: number) {
        const balanceService = accountBalanceService;

        const rows = await getDb()
            .selectFrom('budget_item_accounts as bia')
            .innerJoin('accounts as a', 'bia.account_id', 'a.id')
            .select([
                'a.id',
                'a.uuid',
                'a.name',
                'a.account_type',
                'a.account_group',
                'a.subtype',
                'a.icon',
                'bia.created_at as associated_at',
                'bia.valid_from as linked_since'
            ])
            .where('bia.budget_item_id', '=', goalId)
            // Linked now: a closed link is history.
            .where('bia.valid_to', 'is', null)
            .where('a.hide_account', '=', false)
            .orderBy('a.name')
            .execute();

        // All balances in one query; unavailable (null), never $0, on failure.
        const balances = await balanceService.tryGetBalances(rows.map(a => a.id));
        const accountsWithBalances = rows.map((account) => ({
            ...account,
            calculated_balance: balances ? (balances.get(account.id) ?? 0) : null,
            balance_unavailable: balances === null
        }));

        return accountsWithBalances;
    }

    /**
     * The envelopes linked to a goal now, each with the day it is linked since
     * (`linked_since`, a calendar date).
     */
    async getAssociatedBudgetItems(goalId: number) {
        const rows = await getDb()
            .selectFrom('goal_budget_items as gbi')
            .innerJoin('budget_items as bi', 'gbi.budget_item_id', 'bi.id')
            .select([
                'bi.id',
                'bi.uuid',
                'bi.name',
                'bi.color',
                'bi.icon',
                'bi.rollover_starting_balance',
                'gbi.created_at as associated_at',
                'gbi.valid_from as linked_since'
            ])
            .where('gbi.goal_id', '=', goalId)
            // Linked now: a closed link is history.
            .where('gbi.valid_to', 'is', null)
            .where('bi.rollover', '=', true)
            .orderBy('bi.name')
            .execute();

        return rows;
    }

    // ====================================================================
    // THE GOAL ROUTES: a goal named by its uuid
    // ====================================================================

    /** The goals of the ledger: Savings budget items of type Goal. */
    private goals() {
        return getDb().selectFrom('budget_items').where('expense_type', '=', budgetExpenseType.enum.Savings).where('type', '=', 'Goal');
    }

    /** The id of the goal `uuid` names, or a 404 GoalError. */
    async goalIdOf(uuid: string): Promise<number> {
        const row = await this.goals().select('id').where('uuid', '=', uuid).executeTakeFirst();
        if (!row) throw goalNotFound();
        return row.id;
    }

    /**
     * A goal's figures beside its row: its progress now, as a share of its target, and what is
     * left. A goal with no target (one made through the budget item routes, which set none)
     * has no share and nothing left to reach: null, not 0% and minus its progress.
     */
    private progressFigures(targetAmount: string | null, progress: { totalProgress: number }) {
        if (targetAmount == null) {
            return { current_progress: progress.totalProgress, progress_percentage: null, remaining_amount: null };
        }
        const target = Number(targetAmount); // numeric arrives as string from pg
        return {
            current_progress: progress.totalProgress,
            progress_percentage: target > 0 ? Math.min((progress.totalProgress / target) * 100, 100) : 0,
            remaining_amount: centsToNumber(numericToCents(targetAmount) - numericToCents(progress.totalProgress)),
        };
    }

    /**
     * The goals that aren't archived, by target date (then newest first), each with how many
     * accounts and envelopes it links now (a closed link is history), its progress and
     * its projected completion date. One goal at a time: every query shares the request's
     * transaction, so a Promise.all would only queue on it.
     */
    async listGoals() {
        // The links open now, counted once each (GROUP BY the goal's key).
        const rows = await getDb()
            .selectFrom('budget_items as g')
            .leftJoin('budget_item_accounts as bia', (join) => join.onRef('bia.budget_item_id', '=', 'g.id').on('bia.valid_to', 'is', null))
            .leftJoin('goal_budget_items as gbi', (join) => join.onRef('gbi.goal_id', '=', 'g.id').on('gbi.valid_to', 'is', null))
            .select([
                'g.id',
                'g.uuid',
                'g.name',
                'g.description',
                'g.goal_target_amount as target_amount',
                'g.goal_target_date as target_date',
                'g.default_budget_amount as estimated_monthly_contribution',
                'g.image_path',
                'g.status',
                'g.created_at',
                'g.updated_at',
            ])
            .select((eb) => [
                eb.fn.count<string>('bia.id').distinct().as('account_count'),
                eb.fn.count<string>('gbi.id').distinct().as('budget_item_count'),
            ])
            .where('g.expense_type', '=', budgetExpenseType.enum.Savings)
            .where('g.type', '=', 'Goal')
            .where('g.status', '!=', budgetItemStatus.enum.archived)
            .groupBy('g.id')
            .orderBy('g.goal_target_date', 'asc')
            .orderBy('g.created_at', 'desc')
            .execute();

        const goals = [];
        for (const goal of rows) {
            const progress = await this.calculateCurrentProgress(goal.id);
            const projection = await this.projectCompletion(goal.id, progress);
            goals.push({
                ...goal,
                ...this.progressFigures(goal.target_amount, progress),
                projected_completion_date: projection.pastPerformanceDate || projection.plannedContributionDate,
            });
        }
        return goals;
    }

    /** One goal with its progress, projection, links and progress history (its life so far). */
    async getGoal(uuid: string) {
        const goal = await this.goals().select(GOAL_COLUMNS).where('uuid', '=', uuid).executeTakeFirst();
        if (!goal) throw goalNotFound();

        const progress = await this.calculateCurrentProgress(goal.id);
        const projection = await this.projectCompletion(goal.id, progress);
        const accounts = await this.getAssociatedAccounts(goal.id);
        const budgetItems = await this.getAssociatedBudgetItems(goal.id);
        const history = await this.getProgressHistory(goal.id);
        const { current_progress, progress_percentage, remaining_amount } = this.progressFigures(goal.target_amount, progress);
        return {
            ...goal,
            current_progress,
            total_from_accounts: progress.totalFromAccounts,
            total_from_budget_items: progress.totalFromBudgetItems,
            progress_percentage,
            remaining_amount,
            projection,
            associated_accounts: accounts,
            associated_budget_items: budgetItems,
            progress_history: history,
        };
    }

    /**
     * A new goal: a Savings budget item of type Goal (goalCreateSchema checked its fields),
     * with an item in every existing budget period. Its amounts are read in cents.
     */
    async createGoal(input: GoalCreateInput) {
        const target = goalAmount(input.target_amount, 'target_amount');
        const monthly = goalAmount(input.estimated_monthly_contribution, 'estimated_monthly_contribution');
        const created = await getDb()
            .insertInto('budget_items')
            .values({
                name: input.name,
                description: input.description,
                expense_type: 'Savings',
                type: 'Goal',
                subtype: 'Goal',
                rollover: false,
                isbill: false,
                recurring_payment: false,
                default_budget_amount: monthly ?? '0.00',
                goal_target_amount: target,
                goal_target_date: input.target_date,
                status: input.status,
                color: '#10B981',
                icon: 'Target',
            })
            .returning(GOAL_COLUMNS)
            .executeTakeFirstOrThrow();

        // A period item in every existing period. INSERT ... SELECT across budget_period: raw sql.
        await sql`
            INSERT INTO budget_period_items (budget_period_id, budget_item_id, starting)
            SELECT id, ${created.id}, 0.00
            FROM budget_period
        `.execute(getDb());
        return created;
    }

    /**
     * Change the fields sent (goalUpdateSchema); a field not sent keeps its value. The two a goal
     * may have none of, its description and its monthly contribution, are cleared by null
     * (null was read as not sent, so a client couldn't clear them).
     */
    async updateGoal(uuid: string, input: GoalUpdateInput) {
        const target = goalAmount(input.target_amount, 'target_amount');
        const monthly = goalAmount(input.estimated_monthly_contribution, 'estimated_monthly_contribution');
        const updated = await getDb()
            .updateTable('budget_items')
            .set({
                name: sql<string>`COALESCE(${input.name ?? null}, name)`,
                description: input.description === undefined ? sql<string | null>`description` : input.description,
                goal_target_amount: sql<string | null>`COALESCE(${target}, goal_target_amount)`,
                goal_target_date: sql<string | null>`COALESCE(${input.target_date ?? null}, goal_target_date)`,
                default_budget_amount: input.estimated_monthly_contribution === undefined ? sql<string | null>`default_budget_amount` : monthly,
                status: sql<string | null>`COALESCE(${input.status ?? null}, status)`,
                updated_at: sql<Date>`CURRENT_TIMESTAMP`,
            })
            .where('uuid', '=', uuid)
            .where('expense_type', '=', budgetExpenseType.enum.Savings)
            .where('type', '=', 'Goal')
            .returning(GOAL_COLUMNS)
            .executeTakeFirst();
        if (!updated) throw goalNotFound();
        return updated;
    }

    /** Archive a goal (a soft delete: its status, not its row). */
    async archiveGoal(uuid: string) {
        const archived = await getDb()
            .updateTable('budget_items')
            .set({ status: 'archived', updated_at: sql<Date>`CURRENT_TIMESTAMP` })
            .where('uuid', '=', uuid)
            .where('expense_type', '=', budgetExpenseType.enum.Savings)
            .where('type', '=', 'Goal')
            .returning(GOAL_COLUMNS)
            .executeTakeFirst();
        if (!archived) throw goalNotFound();
        return archived;
    }

    /** Link account `accountId` to the goal `uuid` names, from today on ({@link associateAccount}). */
    async linkAccount(uuid: string, accountId: number): Promise<void> {
        await this.associateAccount(await this.goalIdOf(uuid), accountId);
    }

    /**
     * Unlink the account `accountUuid` names from the goal, from today on
     * ({@link removeAccountAssociation}). One that isn't linked, or isn't the ledger's, is
     * nothing to unlink: nothing changes.
     */
    async unlinkAccount(uuid: string, accountUuid: string): Promise<void> {
        const goalId = await this.goalIdOf(uuid);
        const account = await getDb().selectFrom('accounts').select('id').where('uuid', '=', accountUuid).executeTakeFirst();
        if (account) await this.removeAccountAssociation(goalId, account.id);
    }

    /** Link envelope `budgetItemId` to the goal `uuid` names, from today on ({@link associateBudgetItem}). */
    async linkBudgetItem(uuid: string, budgetItemId: number): Promise<void> {
        await this.associateBudgetItem(await this.goalIdOf(uuid), budgetItemId);
    }

    /** Unlink the envelope `budgetItemUuid` names from the goal, from today on; as {@link unlinkAccount}, a no-op when it isn't linked. */
    async unlinkBudgetItem(uuid: string, budgetItemUuid: string): Promise<void> {
        const goalId = await this.goalIdOf(uuid);
        const item = await getDb().selectFrom('budget_items').select('id').where('uuid', '=', budgetItemUuid).executeTakeFirst();
        if (item) await this.removeBudgetItemAssociation(goalId, item.id);
    }

    /** The goal's progress history ({@link getProgressHistory}) over a range of calendar dates. */
    async progressHistoryOf(uuid: string, range: { startDate?: string | undefined; endDate?: string | undefined }) {
        return this.getProgressHistory(await this.goalIdOf(uuid), range);
    }

    /**
     * The accounts the goal counts now: linked now (a closed link is history) and not
     * hidden, as its progress counts them (a hidden one was in the balance
     * histories, though not in the progress), each once.
     */
    private async countedAccounts(goalId: number) {
        return getDb()
            .selectFrom('budget_item_accounts as bia')
            .innerJoin('accounts as a', 'a.id', 'bia.account_id')
            .select(['a.id', 'a.name', 'a.uuid'])
            .distinct()
            .where('bia.budget_item_id', '=', goalId)
            .where('bia.valid_to', 'is', null)
            .where('a.hide_account', '=', false)
            .orderBy('a.id')
            .execute();
    }

    /**
     * The total balance of the accounts the goal counts now at each date of the range:
     * the one balance definition at each date, from one pass over their
     * transactions (account_balances_as_of).
     */
    async balanceHistory(uuid: string, range: GoalBalanceHistoryRange): Promise<Array<{ date: string; balance: number }>> {
        const goalId = await this.goalIdOf(uuid);
        const accountIds = (await this.countedAccounts(goalId)).map((account) => account.id);
        if (accountIds.length === 0) return [];

        const { rows } = await sql<{ date: string; balance: string }>`
            WITH date_series AS (${historyDates(range)})
            SELECT ds.date_point AS date, COALESCE(SUM(b.balance), 0) AS balance
              FROM date_series ds
              CROSS JOIN UNNEST(${accountIds}::int[]) AS u(account_id)
              LEFT JOIN account_balances_as_of(${accountIds}::int[], ARRAY(SELECT date_point FROM date_series)) b
                     ON b.account_id = u.account_id AND b.as_of = ds.date_point
             GROUP BY ds.n, ds.date_point
             ORDER BY ds.date_point ASC, ds.n
        `.execute(getDb());
        return rows.map((row) => ({ date: row.date, balance: centsToNumber(numericToCents(row.balance)) }));
    }

    /** {@link balanceHistory}, account by account. */
    async accountBalanceHistory(uuid: string, range: GoalBalanceHistoryRange) {
        const goalId = await this.goalIdOf(uuid);
        const accounts = await this.countedAccounts(goalId);
        if (accounts.length === 0) return [];

        const { rows } = await sql<{ account_id: number; date: string; balance: string }>`
            WITH date_series AS (${historyDates(range)})
            SELECT b.account_id, ds.date_point AS date, b.balance
              FROM date_series ds
              JOIN account_balances_as_of(${accounts.map((a) => a.id)}::int[], ARRAY(SELECT date_point FROM date_series)) b
                ON b.as_of = ds.date_point
             ORDER BY ds.date_point ASC, ds.n
        `.execute(getDb());
        return accounts.map((account) => ({
            account_id: account.id,
            account_uuid: account.uuid,
            account_name: account.name,
            history: rows
                .filter((row) => row.account_id === account.id)
                .map((row) => ({ date: row.date, balance: centsToNumber(numericToCents(row.balance)) })),
        }));
    }

    /**
     * Give the goal an image: its bytes stored in the ledger (storeImage takes its type from
     * them and strips their metadata), its URL on the goal, and the image it had deleted,
     * unless something else in the ledger shows it (a merchant may).
     */
    async setImage(uuid: string, file: { mimetype: string; buffer: Buffer }, userId: number | null): Promise<string> {
        const goal = await this.goals().select(['id', 'image_path']).where('uuid', '=', uuid).executeTakeFirst();
        if (!goal) throw goalNotFound();
        const imgUuid = await storeImage(getDb(), { mimeType: file.mimetype, data: file.buffer, createdByUserId: userId });
        const path = imageUrl(imgUuid);
        await getDb()
            .updateTable('budget_items')
            .set({ image_path: path, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
            .where('id', '=', goal.id)
            .execute();
        await deleteImageByUrl(getDb(), goal.image_path);
        return path;
    }

    /** Take the goal's image off it, and delete it unless something else in the ledger shows it. One without an image is a 404. */
    async deleteImage(uuid: string): Promise<void> {
        const goal = await this.goals().select(['id', 'image_path']).where('uuid', '=', uuid).executeTakeFirst();
        if (!goal) throw goalNotFound();
        if (!goal.image_path) throw new GoalError(404, 'NOT_FOUND', 'No image found for this goal');
        await getDb()
            .updateTable('budget_items')
            .set({ image_path: null, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
            .where('id', '=', goal.id)
            .execute();
        await deleteImageByUrl(getDb(), goal.image_path);
    }
}
