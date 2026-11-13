/**
 * Centralized React Query key factories.
 *
 * One file (not per-domain) because cross-domain invalidation is the norm here and
 * a single import avoids circular deps between domain hook files. Always invalidate
 * with the broadest correct prefix via these factories — never string literals.
 *
 * Mutation → invalidation map (what each domain's mutations must invalidate):
 *   Account CRUD / import settings / image ........ accountKeys.all
 *   Transaction CRUD / split / tag / merge / rule . invalidateTransactionData (invalidation.ts):
 *                                                   transactions, balances, spend and derived totals
 *   Budget amount / transfer / period ............. budgetKeys.all
 *   Budget item (bill/expense/income/goal) CRUD ... budgetKeys.all
 *   Category/Merchant/Tag/Institution CRUD ........ own key + transactionKeys.all (rendered names)
 *   Import run / delete / template change ......... importKeys.all + invalidateTransactionData
 *   Close-out / transfer money / balance maint .... invalidateTransactionData
 *   Account create (opening balance) ............... invalidateTransactionData
 *   Investment trade / corporate action ............ investments + accounts + net worth + dashboard
 *   Settings / profile / users .................... own key only
 */

export const accountKeys = {
  all: ['accounts'] as const,
  lists: () => [...accountKeys.all, 'list'] as const,
  list: (showHidden: boolean) => [...accountKeys.lists(), { showHidden }] as const,
  /** The accounts with their balances at the end of a day (Close-Out's month). */
  listAsOf: (asOf: string) => [...accountKeys.lists(), { showHidden: false, asOf }] as const,
  details: () => [...accountKeys.all, 'detail'] as const,
  detail: (uuid: string) => [...accountKeys.details(), uuid] as const,
  balance: (uuid: string) => [...accountKeys.detail(uuid), 'balance'] as const,
};

export const transactionKeys = {
  all: ['transactions'] as const,
  lists: () => [...transactionKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) => [...transactionKeys.lists(), filters] as const,
  byAccount: (accountUuid: string, params: Record<string, unknown>) =>
    [...transactionKeys.all, 'account', accountUuid, params] as const,
  details: () => [...transactionKeys.all, 'detail'] as const,
  detail: (uuid: string) => [...transactionKeys.details(), uuid] as const,
};

export const budgetKeys = {
  all: ['budgets'] as const,
  periods: () => [...budgetKeys.all, 'periods'] as const,
  periodItems: (periodUuid: string) => [...budgetKeys.all, 'periodItems', periodUuid] as const,
  item: (uuid: string) => [...budgetKeys.all, 'item', uuid] as const,
};

export const categoryKeys = {
  all: ['categories'] as const,
  list: () => [...categoryKeys.all, 'list'] as const,
};

export const merchantKeys = {
  all: ['merchants'] as const,
  list: () => [...merchantKeys.all, 'list'] as const,
  detail: (uuid: string) => [...merchantKeys.all, 'detail', uuid] as const,
};

export const institutionKeys = {
  all: ['institutions'] as const,
  list: () => [...institutionKeys.all, 'list'] as const,
  detail: (uuid: string) => [...institutionKeys.all, 'detail', uuid] as const,
};

export const tagKeys = {
  all: ['tags'] as const,
  list: () => [...tagKeys.all, 'list'] as const,
  detail: (uuid: string) => [...tagKeys.all, 'detail', uuid] as const,
};

export const importKeys = {
  all: ['imports'] as const,
  list: () => [...importKeys.all, 'list'] as const,
  detail: (id: string | number) => [...importKeys.all, 'detail', id] as const,
  templates: () => [...importKeys.all, 'templates'] as const,
};

export const dashboardKeys = {
  all: ['dashboard'] as const,
  netWorth: (params: Record<string, unknown>) => [...dashboardKeys.all, 'netWorth', params] as const,
};

export const goalKeys = {
  all: ['goals'] as const,
  list: () => [...goalKeys.all, 'list'] as const,
  detail: (uuid: string) => [...goalKeys.all, 'detail', uuid] as const,
};

