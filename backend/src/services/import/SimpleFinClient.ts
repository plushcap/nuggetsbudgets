/**
 * The SimpleFin HTTP client: one ledger's access URL, the request for its accounts behind
 * a circuit breaker per ledger, and the connection test. It only talks to
 * SimpleFin; it never opens a tenant transaction, so nothing waits on SimpleFin with a
 * pooled connection held. The access URL is read from the active tenant's scope
 * (runInTenantScope or a request), decrypted by OrganizationSimpleFinService.
 */
import { getCurrentTenantId } from '../../context/requestContext.js';
import { getAccessUrlForTenant } from '../OrganizationSimpleFinService.js';
import { circuitBreakerService } from '../CircuitBreakerService.js';
import { createLogger } from '../../utils/logger.js';
import { simplefinRequest, SimpleFinUrlError } from '../../utils/simplefinHttp.js';
import { NoSimpleFinConnectionError, SimpleFinUpstreamError } from './errors.js';
import { readTenantSetting } from '../tenantSettings.js';
import type { SimpleFinProtocolError } from '@nuggets/shared';
import { simplefinErrorCodes } from '../../utils/logSafeErrors.js';
import type { ImportSyncOptions, SimplefinAccountSet } from './types.js';

/**
 * The circuit breaker for one ledger's SimpleFin requests. One breaker for every
 * organization let a few failing requests from one family (say, one with no
 * connection) turn away every other family's for 30 seconds.
 */
export function simplefinBreakerName(tenantId: number | null | undefined): string {
  return `simplefin-fetch-accounts:${tenantId ?? 'none'}`;
}

export class SimpleFinClient {
  private logger = createLogger({ service: 'ImportService' });

  /**
   * Resolve the SimpleFin access URL for the current sync context.
   *
   * The credential is the active tenant's ORGANIZATION connection, stored
   * AES-256-GCM-encrypted and decrypted in-process. A sync fetches in its
   * tenant's scope (runInTenantScope, no transaction open), and a route in the
   * request's, so getCurrentTenantId() identifies which org's connection to use.
   * There is no deployment-wide
   * fallback: connect via the org connection endpoint (Settings → Bank Import).
   */
  private async getAccessUrl(): Promise<string> {
    const tenantId = getCurrentTenantId();
    if (tenantId != null) {
      const orgUrl = await getAccessUrlForTenant(tenantId);
      if (orgUrl) return orgUrl;
    }
    throw new NoSimpleFinConnectionError();
  }

  /**
   * Get the import start date based on the days_back setting
   * Calculates the date as: today - X days
   * @returns Date object representing the oldest date to import, or null for all history
   */
  async getImportStartDate(): Promise<Date | null> {
    try {
      // The ledger's own setting (tenant_settings).
      const daysBackSetting = await readTenantSetting('import_days_back');

      // If no setting or empty value, return null (import all history)
      if (!daysBackSetting) {
        this.logger.info('No import_days_back setting found, importing all available history');
        return null;
      }

      const daysBack = parseInt(daysBackSetting, 10);

      // Validate the days value
      if (isNaN(daysBack) || daysBack < 1 || daysBack > 180) {
        this.logger.warn({
          invalidValue: daysBackSetting,
          defaultUsed: 60
        }, 'Invalid import_days_back value, using default 60 days');
        const defaultDaysBack = 60;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - defaultDaysBack);
        startDate.setHours(0, 0, 0, 0); // Start of day
        return startDate;
      }

      // Calculate start date: today - daysBack
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysBack);
      startDate.setHours(0, 0, 0, 0); // Start of day

