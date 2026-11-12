import { DomainError } from '../domainErrors.js';

/**
 * A refusal of the reports (services/reports/): what a report is about isn't there, or isn't
 * one it can be about. Each answers as GET /api/reports/sankey answered it before the report
 * moved to SankeyReportService: a short `error` heading and the reason in `message`.
 */
export class ReportError extends DomainError {}

/** The namespace root tag the report names isn't in the ledger (RLS hides another ledger's). */
export const reportRootNotFound = (): ReportError =>
  new ReportError(404, 'NOT_FOUND', 'No tag found with the provided rootTagUuid', {}, { heading: 'Report root not found' });

/** The tag is there, but isn't marked as a report namespace root. */
export const notAReportRoot = (): ReportError =>
  new ReportError(400, 'BAD_REQUEST', 'The provided tag is not marked as a report namespace root', {}, { heading: 'Not a report root' });

/** The budget period the report's window names isn't in the ledger. */
export const reportPeriodNotFound = (): ReportError =>
  new ReportError(404, 'NOT_FOUND', 'No budget period with the provided uuid', {}, { heading: 'Budget period not found' });
