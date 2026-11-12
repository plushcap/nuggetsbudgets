/**
 * API Tags Module - Tag Operations
 *
 * Handles all tag-related API operations:
 * - CRUD operations for tags
 * - Tag hierarchy management
 *
 * Every answer is parsed with its `@nuggets/shared` schema, and the reports'
 * query strings are built from the routes' own query schemas.
 */

import {
  budgetItemTaggingResponseSchema,
  budgetItemTagsResponseSchema,
  queryString,
  reportRootListResponseSchema,
  tagBreakdownResponseSchema,
  tagDoneResponseSchema,
  tagListResponseSchema,
  tagNamespaceSetResponseSchema,
  tagReportQuery,
  tagReportRootSetResponseSchema,
  tagRowResponseSchema,
  tagSummaryResponseSchema,
  tagTimeSeriesQuery,
  tagTimeSeriesResponseSchema,
  tagTransactionsQuery,
  tagTransactionsResponseSchema,
  tagWithHierarchyResponseSchema,
  transactionTaggingResponseSchema,
  transactionTagsResponseSchema,
  type ReportRoot as SharedReportRoot,
  type TagBreakdownSlice,
  type TagNamespaceSetResponse,
  type TagReportFlowMeasure,
  type TagReportRootSet,
  type TagSummary,
  type TagTimeSeriesBucket,
  type TagTransactionsResponse,
  type tagReportRootSchema,
  type tagWriteSchema,
} from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import type { RequestBody, Tag } from './types';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/** Summary stats for a tag (income/expense totals, counts): tagSummaryResponseSchema. */
export const getTagSummary = async (uuid: string): Promise<TagSummary> => {
  const response = await fetch(`${API_BASE_URL}/tags/${uuid}/summary`, { headers: getAuthHeaders() });
  return parseAnswer(tagSummaryResponseSchema, await handleResponse<unknown>(response), 'tag summary');
};

/** Transactions for a tag (optionally windowed/paginated): rows of the shared transaction list. */
export const getTagTransactions = async (
  uuid: string,
  params?: { start_date?: string | undefined; limit?: number | undefined; offset?: number | undefined },
): Promise<TagTransactionsResponse> => {
  const q = queryString(tagTransactionsQuery, { start_date: params?.start_date, limit: params?.limit, offset: params?.offset });
  const response = await fetch(`${API_BASE_URL}/tags/${uuid}/transactions${q}`, { headers: getAuthHeaders() });
  return parseAnswer(tagTransactionsResponseSchema, await handleResponse<unknown>(response), 'tag transactions');
};

/** One aggregated received/spent bucket of a tag's transaction time series (amounts as numbers). */
export type TagTimeseriesBucket = TagTimeSeriesBucket;

/**
 * Server-aggregated received/spent time series for a tag's transactions,
 * bucketed by day/week/month — replaces fetching thousands of raw rows just to
 * bucket them in the browser.
 */
export const getTagTimeseries = async (
  uuid: string,
  params?: { start_date?: string | undefined; bucket?: 'day' | 'week' | 'month' | undefined },
): Promise<{ bucket: string; series: TagTimeseriesBucket[] }> => {
  const q = queryString(tagTimeSeriesQuery, { start_date: params?.start_date, bucket: params?.bucket });
  const response = await fetch(`${API_BASE_URL}/tags/${uuid}/timeseries${q}`, { headers: getAuthHeaders() });
  return parseAnswer(tagTimeSeriesResponseSchema, await handleResponse<unknown>(response), 'tag time series');
};

/** Sub-tag spending breakdown for a tag (for the pie chart). */
export const getTagBreakdown = async (
  uuid: string,
  params?: { start_date?: string | undefined },
): Promise<{ breakdown: TagBreakdownSlice[] }> => {
  const q = queryString(tagReportQuery, { start_date: params?.start_date });
  const response = await fetch(`${API_BASE_URL}/tags/${uuid}/breakdown${q}`, { headers: getAuthHeaders() });
  return parseAnswer(tagBreakdownResponseSchema, await handleResponse<unknown>(response), 'tag breakdown');
};

/**
 * POST /api/tags and PUT /api/tags/:uuid body (tagWriteSchema), and the parent (by id; null
 * for a top-level tag), which the schema passes to the tag service.
 */
export type TagWriteBody = RequestBody<typeof tagWriteSchema> & { parent_id?: number | null | undefined };

/**
 * Get all tags
 *
 * @returns Array of all tags with hierarchy information
 */
