import { z } from 'zod';
import { moneyInput, isPositiveDecimal, calendarDay, isCalendarDay, CALENDAR_DAY_YEARS, emptyAsUndefined, queryInt } from './primitives.js';
import { billResolution } from './vocabulary.js';
import { dayText, nullableDayText, responseAmount } from './responses.js';

/**
 * Bills: the payments a bill (a budget item with `isbill`) is due to make, and
 * the transactions that paid them.
 *
 * A bill occurrence is one due date. Money here is in dollars and positive —
 * "$600 due", "$612.40 paid" — though stored amounts stay pre-signed. Status
 * is worked out from the payments and today's date when it's read.
 */

/**
 * A calendar month, 'YYYY-MM', in the years a request's calendar date may fall in
 * (CALENDAR_DAY_YEARS): the month view reads the month after it, and from 9999-12 that was
 * "+010000-01", which Postgres refused (a 500), as it did year 0000.
 */
export const billMonth = z
  .string()
  // A month that isn't YYYY-MM gets this one message, not the range's too.
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Give a month as YYYY-MM.', abort: true })
  .refine(
    (month) => isCalendarDay(`${month}-01`),
    `Give a month as YYYY-MM, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}.`,
  );

/**
 * A calendar day, 'YYYY-MM-DD': a real one (calendarDay), so 2026-02-30 or 0000-01-01 is a
 * 400 rather than the database's error (a 500) on the due date or the paid date.
 */
export const billDay = calendarDay;

/** GET /api/bills?month=YYYY-MM: the month to show (this month when not given). */
export const billMonthQuery = z.object({
  month: emptyAsUndefined(billMonth),
});

/** GET /api/bills/forecast?months=N: how many months from this one (12 by default, 1 to 24). */
export const billForecastQuery = z.object({
  months: queryInt({ min: 1, max: 24, default: 12 }),
});

/** GET /api/bills/occurrences/:uuid/candidates?q=words: the words to look for (the first 100 characters). */
export const billCandidatesQuery = z.object({
  q: emptyAsUndefined(z.string({ error: 'Give the words to look for once.' }).transform((words) => words.slice(0, 100))),
});

export const billStatuses = ['paid', 'partly_paid', 'overdue', 'due_soon', 'upcoming', 'skipped'] as const;
export type BillStatus = (typeof billStatuses)[number];

// The answers. Each schema names every field its route sends, so the route
// tests' answerProblem and the frontend's parseAnswer fail on one it doesn't. Money is a
// positive amount in dollars, worked out in BillService and rounded to the cent.

const billStatus = z.enum(billStatuses);
/** A calendar month, 'YYYY-MM', as an answer names one. */
const monthText = z.string().regex(/^\d{4}-\d{2}$/, "a month as 'YYYY-MM'");

/** A transaction that paid (part of) a due date. */
export const billPaymentResponseSchema = z.object({
  transaction_uuid: z.uuid(),
  date: dayText,
  amount: responseAmount,
  description: z.string().nullable(),
  /** Its account's name. */
  account: z.string().nullable(),
  matched_by: z.enum(['auto', 'manual']),
});
export type BillPayment = z.infer<typeof billPaymentResponseSchema>;

export const billRefResponseSchema = z.object({
  uuid: z.uuid(),
  name: z.string(),
  /** Its amount changes from payment to payment; it's forecast from recent payments. */
  varies: z.boolean(),
});
export type BillRef = z.infer<typeof billRefResponseSchema>;

/**
 * One due date of a bill: the link, unlink, resolve and place answers, and each of a month's
 * (GET /api/bills).
 */
export const billOccurrenceResponseSchema = z.object({
  uuid: z.uuid(),
  bill: billRefResponseSchema,
  due_date: dayText,
  expected: responseAmount,
  /** Paid so far: its payments, or the amount entered when marked paid by hand. */
  paid: responseAmount,
  status: billStatus,
  /** The day it was fully paid: its last payment's, or the one entered by hand. */
  paid_date: nullableDayText,
  resolution: billResolution.nullable(),
  note: z.string().nullable(),
  payments: z.array(billPaymentResponseSchema),
});
export type BillOccurrence = z.infer<typeof billOccurrenceResponseSchema>;

