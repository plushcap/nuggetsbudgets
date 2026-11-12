import { exportDateRangeQuery, queryString } from '@nuggets/shared';
import { API_BASE_URL, assertOk, getAuthHeaders } from './base';

export interface ExportParams {
  start_date?: string;
  end_date?: string;
}

/** A CSV download's answer is the file, not JSON: checked, then read as a blob. */
const asBlob = async (response: Response): Promise<Blob> => {
  await assertOk(response);
  return response.blob();
};

// The range's query string comes from the export routes' own query schema.

export const exportTransactions = async (params?: ExportParams): Promise<Blob> =>
  asBlob(
    await fetch(
      `${API_BASE_URL}/export/transactions${queryString(exportDateRangeQuery, { start_date: params?.start_date, end_date: params?.end_date })}`,
      { method: 'GET', headers: getAuthHeaders() }
    )
  );

export const exportAccountTransactions = async (accountUuid: string, params?: ExportParams): Promise<Blob> =>
  asBlob(
    await fetch(
      `${API_BASE_URL}/export/account-transactions/${accountUuid}${queryString(exportDateRangeQuery, { start_date: params?.start_date, end_date: params?.end_date })}`,
      { method: 'GET', headers: getAuthHeaders() }
    )
  );

export const exportBudgetItems = async (): Promise<Blob> =>
  asBlob(await fetch(`${API_BASE_URL}/export/budget-items`, { method: 'GET', headers: getAuthHeaders() }));

export const exportAccounts = async (): Promise<Blob> =>
  asBlob(await fetch(`${API_BASE_URL}/export/accounts`, { method: 'GET', headers: getAuthHeaders() }));

export const exportMerchants = async (): Promise<Blob> =>
  asBlob(await fetch(`${API_BASE_URL}/export/merchants`, { method: 'GET', headers: getAuthHeaders() }));