export const getTags = async (): Promise<Tag[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(tagListResponseSchema, await handleResponse<unknown>(response), 'tags');
  } catch (error) {
    logger.error({ err: error, endpoint: '/tags' }, 'Failed to fetch tags');
    throw error;
  }
};

/**
 * Get a single tag by UUID
 *
 * @param uuid - Tag UUID
 * @returns Tag with hierarchy information
 */
export const getTag = async (uuid: string): Promise<Tag> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/${uuid}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(tagWithHierarchyResponseSchema, await handleResponse<unknown>(response), 'tag');
  } catch (error) {
    logger.error({ err: error, tagUuid: uuid, endpoint: `/tags/${uuid}` }, 'Failed to fetch tag');
    throw error;
  }
};

/**
 * Get the tags applied to a transaction.
 *
 * @param transactionUuid - Transaction UUID
 * @returns The tags applied to the transaction (empty array if none / on error)
 */
export const getTransactionTags = async (transactionUuid: string): Promise<Tag[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/transaction/${transactionUuid}`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(transactionTagsResponseSchema, await handleResponse<unknown>(response), 'transaction tags');
  } catch (error) {
    logger.error({ err: error, transactionUuid }, 'Failed to fetch transaction tags');
    return [];
  }
};

/**
 * Create a new tag
 *
 * @param tagData - Tag data (name, color, icon, parent_id, etc.)
 * @returns Newly created tag (its own columns)
 */
export const createTag = async (tagData: TagWriteBody): Promise<Tag> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(tagData),
    });
    return parseAnswer(tagRowResponseSchema, await handleResponse<unknown>(response), 'tag');
  } catch (error) {
    logger.error({ err: error, endpoint: '/tags' }, 'Failed to create tag');
    throw error;
  }
};

/**
 * Update a tag
 *
 * @param uuid - Tag UUID
 * @param tagData - The whole tag (a parent not sent keeps the current one)
 * @returns Updated tag (its own columns)
 */
export const updateTag = async (uuid: string, tagData: TagWriteBody): Promise<Tag> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/${uuid}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(tagData),
    });
    return parseAnswer(tagRowResponseSchema, await handleResponse<unknown>(response), 'tag');
  } catch (error) {
    logger.error({ err: error, tagUuid: uuid, endpoint: `/tags/${uuid}` }, 'Failed to update tag');
    throw error;
  }
};

/**
 * Delete a tag
 *
 * @param uuid - Tag UUID
 */
export const deleteTag = async (uuid: string): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/${uuid}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    parseAnswer(tagDoneResponseSchema, await handleResponse<unknown>(response), 'deleted tag');
  } catch (error) {
    logger.error({ err: error, tagUuid: uuid, endpoint: `/tags/${uuid}` }, 'Failed to delete tag');
    throw error;
  }
};

// ==================== BUDGET ITEM TAG OPERATIONS ====================

/**
 * Get tags for a specific budget item
 *
 * @param budgetItemUuid - Budget item UUID
 * @returns Array of tags associated with the budget item, each with its report namespace
 */
export const getBudgetItemTags = async (budgetItemUuid: string): Promise<Tag[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/budget-items/${budgetItemUuid}/tags`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(budgetItemTagsResponseSchema, await handleResponse<unknown>(response), 'budget item tags');
  } catch (error) {
    logger.error({ err: error, budgetItemUuid, endpoint: `/tags/budget-items/${budgetItemUuid}/tags` }, 'Failed to fetch budget item tags');
    throw error;
  }
};

/**
 * Add a tag to a budget item
 *
 * @param budgetItemUuid - Budget item UUID
 * @param tagId - Tag ID to add
 * @returns Response with success message
 */
