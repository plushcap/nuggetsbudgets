import CircuitBreaker from 'opossum';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'CircuitBreakerService' });

export interface CircuitBreakerOptions {
  timeout?: number; // Time in ms before a request times out (default: 60000)
  errorThresholdPercentage?: number; // Error percentage at which to open circuit (default: 50)
  resetTimeout?: number; // Time in ms to wait before attempting to close circuit (default: 30000)
  rollingCountTimeout?: number; // Time window for error percentage calculation (default: 10000)
  rollingCountBuckets?: number; // Number of buckets for rolling count (default: 10)
  volumeThreshold?: number; // Minimum requests before opening circuit (default: 5)
  name?: string; // Circuit breaker name for logging
  errorFilter?: (err: unknown) => boolean; // True for an error that isn't the service failing (not counted)
}

/**
 * Circuit Breaker Service
 *
 * Implements the circuit breaker pattern to prevent cascading failures when external
 * services (like SimpleFin API) are experiencing issues.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Too many failures, requests are rejected immediately
 * - HALF_OPEN: Testing if service has recovered, limited requests allowed
 *
 * When the circuit is OPEN, it will automatically attempt to HALF_OPEN after resetTimeout.
 * If requests succeed in HALF_OPEN state, circuit returns to CLOSED.
 * If they fail, circuit returns to OPEN.
 */
export class CircuitBreakerService {
  private breakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Create or get a circuit breaker for a specific service/operation
   */
  getBreaker<TArgs extends unknown[], TResult>(
    name: string,
    action: (...args: TArgs) => Promise<TResult>,
    options: CircuitBreakerOptions = {}
  ): CircuitBreaker<TArgs, TResult> {
    // Return existing breaker if already created
    if (this.breakers.has(name)) {
      return this.breakers.get(name) as CircuitBreaker<TArgs, TResult>;
    }

    // Create new circuit breaker
    const breaker = new CircuitBreaker<TArgs, TResult>(action, {
      timeout: options.timeout ?? 60000, // 60 seconds default
      errorThresholdPercentage: options.errorThresholdPercentage ?? 50, // Open after 50% failures
      resetTimeout: options.resetTimeout ?? 30000, // Try to close after 30 seconds
      rollingCountTimeout: options.rollingCountTimeout ?? 10000, // 10 second window
      rollingCountBuckets: options.rollingCountBuckets ?? 10, // 10 buckets (1 second each)
      volumeThreshold: options.volumeThreshold ?? 5, // Need at least 5 requests
      name: options.name ?? name,
      errorFilter: options.errorFilter,
    });

    // Event handlers for monitoring
    breaker.on('open', () => {
      logger.error(
        {
          breakerName: name,
          stats: breaker.stats
        },
        '🔴 Circuit breaker OPENED - too many failures, requests will be rejected'
      );
    });

    breaker.on('halfOpen', () => {
      logger.warn(
        {
          breakerName: name
        },
        '🟡 Circuit breaker HALF-OPEN - testing if service has recovered'
      );
    });

    breaker.on('close', () => {
      logger.info(
        {
          breakerName: name
        },
        '🟢 Circuit breaker CLOSED - service recovered, normal operation resumed'
      );
    });

    breaker.on('success', () => {
      logger.debug(
        {
          breakerName: name,
          stats: {
            failures: breaker.stats.failures,
            successes: breaker.stats.successes,
            rejects: breaker.stats.rejects,
            fires: breaker.stats.fires
          }
        },
        'Circuit breaker request succeeded'
      );
    });

    breaker.on('failure', (error) => {
      logger.warn(
        {
          breakerName: name,
          error: error.message,
          stats: {
            failures: breaker.stats.failures,
            successes: breaker.stats.successes,
            rejects: breaker.stats.rejects,
            fires: breaker.stats.fires
          }
        },
        'Circuit breaker request failed'
      );
    });

    breaker.on('timeout', () => {
      logger.warn(
        {
          breakerName: name,
          timeoutMs: options.timeout ?? 60000
        },
        'Circuit breaker request timed out'
      );
    });

    breaker.on('reject', () => {
      logger.error(
        {
          breakerName: name,
          stats: breaker.stats
        },
        'Circuit breaker REJECTED request - circuit is OPEN'
      );
    });

    breaker.on('fallback', () => {
      logger.info(
        {
          breakerName: name
        },
        'Circuit breaker executed fallback'
      );
    });

    this.breakers.set(name, breaker);
    return breaker;
  }

  /**
   * Clear all circuit breakers
   */
  clearAll(): void {
    this.breakers.clear();
  }
}

// Singleton instance
export const circuitBreakerService = new CircuitBreakerService();
