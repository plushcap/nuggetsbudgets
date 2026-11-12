/**
 * API Bills Module — what's due each month and whether it's paid, the bill
 * forecast, and the hand corrections (link, unlink, place, skip, mark paid).
 *
 * Every answer is read with its `@nuggets/shared` response schema (parseAnswer),
 * and every query string is built from the route's own query schema (queryString).
 */
import {
  billCandidatesQuery,
  billDueDatesResponseSchema,
  billForecastQuery,
  billForecastResponseSchema,
  billMonthQuery,
  billMonthViewResponseSchema,
  billOccurrenceResponseSchema,
  billPaymentCandidatesResponseSchema,
  queryString,
  type BillDueDate,
  type BillForecastMonth,
  type BillMonthView,
  type BillOccurrence,
  type BillPaymentCandidate,
  type ResolveBillOccurrenceInput,
} from '@nuggets/shared';
import { apiGet, apiPost, apiPut, apiDelete } from './base';
import { parseAnswer } from './parseAnswer';

/** The bills due in `month` ('YYYY-MM'; this month when left out). */
export const getBillMonth = async (month?: string): Promise<BillMonthView> =>
  parseAnswer(billMonthViewResponseSchema, await apiGet<unknown>(`/bills${queryString(billMonthQuery, { month })}`), 'bill month');

export const getBillForecast = async (months = 12): Promise<BillForecastMonth[]> =>
  parseAnswer(billForecastResponseSchema, await apiGet<unknown>(`/bills/forecast${queryString(billForecastQuery, { months })}`), 'bill forecast');

export const getBillPaymentCandidates = async (occurrenceUuid: string, query?: string): Promise<BillPaymentCandidate[]> =>
  parseAnswer(
    billPaymentCandidatesResponseSchema,
    await apiGet<unknown>(`/bills/occurrences/${occurrenceUuid}/candidates${queryString(billCandidatesQuery, { q: query })}`),
    'bill payment candidates',
  );

export const linkBillPayment = async (occurrenceUuid: string, transactionUuid: string): Promise<BillOccurrence> =>
  parseAnswer(
    billOccurrenceResponseSchema,
    await apiPost<unknown>(`/bills/occurrences/${occurrenceUuid}/payments`, { transaction_uuid: transactionUuid }),
    'bill occurrence',
  );

export const unlinkBillPayment = async (occurrenceUuid: string, transactionUuid: string): Promise<BillOccurrence> =>
  parseAnswer(
    billOccurrenceResponseSchema,
    await apiDelete<unknown>(`/bills/occurrences/${occurrenceUuid}/payments/${transactionUuid}`),
    'bill occurrence',
  );

export const resolveBillOccurrence = async (occurrenceUuid: string, body: ResolveBillOccurrenceInput): Promise<BillOccurrence> =>
  parseAnswer(billOccurrenceResponseSchema, await apiPut<unknown>(`/bills/occurrences/${occurrenceUuid}/resolution`, body), 'bill occurrence');

export const getBillDueDates = async (billUuid: string): Promise<BillDueDate[]> =>
  parseAnswer(billDueDatesResponseSchema, await apiGet<unknown>(`/bills/${billUuid}/due-dates`), 'bill due dates');

export const placeBillPayment = async (billUuid: string, transactionUuid: string, dueDate: string): Promise<BillOccurrence> =>
  parseAnswer(
    billOccurrenceResponseSchema,
    await apiPost<unknown>(`/bills/${billUuid}/payments`, { transaction_uuid: transactionUuid, due_date: dueDate }),
    'bill occurrence',
  );
