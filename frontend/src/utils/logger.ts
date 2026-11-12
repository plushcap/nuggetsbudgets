/**
 * Frontend Pino Logger (browser)
 *
 * Structured logging for the browser, output to the console only.
 */

import pino from 'pino';

/**
 * Pino logger configured for browser environment
 *
 * Usage:
 * logger.info('User logged in');
 * logger.error({ err, transactionId }, 'Transaction failed');
 * logger.warn({ accountId, balance }, 'Low balance detected');
 */
export const logger = pino({
  browser: {
    asObject: true, // Use structured objects instead of strings
  },
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
});
