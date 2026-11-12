/**
 * API Transactions Module - Transaction Operations
 * 
 * Handles all transaction-related API operations:
 * - CRUD operations for transactions
 * - Pagination and filtering
 * - Bulk operations
 * - Transaction queries with various filter options
 */

import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import type { Patch, RequestBody, Transaction } from './types';
import {
  queryString,
  transactionCreatedResponseSchema,
  transactionDeletedResponseSchema,
  transactionListQuerySchema,
  transactionPageQuerySchema,
  transactionTagDoneResponseSchema,
  transferResponseSchema,
  type TransactionCreatedResponse,
  type TransferResponse,
  type transactionBulkUpdatesSchema,
  type transactionCreateSchema,
  type transactionUpdateSchema,
  transactionBulkEditResponseSchema,
  transactionDetailResponseSchema,
  transactionPageResponseSchema,
  transactionResponseSchema,
  transactionWithSplitsResponseSchema,
  type TransactionBulkEditResponse,
  type TransactionDetail,
  type TransactionPageResponse,
  type TransactionType,
  type TransactionWithSplits,
} from '@nuggets/shared';
import { z } from 'zod';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';


/**
 * Get paginated transactions with flexible filter object
 * 
 * @param page - Page number (default: 1)
 * @param limit - Items per page (default: 20)
 * @param filters - Object containing filter key-value pairs
 * @returns Paginated transaction response
 */
export const getPaginatedTransactionsWithFilters = async (
  page: number = 1,
  limit: number = 20,
  filters: Record<string, string> = {}
): Promise<TransactionPageResponse> => {
  try {
    // The route's own query schema writes and checks the query.
    const query = queryString(transactionPageQuerySchema, { ...filters, page, limit });
    const response = await fetch(`${API_BASE_URL}/transactions/paginated${query}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(transactionPageResponseSchema, await handleResponse<unknown>(response), 'transactions page');
  } catch (error) {
    logger.error({ err: error, endpoint: '/transactions/paginated' }, 'Failed to fetch paginated transactions with filters');
    throw error;
  }
};

/**
 * Get all transactions with filter parameters (unpaginated)
 * 
 * @param filters - Object containing filter key-value pairs
 * @returns Filtered array of transactions
 */
export const getTransactionsWithFilters = async (filters: Record<string, string> = {}): Promise<Transaction[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions${queryString(transactionListQuerySchema, filters)}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(z.array(transactionResponseSchema), await handleResponse<unknown>(response), 'transactions');
  } catch (error) {
    logger.error({ err: error, endpoint: '/transactions' }, 'Failed to fetch transactions with filters');
    throw error;
  }
};

/**
 * Get a single transaction by UUID
 * 
 * @param uuid - Transaction UUID
 * @returns Transaction details, with its splits and their tags
 */
export const getTransaction = async (uuid: string): Promise<TransactionWithSplits> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${uuid}`, {
      headers: getAuthHeaders(),
    });
    // Its splits come with their tags, which re-editing them sends back.
    return parseAnswer(transactionWithSplitsResponseSchema, await handleResponse<unknown>(response), 'transaction');
  } catch (error) {
    logger.error({ err: error, transactionUuid: uuid, endpoint: `/transactions/${uuid}` }, 'Failed to fetch transaction');
    throw error;
  }
};

/**
 * POST /api/transactions body (transactionCreateSchema): the account, amount,
 * date and type, the merchant, period and item by uuid or id, and the transaction's other
 * fields as the route reads them.
 */
export type TransactionCreateBody = RequestBody<typeof transactionCreateSchema> & {
  type: TransactionType;
} & Patch<Pick<Transaction, 'merchant_id' | 'description' | 'budget_period_id' | 'budget_item_id' | 'status' | 'review_status'>>;

/**
 * PUT /api/transactions/:uuid body: transactionUpdateSchema's fields. Text and
 * references take null for none; the amount, type, statuses and date never do, as the route
 * refuses them (400). Other fields go through and are ignored.
 */
export type TransactionEdit = RequestBody<typeof transactionUpdateSchema>;

/** PUT /api/transactions/bulk's `updates`: transactionBulkUpdatesSchema's fields; the statuses are never null. */
export type TransactionBulkEdit = RequestBody<typeof transactionBulkUpdatesSchema>;

/**
 * Create a new transaction
 *
 * @param data - Transaction data
 * @returns Created transaction, with its names (the answer has its uuid, not its id)
 */
export const createTransaction = async (
  data: TransactionCreateBody,
): Promise<TransactionCreatedResponse['transaction']> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseAnswer(transactionCreatedResponseSchema, await handleResponse<unknown>(response), 'created transaction').transaction;
  } catch (error) {
    logger.error({ err: error, endpoint: '/transactions' }, 'Failed to create transaction');
    throw error;
  }
};

/**
 * Update an existing transaction
 * 
 * @param uuid - Transaction UUID
 * @param data - Partial transaction data to update
 * @returns Updated transaction
 */