/** A transaction in a bill that no due date took: a person places it, or leaves it. */
export const unplacedBillPaymentResponseSchema = z.object({
  transaction_uuid: z.uuid(),
  date: dayText,
  amount: responseAmount,
  description: z.string().nullable(),
  account: z.string().nullable(),
  bill: billRefResponseSchema,
});
export type UnplacedBillPayment = z.infer<typeof unplacedBillPaymentResponseSchema>;

/** GET /api/bills: the bills due in a month, its totals, and bill payments no due date took. */
export const billMonthViewResponseSchema = z.object({
  month: monthText,
  today: dayText,
  totals: z.object({ expected: responseAmount, paid: responseAmount, remaining: responseAmount }),
  occurrences: z.array(billOccurrenceResponseSchema),
  unplaced: z.array(unplacedBillPaymentResponseSchema),
});
export type BillMonthView = z.infer<typeof billMonthViewResponseSchema>;

/** One bill in a forecast month. */
export const billForecastItemResponseSchema = z.object({
  bill: billRefResponseSchema,
  due_date: dayText,
  amount: responseAmount,
  /** `paid` and `skipped` months use what happened; `expected` is the forecast. */
  basis: z.enum(['expected', 'paid', 'skipped']),
});
export type BillForecastItem = z.infer<typeof billForecastItemResponseSchema>;

export const billForecastMonthResponseSchema = z.object({
  month: monthText,
  total: responseAmount,
  items: z.array(billForecastItemResponseSchema),
});
export type BillForecastMonth = z.infer<typeof billForecastMonthResponseSchema>;
/** GET /api/bills/forecast: one entry per month, from this one on. */
export const billForecastResponseSchema = z.array(billForecastMonthResponseSchema);

/** A transaction a person could link to a due date. */
export const billPaymentCandidateResponseSchema = z.object({
  transaction_uuid: z.uuid(),
  date: dayText,
  amount: responseAmount,
  description: z.string().nullable(),
  account: z.string().nullable(),
  /** Its budget item's name. */
  budget_item: z.string().nullable(),
  /** The due date it already pays, if any; linking it here moves it. */
  linked_due_date: nullableDayText,
});
export type BillPaymentCandidate = z.infer<typeof billPaymentCandidateResponseSchema>;
/** GET /api/bills/occurrences/:uuid/candidates */
export const billPaymentCandidatesResponseSchema = z.array(billPaymentCandidateResponseSchema);

/** A due date of one bill a payment could be placed on. */
export const billDueDateResponseSchema = z.object({
  due_date: dayText,
  status: billStatus,
  expected: responseAmount,
});
export type BillDueDate = z.infer<typeof billDueDateResponseSchema>;
/** GET /api/bills/:uuid/due-dates */
export const billDueDatesResponseSchema = z.array(billDueDateResponseSchema);

/** POST /api/bills/occurrences/:uuid/payments */
export const linkBillPaymentSchema = z.object({
  transaction_uuid: z.uuid(),
});

/** POST /api/bills/:uuid/payments — place a transaction on one of the bill's due dates. */
export const placeBillPaymentSchema = z.object({
  transaction_uuid: z.uuid(),
  due_date: billDay,
});

/** PUT /api/bills/occurrences/:uuid/resolution — skip it, mark it paid by hand, or undo either. */
export const resolveBillOccurrenceSchema = z
  .object({
    resolution: billResolution.nullable(),
    paid_date: billDay.nullable().optional(),
    // A number or decimal text, as sent (moneyInput), which BillService reads in cents.
    paid_amount: moneyInput('Give the amount paid as a number.').refine(isPositiveDecimal, 'Give the amount paid.').nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (value.resolution !== 'paid_manually') return;
    if (!value.paid_date) context.addIssue({ code: 'custom', path: ['paid_date'], message: 'Give the date it was paid.' });
    if (value.paid_amount == null) context.addIssue({ code: 'custom', path: ['paid_amount'], message: 'Give the amount paid.' });
  });

export type ResolveBillOccurrenceInput = z.input<typeof resolveBillOccurrenceSchema>;
