/**
 * Reports API client.
 */

import { API_BASE_URL, getAuthHeaders, handleResponse } from './base';
import {
  sankeyResponseSchema,
  type SankeyResponse,
  type TagReportFlowMeasure,
} from '@nuggets/shared';
import { parseAnswer } from './parseAnswer';
import { logger } from '../../utils/logger';

/** tags.report_flow_measure's values (@nuggets/shared). */
export type SankeyFlowMeasure = TagReportFlowMeasure;

/** The report and its parts: `@nuggets/shared`'s sankeyResponseSchema. */
export type { SankeyResponse };
export type SankeyNode = SankeyResponse['nodes'][number];
export type SankeyLink = SankeyResponse['links'][number];
export type SankeyDrilldownItem = SankeyResponse['_drilldown'][string][number];

export interface SankeyParams {
  start_date?: string;
  end_date?: string;
  budget_period_uuid?: string;
  direction?: 'lr' | 'rl';
  include_untagged?: boolean;
  include_transfers?: boolean;
  flow_measure_override?: SankeyFlowMeasure;
}

export const getSankeyReport = async (
  rootTagUuid: string,
  params: SankeyParams
): Promise<SankeyResponse> => {
  const qs = new URLSearchParams();
  if (params.start_date) qs.set('start_date', params.start_date);
  if (params.end_date) qs.set('end_date', params.end_date);
  if (params.budget_period_uuid) qs.set('budget_period_uuid', params.budget_period_uuid);
  if (params.direction) qs.set('direction', params.direction);
  if (params.include_untagged !== undefined) qs.set('include_untagged', String(params.include_untagged));
  if (params.include_transfers !== undefined) qs.set('include_transfers', String(params.include_transfers));
  if (params.flow_measure_override) qs.set('flow_measure_override', params.flow_measure_override);

  try {
    const response = await fetch(
      `${API_BASE_URL}/reports/sankey/${rootTagUuid}?${qs.toString()}`,
      { headers: getAuthHeaders() }
    );
    return parseAnswer(sankeyResponseSchema, await handleResponse<unknown>(response), 'Sankey report');
  } catch (error) {
    logger.error(
      { err: error, rootTagUuid, params, endpoint: `/reports/sankey/${rootTagUuid}` },
      'Failed to fetch Sankey report'
    );
    throw error;
  }
};
