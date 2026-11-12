/**
 * Enhanced Health Check System for Nuggets Phase 2
 *
 * This module provides comprehensive health monitoring including
 * security status, database health, and system metrics.
 */

import { Request, Response } from 'express';
import { sql } from 'kysely';
import pool, { db } from '../db.js';
import { validateNuggetsSecurityConfig } from '../utils/security-validator.js';
import { getRecentSecurityEvents } from './security-enhanced.js';
import { createLogger } from '../utils/logger.js';
import { appCommit, appVersion } from '../utils/appVersion.js';
import type { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'HealthChecks' });

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  /** The release the image was built as (utils/appVersion.ts). */
  version: string;
  /** The commit it was built from; only in the deployment admin's detailed report. */
  commit?: string;
  /** NODE_ENV; only in the deployment admin's detailed report. */
  environment?: string;
}

interface DatabaseHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  connectionCount: number;
  responseTime: number;
  lastQuery: string;
}

interface SecurityHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  securityLevel: 'production' | 'basic' | 'insecure';
  recentEvents: number;
  criticalEvents: number;
  validationPassed: boolean;
}

interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  process: {
    pid: number;
    uptime: number;
    nodeVersion: string;
  };
}

/**
 * Whether backups are being made: automatic backups wait for a backup key, and a
 * failing one used to show only in the log. Supplied by ApplicationLifecycleService.
 */
export interface BackupHealth {
  status: 'healthy' | 'degraded';
  automaticBackups: 'on' | 'off' | 'waiting-for-backup-key';
  lastRunOutcome: 'success' | 'failed' | null;
  lastRunFinishedAt: string | null;
  newestBackupAt: string | null;
  nextBackupAt: string | null;
  /** What is wrong, in words; empty when backups are fine. */
  problems: string[];
}

let backupHealthSource: (() => Promise<BackupHealth>) | null = null;

/** Where the detailed health check reads the backup state from (mountRoutes sets it). */
export function setBackupHealthSource(source: (() => Promise<BackupHealth>) | null): void {
  backupHealthSource = source;
}

interface FullHealthReport {
  overall: HealthStatus;
  database: DatabaseHealth;
  security: SecurityHealth;
  system: SystemHealth;
  backups: BackupHealth | null;
  checks: {
    [key: string]: {
      status: 'pass' | 'fail' | 'warn';
      message: string;
      timestamp: string;
    };
  };
}

/**
 * Check database health
 */
async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  try {
    const startTime = Date.now();
    
    // Simple connectivity test. version() is a server function — kept as raw sql.
    const result = await sql<{ current_time: Date; version: string }>`SELECT NOW() as current_time, version() as version`.execute(db);
    const responseTime = Date.now() - startTime;
    
    // Get connection count (approximate)
    const poolInfo = pool.totalCount || 0;
    
    return {
      status: responseTime < 100 ? 'healthy' : responseTime < 500 ? 'degraded' : 'unhealthy',
      connectionCount: poolInfo,
      responseTime,
      lastQuery: result.rows[0]?.current_time?.toISOString() || 'unknown'
    };
  } catch (error) {
    logger.error({ err: error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      connectionCount: 0,
      responseTime: -1,
      lastQuery: 'error'
    };
  }
}

/**
 * Check security health
 */
function checkSecurityHealth(): SecurityHealth {
  try {
    const securityValidation = validateNuggetsSecurityConfig();
    const recentEvents = getRecentSecurityEvents(100);
    
    const criticalEvents = recentEvents.filter(event => 
      event.level === 'critical' || event.level === 'error'
    ).length;

    const recentCriticalEvents = recentEvents.filter(event => 
      (event.level === 'critical' || event.level === 'error') &&
      (Date.now() - event.timestamp.getTime()) < 60 * 60 * 1000 // Last hour
    ).length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (!securityValidation.isValid || securityValidation.summary.overallSecurityLevel === 'insecure') {
      status = 'unhealthy';
    } else if (recentCriticalEvents > 5 || securityValidation.summary.overallSecurityLevel === 'basic') {
      status = 'degraded';
    }

    return {
      status,
      securityLevel: securityValidation.summary.overallSecurityLevel,
      recentEvents: recentEvents.length,
      criticalEvents,
      validationPassed: securityValidation.isValid
    };
  } catch (error) {
    logger.error({ err: error }, 'Security health check failed');
    return {
      status: 'unhealthy',
      securityLevel: 'insecure',
      recentEvents: 0,
      criticalEvents: 0,
      validationPassed: false
    };
  }
}

