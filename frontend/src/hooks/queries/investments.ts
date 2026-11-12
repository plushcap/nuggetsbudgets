import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getSecurities,
  createSecurity,
  getHoldings,
  getLots,
  recordBuy,
  recordSell,
  recordDividend,
  getRealizedGainLoss,
  getLookthrough,
  getCostOfOwnership,
  getFeesSummary,
  getWashSales,
  getDataFreshness,
  getFundComposition,
  upsertComposition,
  getSecuritiesPaginated,
  getUnusedPassThroughSecurities,
  deleteUnusedPassThroughSecurities,
  type SecuritiesPageParams,
  getUnderlyingHoldings,
  getUnderlyingExposure,
  getHoldingEvents,
  getSellTaxImpact,
  getTaxLossHarvest,
  getConcentration,
  type SellTaxImpactParams,
  getSecurity,
  updateSecurity,
  upsertPrice,
  recordFee,
  applySplit,
  applyReturnOfCapital,
  applySpinoff,
  applyMergerCash,
  applyMergerStock,
  getDividendHistory,
  getPerformance,
  getReconciliation,
  getValueSeries,
  setCostBasisMethod,
  type HoldingEventsFilters,
} from '../../services/api/investments';
import type { SecurityUpdateInput } from '@nuggets/shared';
import { investmentKeys, accountKeys, netWorthKeys, dashboardKeys } from './keys';
import { useKeepPreviousLedgerData } from './invalidation';

export function useSecuritiesPaginatedQuery(params: SecuritiesPageParams) {
  const keepPreviousPage = useKeepPreviousLedgerData<Awaited<ReturnType<typeof getSecuritiesPaginated>>>();
  return useQuery({
    queryKey: investmentKeys.securitiesPaginated(params as Record<string, unknown>),
    queryFn: () => getSecuritiesPaginated(params),
    placeholderData: keepPreviousPage, // keep the current page visible while the next loads / search debounces
  });
}
export function useUnusedPassThroughQuery() {
  return useQuery({ queryKey: investmentKeys.unusedPassThrough(), queryFn: () => getUnusedPassThroughSecurities() });
}
export function useDeleteUnusedPassThroughMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteUnusedPassThroughSecurities,
    onSuccess: () => void qc.invalidateQueries({ queryKey: investmentKeys.all }),
  });
}
export function useSecuritiesQuery(includeInactive = false) {
  return useQuery({ queryKey: investmentKeys.securities(includeInactive), queryFn: () => getSecurities(includeInactive) });
}
export function useHoldingsQuery(accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.holdings(accountUuid), queryFn: () => getHoldings(accountUuid) });
}
export function useLotsQuery(securityUuid: string | undefined, accountUuid?: string) {
  return useQuery({
    queryKey: investmentKeys.lots(securityUuid ?? '', accountUuid),
    queryFn: () => getLots(securityUuid as string, accountUuid),
    enabled: !!securityUuid,
  });
}
export function useRealizedGainLossQuery(accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.realized(accountUuid), queryFn: () => getRealizedGainLoss(accountUuid) });
}
export function useLookthroughQuery(dimension: string, accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.lookthrough(dimension, accountUuid), queryFn: () => getLookthrough(dimension, accountUuid) });
}
export function useCostOfOwnershipQuery(accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.costOfOwnership(accountUuid), queryFn: () => getCostOfOwnership(accountUuid) });
}
export function useFeesSummaryQuery(accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.fees(accountUuid), queryFn: () => getFeesSummary(accountUuid) });
}
export function useWashSalesQuery() {
  return useQuery({ queryKey: investmentKeys.washSales(), queryFn: () => getWashSales() });
}
export function useDataFreshnessQuery() {
  return useQuery({ queryKey: investmentKeys.freshness(), queryFn: () => getDataFreshness() });
}
export function useHoldingEventsQuery(filters: HoldingEventsFilters = {}) {
  return useQuery({ queryKey: investmentKeys.events(filters as Record<string, unknown>), queryFn: () => getHoldingEvents(filters) });
}
export function useSellTaxImpactQuery(params: SellTaxImpactParams | null) {
  return useQuery({
    queryKey: [...investmentKeys.all, 'sellTaxImpact', params],
    queryFn: () => getSellTaxImpact(params as SellTaxImpactParams),
    enabled: !!params,
  });
}
export function useTaxLossHarvestQuery(account?: string) {
  return useQuery({ queryKey: [...investmentKeys.all, 'tlh', account ?? null], queryFn: () => getTaxLossHarvest(account) });
}
export function useConcentrationQuery(threshold = 10) {
  return useQuery({ queryKey: [...investmentKeys.all, 'concentration', threshold], queryFn: () => getConcentration(threshold) });
}
export function useSecurityQuery(uuid: string | undefined) {
  return useQuery({ queryKey: [...investmentKeys.all, 'security', uuid ?? ''], queryFn: () => getSecurity(uuid as string), enabled: !!uuid });
}
export function useFundCompositionQuery(securityUuid: string | undefined) {
  return useQuery({
    queryKey: investmentKeys.composition(securityUuid ?? ''),
    queryFn: () => getFundComposition(securityUuid as string),
    enabled: !!securityUuid,
  });
}
export function useUpsertCompositionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertComposition,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: investmentKeys.composition(vars.security_uuid) });
      // Look-through reports across every dimension depend on composition.
      void qc.invalidateQueries({ queryKey: investmentKeys.all });
    },
  });
}
export function useUnderlyingHoldingsQuery(securityUuid: string | undefined) {
  return useQuery({
    queryKey: investmentKeys.underlyingHoldings(securityUuid ?? ''),
    queryFn: () => getUnderlyingHoldings(securityUuid as string),
    enabled: !!securityUuid,
  });
}
export function useUnderlyingExposureQuery(accountUuid?: string) {
  return useQuery({ queryKey: investmentKeys.underlyingExposure(accountUuid), queryFn: () => getUnderlyingExposure(accountUuid) });
}