      this.logger.info({
        startDate: startDate.toISOString(),
        daysBack
      }, 'Import will fetch transactions from date');
      return startDate;
    } catch (error) {
      this.logger.error({ err: error }, 'Error getting import start date');
      return null;
    }
  }

  async fetchAccounts(options: ImportSyncOptions = {}): Promise<SimplefinAccountSet> {
    // Wrap the actual fetch logic in a circuit breaker
    const breaker = circuitBreakerService.getBreaker(
      simplefinBreakerName(getCurrentTenantId()),
      async (opts: ImportSyncOptions) => this.fetchAccountsInternal(opts),
      {
        // Setup problems on this side aren't SimpleFin failing.
        errorFilter: (err) => err instanceof NoSimpleFinConnectionError || err instanceof SimpleFinUrlError,
        timeout: 65000, // 65 seconds (slightly more than internal fetch timeout)
        errorThresholdPercentage: 50, // Open after 50% failures
        resetTimeout: 30000, // Try to recover after 30 seconds
        volumeThreshold: 3, // Need at least 3 requests before opening circuit
        name: 'SimpleFin API'
      }
    );

    try {
      return await breaker.fire(options);
    } catch (error) {
      // Check if circuit is open
      if (error instanceof Error && error.message.includes('Breaker is open')) {
        this.logger.error(
          'SimpleFin API circuit breaker is OPEN - too many recent failures. Please wait before retrying.'
        );
        throw new SimpleFinUpstreamError(
          503,
          'SIMPLEFIN_UNAVAILABLE',
          'SimpleFin service is currently unavailable due to repeated failures. Please try again in 30 seconds.',
          { cause: error }
        );
      }
      throw error;
    }
  }

  /**
   * Internal method that performs the actual SimpleFin API fetch
   * Wrapped by circuit breaker in fetchAccounts()
   */
  private async fetchAccountsInternal(options: ImportSyncOptions = {}): Promise<SimplefinAccountSet> {
    const accessUrl = await this.getAccessUrl();

    // Parse the URL to extract credentials and clean base URL
    const urlObj = new URL(accessUrl);
    const username = urlObj.username;
    const password = urlObj.password;

    // Remove credentials from URL
    urlObj.username = '';
    urlObj.password = '';
    const baseUrl = `${urlObj.toString()}/accounts`;

    // Build query parameters
    const params = new URLSearchParams();

    // The answer carries the start it was asked for (requestedStartDate).
    let requestedStartDate: Date | null = null;
    if (options.startDate) {
      requestedStartDate = options.startDate;
      params.append('start-date', Math.floor(options.startDate.getTime() / 1000).toString());
    } else {
      // Use system setting for start date
      const startDate = await this.getImportStartDate();
      if (startDate) {
        requestedStartDate = startDate;
        params.append('start-date', Math.floor(startDate.getTime() / 1000).toString());
      }
    }

    if (options.endDate) {
      params.append('end-date', Math.floor(options.endDate.getTime() / 1000).toString());
    }

    if (options.includePending) {
      params.append('pending', '1');
    }

    if (options.balancesOnly) {
      params.append('balances-only', '1');
    }

    if (options.accountId) {
      params.append('account', options.accountId);
    }

    // SimpleFIN Protocol v2: structured `errlist` errors + `connections`. All
    // requests are v2 — we never depend on the deprecated v1 errors.
    params.append('version', '2');

    // Request specific fields including available-balance
    // According to SimpleFin protocol, we need to explicitly request optional fields
    params.append('fields', 'balance,available-balance,balance-date');

    const url = params.toString() ? `${baseUrl}?${params.toString()}` : baseUrl;

    // Create Authorization header
    const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    const startTime = Date.now();

    try {
      // Only to an allowed SimpleFin host, with no redirects, a 60 s timeout and a
      // size cap (simplefinHttp).
      const response = await simplefinRequest(url, {
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        timeoutMs: 60_000,
        maxBytes: 50 * 1024 * 1024,
      });

      const responseTime = Date.now() - startTime;

      if (response.status === 403) {
        throw new SimpleFinUpstreamError(502, 'SIMPLEFIN_ACCESS_DENIED', 'Access denied. SimpleFin token may have been revoked or expired.');
      }

      if (!response.ok) {
        throw new SimpleFinUpstreamError(502, 'SIMPLEFIN_ERROR', `SimpleFin answered HTTP ${response.status}`);
      }

      let data: SimplefinAccountSet;
      try {
        data = JSON.parse(response.text) as SimplefinAccountSet;
      } catch {
        throw new SimpleFinUpstreamError(502, 'SIMPLEFIN_BAD_RESPONSE', 'SimpleFin answered with something other than JSON');
      }

      // Normalize errors to v2 `errlist`: prefer structured errors; fold any
      // legacy v1 strings into the same shape so nothing is lost mid-migration.
      const errlist: SimpleFinProtocolError[] = data.errlist
        ?? (data.errors ?? []).map((msg) => ({ code: 'gen.', msg }));
      data.errlist = errlist;

      // SimpleFIN errors flow to the ERROR log, with structure: their codes
      // and ids, not their text, which may name the bank's accounts.
      if (errlist.length > 0) {
        this.logger.error({ simplefinErrors: simplefinErrorCodes(errlist) }, 'SimpleFin returned errors');
      }

      // Log API response time for monitoring
      // SimpleFin API request completed

      // Enhanced debugging for account sync
      this.logger.info({
        accountCount: data.accounts.length,
        responseTimeMs: responseTime,
        // Ids and counts: not the accounts' names or balances.
        accounts: data.accounts.map(acc => ({
          id: acc.id,
          transactionCount: acc.transactions?.length || 0,
          hasTransactions: !!acc.transactions
        }))
      }, 'SimpleFin accounts fetched');

      data.requestedStartDate = requestedStartDate;
      return data;
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.logger.error('SimpleFin API request timed out after 60 seconds');
        throw new SimpleFinUpstreamError(504, 'SIMPLEFIN_TIMEOUT', 'Connection timeout: SimpleFin API took too long to respond', { cause: error });
      }
      this.logger.error({ err: error }, 'Error fetching accounts from SimpleFin');
      throw error;
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      this.logger.info('Testing SimpleFin connection');

      // Get the access URL
      const accessUrl = await this.getAccessUrl();
      if (!accessUrl) {
        this.logger.info('Connection test failed: No access URL configured');
        return false;
      }

      // Use the /info endpoint for connection testing - it's simple and lightweight
      const url = new URL(accessUrl);

      // Extract credentials from URL and remove them
      const username = url.username;
      const password = url.password;
      url.username = '';
      url.password = '';

      // Add /info to the path for server version check
      url.pathname = url.pathname.replace(/\/$/, '') + '/info';

      const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

      this.logger.info('Testing SimpleFin /info endpoint');
      const startTime = Date.now();

      // Short timeout for a connection test; only to an allowed SimpleFin host.
      const response = await simplefinRequest(url, {
        method: 'GET',
        headers: {
          'Authorization': authHeader,
          'User-Agent': 'Nuggets-Finance-App/1.0'
        },
        timeoutMs: 5000,
        maxBytes: 64 * 1024,
      });

      const responseTime = Date.now() - startTime;
      // Connection test completed

      if (!response.ok) {
        this.logger.info({ statusCode: response.status }, 'Connection test failed');
        return false;
      }

      // Parse the JSON response to verify it contains version info
      let data: unknown;
      try {
        data = JSON.parse(response.text);
      } catch {
        data = null;
      }
      const versions = typeof data === 'object' && data !== null && 'versions' in data ? data.versions : undefined;
      const success = Array.isArray(versions);

      this.logger.info({
        success,
        responseTime
      }, `Connection test result: ${success ? 'SUCCESS' : 'FAILED'}`);
      if (success && versions) {
        this.logger.info({
          versions
        }, 'SimpleFin server versions');
      }

      return Boolean(success);

    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.logger.error('Connection test timed out after 5 seconds');
      } else {
        this.logger.error({ err: error }, 'Connection test failed with exception');
      }
      return false;
    }
  }
}