/**
 * Check system health
 */
function checkSystemHealth(): SystemHealth {
  const memUsage = process.memoryUsage();
  
  // Use RSS (Resident Set Size) as a more meaningful metric
  // RSS represents actual memory usage by the process
  const usedMemoryMB = memUsage.rss / 1024 / 1024; // Convert to MB
  
  // Set reasonable thresholds based on actual memory usage in MB, not percentages
  // Memory issues should be warnings, not hard failures that break the app
  let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  const memoryPercentage = Math.round(usedMemoryMB * 100) / 100; // Store as MB for display
  
  // Memory usage should only cause degraded status, never unhealthy
  if (usedMemoryMB > 512) {  // >512MB = degraded (warning only)
    status = 'degraded';
  }
  // Removed unhealthy threshold - memory issues are warnings only

  return {
    status,
    memory: {
      used: memUsage.rss,
      total: memUsage.heapTotal,
      percentage: memoryPercentage // Now represents MB usage, not percentage
    },
    process: {
      pid: process.pid,
      uptime: process.uptime(),
      nodeVersion: process.version
    }
  };
}

/**
 * Liveness (GET /health, /api/health): the process is up and answering HTTP. It doesn't
 * look at the database, so a restart wouldn't fix what it can't see. Whether the server
 * can serve is readiness, below.
 */
export const basicHealthCheck = (_req: Request, res: Response) => {
  const health: HealthStatus = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: appVersion(),
  };

  res.status(200).json(health);
};

/**
 * Readiness (GET /api/ready): 200 when this server can serve requests, else 503:
 * its background services have started, it isn't shutting down, the database answers
 * within 2 s, and every migration this code ships is applied
 * (ApplicationLifecycleService.readiness). The container healthchecks use it, and so
 * should an uptime check. Public, like liveness, so it says only which
 * check failed, never why.
 */
export function readinessCheck(lifecycle: Pick<ApplicationLifecycleService, 'readiness'>) {
  return async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const { ready, checks } = await lifecycle.readiness();
      res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ err }, 'Readiness check failed');
      res.status(503).json({ status: 'not_ready', timestamp: new Date().toISOString() });
    }
  };
}

/**
 * Detailed health check endpoint - comprehensive system status
 */
