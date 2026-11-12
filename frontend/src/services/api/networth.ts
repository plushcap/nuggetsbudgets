/**
 * API Net Worth Module - Net Worth Tracking Operations
 * 
 * Handles all net worth-related API operations:
 * - Current net worth snapshot
 * - Historical net worth data
 * - Trend analysis
 * - Snapshot management
 * - Data aggregation
 */

import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import {
  currentNetWorthAnswerSchema,
  netWorthHistoryAnswerSchema,
  type CurrentNetWorthResponse as CurrentNetWorthSnapshot,
  type NetWorthHistoryAnswer,
  type NetWorthSnapshotResponse,
} from '@nuggets/shared';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

export type { CurrentNetWorthSnapshot };

/** GET /api/net-worth/current: today's net worth, computed when it is read. */
export interface CurrentNetWorthResponse {
  current_net_worth: CurrentNetWorthSnapshot;
}

/** One point of the history. */
export type NetWorthHistoryPoint = NetWorthSnapshotResponse;

/** GET /api/net-worth/history. */
export type NetWorthHistoryResponse = NetWorthHistoryAnswer;

/**
 * Get current net worth snapshot
 */
export const getCurrentNetWorth = async (): Promise<CurrentNetWorthResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/net-worth/current`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(currentNetWorthAnswerSchema, await handleResponse<unknown>(response), 'net worth');
  } catch (error) {
    logger.error({ err: error, endpoint: '/net-worth/current' }, 'Failed to fetch current net worth');
    throw error;
  }
};

/**
 * Get net worth history for charting
 * @param period - 'day', 'week', 'month', 'year'
 * @param limit - Number of data points to return
 * @param fillGaps - Whether to fill gaps in data
 */
export const getNetWorthHistory = async (
  period: string = 'month', 
  limit: number = 12, 
  fillGaps: boolean = true
): Promise<NetWorthHistoryResponse> => {
  try {
    const response = await fetch(`${API_BASE_URL}/net-worth/history?period=${period}&limit=${limit}&fill_gaps=${fillGaps}`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });
    return parseAnswer(netWorthHistoryAnswerSchema, await handleResponse<unknown>(response), 'net worth history');
  } catch (error) {
    logger.error({ err: error, endpoint: '/net-worth/history' }, 'Failed to fetch net worth history');
    throw error;
  }
};

/**
 * Clear all net worth snapshots (admin only)
 */
export const clearNetWorthSnapshots = async (): Promise<unknown> => {
  try {
    const response = await fetch(`${API_BASE_URL}/net-worth/clear`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    return handleResponse<unknown>(response);
  } catch (error) {
    logger.error({ err: error, endpoint: '/net-worth/clear' }, 'Failed to clear net worth snapshots');
    throw error;
  }
};

/**
 * Rebuild net worth history from account data (admin only)
 * @param months - Number of months to rebuild (default: 12)
 */
/**
 * POST /net-worth/rebuild's answer. The aggregate counts are absent when the
 * snapshots were created but aggregating them failed (then `warning` says so).
 */
export interface NetWorthRebuildResult {
  message: string;
  snapshots_created: number;
  weekly_aggregates?: number;
  monthly_aggregates?: number;
  earliest_date: string;
  latest_date: string;
  total_days: number;
  warning?: string;
}

/**
 * Rebuild the ledger's whole net-worth history, from its first transaction to today. It takes no
 * range: it sent `months`, which the route never read.
 */
export const rebuildNetWorthHistory = async (): Promise<NetWorthRebuildResult> => {
  try {
    const response = await fetch(`${API_BASE_URL}/net-worth/rebuild`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });
    return handleResponse<NetWorthRebuildResult>(response);
  } catch (error) {
    logger.error({ err: error, endpoint: '/net-worth/rebuild' }, 'Failed to rebuild net worth history');
    throw error;
  }
};