export function useCreateSecurityMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: createSecurity, onSuccess: () => void qc.invalidateQueries({ queryKey: investmentKeys.all }) });
}

// Trades change holdings, the account's calculated balance and so net worth.
function invalidateTrade(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: investmentKeys.all });
  void qc.invalidateQueries({ queryKey: accountKeys.all });
  void qc.invalidateQueries({ queryKey: netWorthKeys.all });
  void qc.invalidateQueries({ queryKey: dashboardKeys.all });
}
export function useRecordBuyMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: recordBuy, onSuccess: () => invalidateTrade(qc) });
}
export function useRecordSellMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: recordSell, onSuccess: () => invalidateTrade(qc) });
}
export function useRecordDividendMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: recordDividend, onSuccess: () => invalidateTrade(qc) });
}
export function useUpdateSecurityMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ uuid, data }: { uuid: string; data: SecurityUpdateInput }) => updateSecurity(uuid, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: investmentKeys.all }),
  });
}
export function useUpsertPriceMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: upsertPrice, onSuccess: () => invalidateTrade(qc) });
}
export function useRecordFeeMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: recordFee, onSuccess: () => invalidateTrade(qc) });
}
export function useApplySplitMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: applySplit, onSuccess: () => invalidateTrade(qc) });
}
export function useApplyReturnOfCapitalMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: applyReturnOfCapital, onSuccess: () => invalidateTrade(qc) });
}
export function useApplySpinoffMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: applySpinoff, onSuccess: () => invalidateTrade(qc) });
}
export function useApplyMergerCashMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: applyMergerCash, onSuccess: () => invalidateTrade(qc) });
}
export function useApplyMergerStockMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: applyMergerStock, onSuccess: () => invalidateTrade(qc) });
}
export function useDividendHistoryQuery(account?: string) {
  return useQuery({ queryKey: [...investmentKeys.all, 'dividends', account ?? null], queryFn: () => getDividendHistory(account) });
}
export function usePerformanceQuery(account?: string) {
  return useQuery({ queryKey: [...investmentKeys.all, 'performance', account ?? null], queryFn: () => getPerformance(account) });
}
export function useReconciliationQuery() {
  return useQuery({ queryKey: [...investmentKeys.all, 'reconciliation'], queryFn: () => getReconciliation() });
}
export function useValueSeriesQuery(startDate?: string) {
  return useQuery({ queryKey: [...investmentKeys.all, 'valueSeries', startDate ?? null], queryFn: () => getValueSeries(startDate) });
}
export function useSetCostBasisMethodMutation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: setCostBasisMethod, onSuccess: () => void qc.invalidateQueries({ queryKey: investmentKeys.all }) });
}