export const updateTransaction = async (uuid: string, data: TransactionEdit): Promise<TransactionDetail> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${uuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseAnswer(transactionDetailResponseSchema, await handleResponse<unknown>(response), 'transaction');
  } catch (error) {
    logger.error({ err: error, transactionUuid: uuid, endpoint: `/transactions/${uuid}` }, 'Failed to update transaction');
    throw error;
  }
};

/**
 * Delete a transaction
 * 
 * @param uuid - Transaction UUID
 */
export const deleteTransaction = async (uuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    parseAnswer(transactionDeletedResponseSchema, await handleResponse<unknown>(response), 'deleted transaction');
  } catch (error) {
    logger.error({ err: error, transactionUuid: uuid, endpoint: `/transactions/${uuid}` }, 'Failed to delete transaction');
    throw error;
  }
};

/**
 * Update multiple transactions at once
 * 
 * @param transactionUuids - Array of transaction UUIDs to update
 * @param updates - Partial transaction data to apply to all transactions
 * @returns Result with count of updated transactions and updated transaction data
 */
export const bulkUpdateTransactions = async (
  transactionUuids: string[], 
  updates: TransactionBulkEdit
): Promise<TransactionBulkEditResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/bulk`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify({ transactionUuids, updates }),
    });
    {
      return parseAnswer(transactionBulkEditResponseSchema, await handleResponse<unknown>(response), 'bulk edit');
    }
  } catch (error) {
    logger.error({ err: error, endpoint: '/transactions/bulk' }, 'Failed to bulk update transactions');
    throw error;
  }
};

export interface TransferPayload {
  source_account_id: number | null;
  destination_account_id: number | null;
  amount: number;
  transaction_date: string;
  type: Extract<TransactionType, 'payment' | 'transfer'>;
  description: string;
  budget_period_id: number | null;
}

/**
 * Move money between two accounts (payment or transfer). Creates the paired
 * transactions on the backend.
 */
export const createTransfer = async (data: TransferPayload): Promise<TransferResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transfer`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });
    return parseAnswer(transferResponseSchema, await handleResponse<unknown>(response), 'transfer');
  } catch (error) {
    logger.error({ err: error, endpoint: '/transfer' }, 'Failed to create transfer');
    throw error;
  }
};

/**
 * Apply a tag to a transaction
 *
 * @param transactionUuid - Transaction UUID
 * @param tagUuid - Tag UUID to apply
 */
export const applyTagToTransaction = async (transactionUuid: string, tagUuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${transactionUuid}/tags/${tagUuid}`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    parseAnswer(transactionTagDoneResponseSchema, await handleResponse<unknown>(response), 'transaction tag');
  } catch (error) {
    logger.error({ err: error, transactionUuid, tagUuid }, 'Failed to apply tag to transaction');
    throw error;
  }
};

/**
 * Remove a tag from a transaction
 * 
 * @param transactionUuid - Transaction UUID
 * @param tagUuid - Tag UUID to remove
 */
export const removeTagFromTransaction = async (transactionUuid: string, tagUuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${transactionUuid}/tags/${tagUuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    parseAnswer(transactionTagDoneResponseSchema, await handleResponse<unknown>(response), 'transaction tag');
  } catch (error) {
    logger.error({ err: error, transactionUuid, tagUuid }, 'Failed to remove tag from transaction');
    throw error;
  }
};
export interface SplitItem {
  amount: number;
  budget_item_id?: number | null;
  budget_period_id?: number | null;
  budget_period_item_id?: number | null;
  description?: string;
  tag_ids?: number[];
}

/**
 * Split a transaction into multiple budget allocations
 * 
 * @param transactionUuid - Parent transaction UUID
 * @param splits - Array of split items with amounts and budget assignments
 * @returns Updated parent transaction with children
 */
export const splitTransaction = async (
  transactionUuid: string, 
  splits: SplitItem[]
): Promise<Transaction> => {
  try {
    // Log splits before sending to help debug
    logger.debug({ transactionUuid, splits, splitCount: splits.length }, 'Sending split transaction request');
    splits.forEach((split, index) => {
      logger.debug({ 
        index, 
        amount: split.amount, 
        amountType: typeof split.amount,
        budgetItemId: split.budget_item_id,
        tagIds: split.tag_ids 
      }, `Split ${index + 1} details`);
    });

    const response = await fetch(`${API_BASE_URL}/transactions/${transactionUuid}/split`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ splits }),
    });
    return parseAnswer(transactionWithSplitsResponseSchema, await handleResponse<unknown>(response), 'transaction');
  } catch (error) {
    logger.error({ err: error, transactionUuid, splits }, 'Failed to split transaction');
    throw error;
  }
};

/**
 * Unsplit a transaction (remove all child splits and restore parent)
 * 
 * @param transactionUuid - Parent transaction UUID
 * @returns Updated transaction
 */
export const unsplitTransaction = async (transactionUuid: string): Promise<TransactionDetail> => {
  try {
    const response = await fetch(`${API_BASE_URL}/transactions/${transactionUuid}/unsplit`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(transactionDetailResponseSchema, await handleResponse<unknown>(response), 'transaction');
  } catch (error) {
    logger.error({ err: error, transactionUuid }, 'Failed to unsplit transaction');
    throw error;
  }
};