export const detailedHealthCheck = async (_req: Request, res: Response) => {
  try {
    const [dbHealth, securityHealth, systemHealth, backupHealth] = await Promise.all([
      checkDatabaseHealth(),
      Promise.resolve(checkSecurityHealth()),
      Promise.resolve(checkSystemHealth()),
      backupHealthSource
        ? backupHealthSource().catch((err: unknown) => {
            logger.warn({ err }, 'Could not read the backup status for the health check');
            return null;
          })
        : Promise.resolve(null),
    ]);

    // Determine overall status
    const components = [dbHealth.status, securityHealth.status, systemHealth.status, ...(backupHealth ? [backupHealth.status] : [])];
    let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    if (components.includes('unhealthy')) {
      overallStatus = 'unhealthy';
    } else if (components.includes('degraded')) {
      overallStatus = 'degraded';
    }

    const healthReport: FullHealthReport = {
      overall: {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: appVersion(),
        commit: appCommit(),
        environment: config().NODE_ENV
      },
      database: dbHealth,
      security: securityHealth,
      system: systemHealth,
      backups: backupHealth,
      checks: {
        ...(backupHealth && {
          backups: {
            status: backupHealth.problems.length === 0 ? ('pass' as const) : ('warn' as const),
            message:
              backupHealth.problems.length === 0
                ? `Newest backup: ${backupHealth.newestBackupAt}`
                : backupHealth.problems.join('; '),
            timestamp: new Date().toISOString(),
          },
        }),
        'database_connectivity': {
          status: dbHealth.status === 'healthy' ? 'pass' : dbHealth.status === 'degraded' ? 'warn' : 'fail',
          message: `Database response time: ${dbHealth.responseTime}ms`,
          timestamp: new Date().toISOString()
        },
        'security_validation': {
          status: securityHealth.validationPassed ? 'pass' : 'fail',
          message: `Security level: ${securityHealth.securityLevel}`,
          timestamp: new Date().toISOString()
        },
        'memory_usage': {
          status: systemHealth.memory.percentage < 512 ? 'pass' : 'warn',
          message: `Memory usage: ${systemHealth.memory.percentage} MB (warning only)`,
          timestamp: new Date().toISOString()
        },
        'security_events': {
          status: securityHealth.criticalEvents === 0 ? 'pass' : securityHealth.criticalEvents < 5 ? 'warn' : 'fail',
          message: `Critical events: ${securityHealth.criticalEvents}`,
          timestamp: new Date().toISOString()
        }
      }
    };

    // Set appropriate HTTP status code
    const statusCode = overallStatus === 'healthy' ? 200 : 
                      overallStatus === 'degraded' ? 200 : 503;

    // Enhanced logging for debugging health check issues
    if (overallStatus !== 'healthy') {
      logger.warn({ 
        statusCode, 
        overallStatus,
        components: {
          database: dbHealth.status,
          security: securityHealth.status,
          system: systemHealth.status
        },
        metrics: {
          dbResponseTime: dbHealth.responseTime,
          memoryUsageMB: systemHealth.memory.percentage,
          criticalEvents: securityHealth.criticalEvents,
          recentEvents: securityHealth.recentEvents,
          securityLevel: securityHealth.securityLevel
        }
      }, 'Health check detected degraded or unhealthy status');
    }

    res.status(statusCode).json(healthReport);
  } catch (error) {
    logger.error({ err: error, uptime: process.uptime() }, 'Health check endpoint failed');
    res.status(503).json({
      overall: {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: appVersion(),
        environment: config().NODE_ENV
      },
      error: 'Health check failed',
      message: 'Internal server error'
    });
  }
};

/**
 * Security-specific health check endpoint
 */
export const securityHealthCheck = (_req: Request, res: Response) => {
  try {
    const securityHealth = checkSecurityHealth();
    const recentEvents = getRecentSecurityEvents(20);
    
    const response = {
      status: securityHealth.status,
      timestamp: new Date().toISOString(),
      security: {
        level: securityHealth.securityLevel,
        validation_passed: securityHealth.validationPassed,
        total_events: securityHealth.recentEvents,
        critical_events: securityHealth.criticalEvents
      },
      recent_events: recentEvents.map(event => ({
        type: event.type,
        level: event.level,
        message: event.message,
        timestamp: event.timestamp,
        user_id: event.userId,
        ip: event.ipAddress
      }))
    };

    const statusCode = securityHealth.status === 'healthy' ? 200 : 
                      securityHealth.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(response);
  } catch (error) {
    logger.error({ err: error }, 'Security health check endpoint failed');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Security health check failed',
      message: 'Internal server error'
    });
  }
};

/**
 * Database-specific health check endpoint
 */
export const databaseHealthCheck = async (_req: Request, res: Response) => {
  try {
    const dbHealth = await checkDatabaseHealth();
    
    // Additional database checks
    // No tenant tables here: this runs outside any tenant, where RLS refuses them.
    const [tablesResult, usersResult] = await Promise.all([
      // information_schema is not in the generated Kysely schema — kept as raw sql
      sql<{ count: string }>`SELECT COUNT(*) as count FROM information_schema.tables WHERE table_schema = 'public'`.execute(db),
      db.selectFrom('users').select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst(),
    ]);

    const response = {
      status: dbHealth.status,
      timestamp: new Date().toISOString(),
      database: {
        connection_status: dbHealth.status,
        response_time_ms: dbHealth.responseTime,
        connection_count: dbHealth.connectionCount,
        last_query: dbHealth.lastQuery
      },
      tables: {
        total_tables: parseInt(tablesResult.rows[0]?.count || '0'),
        total_users: parseInt(usersResult?.count || '0')
      }
    };

    const statusCode = dbHealth.status === 'healthy' ? 200 : 
                      dbHealth.status === 'degraded' ? 200 : 503;

    res.status(statusCode).json(response);
  } catch (error) {
    logger.error({ err: error }, 'Database health check endpoint failed');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database health check failed',
      message: 'Internal server error'
    });
  }
};
