import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResolveBillOccurrenceInput } from '@nuggets/shared';
import {
  getBillDueDates,
  getBillForecast,
  getBillMonth,
  getBillPaymentCandidates,
  linkBillPayment,
  placeBillPayment,
  resolveBillOccurrence,
  unlinkBillPayment,
} from '../../services/api';

export const billKeys = {
  all: ['bills'] as const,
  month: (month: string) => ['bills', 'month', month] as const,
  forecast: (months: number) => ['bills', 'forecast', months] as const,
  candidates: (occurrenceUuid: string, query: string) => ['bills', 'candidates', occurrenceUuid, query] as const,
  dueDates: (billUuid: string) => ['bills', 'due-dates', billUuid] as const,
};

/** The bills due in `month` ('YYYY-MM'), with their status and the month's totals. */
export function useBillMonthQuery(month: string) {
  return useQuery({ queryKey: billKeys.month(month), queryFn: () => getBillMonth(month) });
}

export function useBillForecastQuery(months = 12) {
  return useQuery({ queryKey: billKeys.forecast(months), queryFn: () => getBillForecast(months) });
}

export function useBillPaymentCandidatesQuery(occurrenceUuid: string | null, query: string) {
  return useQuery({
    queryKey: billKeys.candidates(occurrenceUuid ?? '', query),
    queryFn: () => getBillPaymentCandidates(occurrenceUuid as string, query || undefined),
    enabled: !!occurrenceUuid,
  });
}

export function useBillDueDatesQuery(billUuid: string | null) {
  return useQuery({
    queryKey: billKeys.dueDates(billUuid ?? ''),
    queryFn: () => getBillDueDates(billUuid as string),
    enabled: !!billUuid,
  });
}

/** Every change to a payment moves a month's status, its totals and the forecast. */
function useBillMutation<T>(mutationFn: (args: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => void qc.invalidateQueries({ queryKey: billKeys.all }) });
}

export function useLinkBillPaymentMutation() {
  return useBillMutation(({ occurrenceUuid, transactionUuid }: { occurrenceUuid: string; transactionUuid: string }) =>
    linkBillPayment(occurrenceUuid, transactionUuid));
}

export function useUnlinkBillPaymentMutation() {
  return useBillMutation(({ occurrenceUuid, transactionUuid }: { occurrenceUuid: string; transactionUuid: string }) =>
    unlinkBillPayment(occurrenceUuid, transactionUuid));
}

export function useResolveBillOccurrenceMutation() {
  return useBillMutation(({ occurrenceUuid, body }: { occurrenceUuid: string; body: ResolveBillOccurrenceInput }) =>
    resolveBillOccurrence(occurrenceUuid, body));
}

export function usePlaceBillPaymentMutation() {
  return useBillMutation(({ billUuid, transactionUuid, dueDate }: { billUuid: string; transactionUuid: string; dueDate: string }) =>
    placeBillPayment(billUuid, transactionUuid, dueDate));
}