export const addTagToBudgetItem = async (budgetItemUuid: string, tagId: number): Promise<{ success: boolean; message: string }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/budget-items/${budgetItemUuid}/tags`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ tag_id: tagId }),
    });
    return parseAnswer(budgetItemTaggingResponseSchema, await handleResponse<unknown>(response), 'budget item tagging');
  } catch (error) {
    logger.error({ err: error, budgetItemUuid, tagId, endpoint: `/tags/budget-items/${budgetItemUuid}/tags` }, 'Failed to add tag to budget item');
    throw error;
  }
};

/**
 * Remove a tag from a budget item
 *
 * @param budgetItemUuid - Budget item UUID
 * @param tagId - Tag ID to remove
 * @returns Response with success message
 */
export const removeTagFromBudgetItem = async (budgetItemUuid: string, tagId: number): Promise<{ success: boolean; message: string }> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/budget-items/${budgetItemUuid}/tags/${tagId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return parseAnswer(tagDoneResponseSchema, await handleResponse<unknown>(response), 'budget item untagged');
  } catch (error) {
    logger.error({ err: error, budgetItemUuid, tagId, endpoint: `/tags/budget-items/${budgetItemUuid}/tags/${tagId}` }, 'Failed to remove tag from budget item');
    throw error;
  }
};

/**
 * Apply a tag to a transaction by tag id.
 *
 * Distinct from {@link applyTagToTransaction}, which uses the
 * `/transactions/{uuid}/tags/{tagUuid}` (tag-uuid) endpoint. The transaction
 * detail tag editor works in terms of numeric tag ids, so it targets the
 * `/tags/transaction/{uuid}` (tag-id) endpoint instead.
 *
 * @param transactionUuid - Transaction UUID
 * @param tagId - Tag ID to add
 */
export const addTransactionTag = async (transactionUuid: string, tagId: number): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/transaction/${transactionUuid}`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ tag_id: tagId }),
    });
    parseAnswer(transactionTaggingResponseSchema, await handleResponse<unknown>(response), 'transaction tagging');
  } catch (error) {
    logger.error({ err: error, transactionUuid, tagId, endpoint: `/tags/transaction/${transactionUuid}` }, 'Failed to add tag to transaction');
    throw error;
  }
};

/**
 * Remove a tag from a transaction by tag id.
 *
 * @param transactionUuid - Transaction UUID
 * @param tagId - Tag ID to remove
 */
export const removeTransactionTag = async (transactionUuid: string, tagId: number): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/transaction/${transactionUuid}/tag/${tagId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    parseAnswer(tagDoneResponseSchema, await handleResponse<unknown>(response), 'transaction untagged');
  } catch (error) {
    logger.error({ err: error, transactionUuid, tagId, endpoint: `/tags/transaction/${transactionUuid}/tag/${tagId}` }, 'Failed to remove tag from transaction');
    throw error;
  }
};

// ==================== REPORT NAMESPACE OPERATIONS ====================

/** tags.report_flow_measure's values (@nuggets/shared). */
export type ReportFlowMeasure = TagReportFlowMeasure;

/** A report namespace: reportRootResponseSchema. */
export type ReportRoot = SharedReportRoot;

/**
 * List all report-namespace tags (is_report_root = true).
 */
export const getReportRoots = async (): Promise<ReportRoot[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/report-roots`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(reportRootListResponseSchema, await handleResponse<unknown>(response), 'report roots');
  } catch (error) {
    logger.error({ err: error, endpoint: '/tags/report-roots' }, 'Failed to fetch report roots');
    throw error;
  }
};

/**
 * Mark or unmark a top-level tag as a report namespace root.
 * Optionally set its `report_flow_measure`.
 */
export const updateTagReportRoot = async (
  uuid: string,
  payload: RequestBody<typeof tagReportRootSchema>
): Promise<TagReportRootSet> => {
  try {
    const response = await fetch(`${API_BASE_URL}/tags/${uuid}/report-root`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(payload),
    });
    return parseAnswer(tagReportRootSetResponseSchema, await handleResponse<unknown>(response), 'tag report root');
  } catch (error) {
    logger.error({ err: error, tagUuid: uuid, payload, endpoint: `/tags/${uuid}/report-root` }, 'Failed to update tag report-root');
    throw error;
  }
};

/**
 * Set or clear the namespace-scoped tag for a budget item.
 * Pass `tag_uuid: null` to clear the current namespace tagging.
 * The provided tag must descend from the given report root.
 *
 * On 409 NAMESPACE_CONFLICT, the response body includes `existing_tag`
 * with `{ uuid, name, hierarchy_path }`.
 */
export const setBudgetItemNamespaceTag = async (
  budgetItemUuid: string,
  rootTagUuid: string,
  tagUuid: string | null
): Promise<TagNamespaceSetResponse> => {
  try {
    const response = await fetch(
      `${API_BASE_URL}/tags/budget-items/${budgetItemUuid}/namespace/${rootTagUuid}`,
      {
        method: 'PUT',
        headers: getAuthHeaders(),
        body: JSON.stringify({ tag_uuid: tagUuid }),
      }
    );
    return parseAnswer(tagNamespaceSetResponseSchema, await handleResponse<unknown>(response), 'namespace tag');
  } catch (error) {
    logger.error(
      { err: error, budgetItemUuid, rootTagUuid, tagUuid, endpoint: `/tags/budget-items/${budgetItemUuid}/namespace/${rootTagUuid}` },
      'Failed to set budget item namespace tag'
    );
    throw error;
  }
};