export const netWorthKeys = {
  all: ['netWorth'] as const,
};

export const reportKeys = {
  all: ['reports'] as const,
  sankey: (rootUuid: string | undefined, params: Record<string, unknown>) =>
    [...reportKeys.all, 'sankey', rootUuid ?? null, params] as const,
};

export const settingsKeys = {
  all: ['settings'] as const,
};

export const investmentKeys = {
  all: ['investments'] as const,
  securities: (includeInactive: boolean) => [...investmentKeys.all, 'securities', includeInactive] as const,
  securitiesPaginated: (params: Record<string, unknown>) => [...investmentKeys.all, 'securitiesPaginated', params] as const,
  unusedPassThrough: () => [...investmentKeys.all, 'unusedPassThrough'] as const,
  holdings: (account: string | undefined) => [...investmentKeys.all, 'holdings', account ?? null] as const,
  lots: (securityUuid: string, account: string | undefined) =>
    [...investmentKeys.all, 'lots', securityUuid, account ?? null] as const,
  realized: (account: string | undefined) => [...investmentKeys.all, 'realized', account ?? null] as const,
  lookthrough: (dimension: string, account: string | undefined) =>
    [...investmentKeys.all, 'lookthrough', dimension, account ?? null] as const,
  costOfOwnership: (account: string | undefined) => [...investmentKeys.all, 'coo', account ?? null] as const,
  fees: (account: string | undefined) => [...investmentKeys.all, 'fees', account ?? null] as const,
  washSales: () => [...investmentKeys.all, 'washSales'] as const,
  freshness: () => [...investmentKeys.all, 'freshness'] as const,
  composition: (securityUuid: string) => [...investmentKeys.all, 'composition', securityUuid] as const,
  underlyingHoldings: (securityUuid: string) => [...investmentKeys.all, 'underlyingHoldings', securityUuid] as const,
  underlyingExposure: (account: string | undefined) => [...investmentKeys.all, 'underlyingExposure', account ?? null] as const,
  events: (filters: Record<string, unknown>) => [...investmentKeys.all, 'events', filters] as const,
};

export const userKeys = {
  all: ['users'] as const,
  list: () => [...userKeys.all, 'list'] as const,
};

// Multi-tenant management. `tenantKeys.mine` backs the AuthContext membership
// query (switcher + role gating); switching ledgers resets every other query
// (resetLedgerData in invalidation.ts).
export const tenantKeys = {
  all: ['tenants'] as const,
  mine: () => [...tenantKeys.all, 'mine'] as const,
  current: () => [...tenantKeys.all, 'current'] as const,
  members: () => [...tenantKeys.all, 'members'] as const,
  memberCandidates: () => [...tenantKeys.all, 'memberCandidates'] as const,
};

export const annotationKeys = {
  all: ['annotations'] as const,
  bySubject: (subjectType: string, subjectUuid: string) =>
    [...annotationKeys.all, subjectType, subjectUuid] as const,
  threads: (params: Record<string, unknown>) => [...annotationKeys.all, 'threads', params] as const,
  counts: () => [...annotationKeys.all, 'counts'] as const,
};

export const organizationKeys = {
  all: ['organizations'] as const,
  list: () => [...organizationKeys.all, 'list'] as const,
  detail: (uuid: string) => [...organizationKeys.all, 'detail', uuid] as const,
  members: (uuid: string) => [...organizationKeys.all, 'members', uuid] as const,
  invitations: (uuid: string) => [...organizationKeys.all, 'invitations', uuid] as const,
  simplefin: (uuid: string) => [...organizationKeys.all, 'simplefin', uuid] as const,
  priceSync: (uuid: string) => [...organizationKeys.all, 'priceSync', uuid] as const,
  priceSyncRuns: (uuid: string) => [...organizationKeys.all, 'priceSyncRuns', uuid] as const,
};
