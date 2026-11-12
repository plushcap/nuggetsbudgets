import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';
import type { SecurityEvent } from '../../middleware/security-enhanced.js';
import type { SecurityValidationResult } from '../../utils/security-validator.js';

/**
 * The deployment admin's health reports (GET /api/health/detailed, /security, /database;
 * middleware/health-checks.ts): how each part's status is decided, the HTTP status the
 * report answers with, and that a failure answers a generic message, never the error's text.
 * The database, the security validation and the security events are stubbed; the clock
 * moves only when a query "takes" time, so the database's response-time bands are exact.
 */

// The failures below log errors; keep them out of the test output unless asked for.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

const state = vi.hoisted(() => ({
  nowMs: 0,
  queryMs: 0,
  failQueries: false,
  failCounts: false,
  totalCount: 3,
  validation: null as unknown,
  validationThrows: false,
  events: [] as unknown[],
  eventsThrowOnCall: 0,
  eventCalls: 0,
}));

vi.mock('../../db.js', async () => {
  const query = vi.fn(async (text: string) => {
    if (state.failQueries) throw new Error('connect ECONNREFUSED 10.0.0.5:5432 (internal detail)');
    state.nowMs += state.queryMs;
    if (/version\(\)/.test(text)) return { rows: [{ current_time: new Date('2026-11-04T12:00:00Z'), version: 'PostgreSQL 18.0' }] };
    if (state.failCounts) throw new Error('relation "secret_internal_table" does not exist');
    if (/information_schema\.tables/.test(text)) return { rows: [{ count: '71' }] };
    if (/"users"/.test(text)) return { rows: [{ count: '4' }] };
    throw new Error(`unexpected query: ${text}`);
  });
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
    get totalCount() {
      return state.totalCount;
    },
  };
  return { default: pool, db: new Kysely({ dialect: new PostgresDialect({ pool: pool as unknown as Pool }) }) };
});

vi.mock('../../utils/security-validator.js', () => ({
  validateNuggetsSecurityConfig: () => {
    if (state.validationThrows) throw new Error('validator blew up (internal detail)');
    return state.validation;
  },
}));

vi.mock('../../middleware/security-enhanced.js', () => ({
  getRecentSecurityEvents: (limit: number) => {
    state.eventCalls += 1;
    if (state.eventsThrowOnCall === state.eventCalls) throw new Error('event store gone (internal detail)');
    return state.events.slice(0, limit);
  },
}));

const health = await import('../../middleware/health-checks.js');

const validation = (overrides: Partial<SecurityValidationResult> = {}, level: 'production' | 'basic' | 'insecure' = 'production') => ({
  isValid: true,
  errors: [],
  warnings: [],
  summary: { jwtSecurityLevel: level, databaseSecurityLevel: level, overallSecurityLevel: level },
  ...overrides,
});

const event = (level: SecurityEvent['level'], ageMs = 1000): SecurityEvent => ({
  type: 'authentication',
  level,
  message: `a ${level} event`,
  userId: 7,
  ipAddress: '203.0.113.9',
  userAgent: 'test',
  timestamp: new Date(state.nowMs - ageMs),
});

function app() {
  return express()
    .get('/detailed', health.detailedHealthCheck)
    .get('/security', health.securityHealthCheck)
    .get('/database', health.databaseHealthCheck);
}

const MB = 1024 * 1024;

beforeEach(() => {
  Object.assign(state, {
    nowMs: Date.UTC(2026, 10, 4, 12),
    queryMs: 5,
    failQueries: false,
    failCounts: false,
    totalCount: 3,
    validation: validation(),
    validationThrows: false,
    events: [],
    eventsThrowOnCall: 0,
    eventCalls: 0,
  });
  vi.spyOn(Date, 'now').mockImplementation(() => state.nowMs);
  vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 200 * MB, heapTotal: 100 * MB, heapUsed: 50 * MB, external: 0, arrayBuffers: 0 });
  health.setBackupHealthSource(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  health.setBackupHealthSource(null);
});

describe('GET /api/health/detailed', () => {
  it('is healthy, 200, when every part is, with no backup report when nothing supplies one', async () => {
    const res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.overall).toMatchObject({ status: 'healthy', environment: 'test' });
    expect(res.body.database).toEqual({ status: 'healthy', connectionCount: 3, responseTime: 5, lastQuery: '2026-11-04T12:00:00.000Z' });
    expect(res.body.security).toEqual({ status: 'healthy', securityLevel: 'production', recentEvents: 0, criticalEvents: 0, validationPassed: true });
    expect(res.body.system).toMatchObject({ status: 'healthy', memory: { used: 200 * MB, total: 100 * MB, percentage: 200 } });
    expect(res.body.backups).toBeNull();
    expect(Object.fromEntries(Object.entries(res.body.checks).map(([k, v]) => [k, (v as { status: string }).status]))).toEqual({
      database_connectivity: 'pass',
      security_validation: 'pass',
      memory_usage: 'pass',
      security_events: 'pass',
    });
  });

  it('is degraded, still 200, when the database answers in 100 ms to 500 ms', async () => {
    state.queryMs = 100;
    const res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.overall.status).toBe('degraded');
    expect(res.body.database).toMatchObject({ status: 'degraded', responseTime: 100 });
    expect(res.body.checks.database_connectivity).toMatchObject({ status: 'warn', message: 'Database response time: 100ms' });
  });

  it('is unhealthy, 503, when the database takes 500 ms or more, or fails', async () => {
    state.queryMs = 500;
    let res = await request(app()).get('/detailed');
    expect(res.status).toBe(503);
    expect(res.body.database.status).toBe('unhealthy');
    expect(res.body.checks.database_connectivity.status).toBe('fail');

    state.failQueries = true;
    res = await request(app()).get('/detailed');
    expect(res.status).toBe(503);
    expect(res.body.database).toEqual({ status: 'unhealthy', connectionCount: 0, responseTime: -1, lastQuery: 'error' });
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('rates the security validation and the recent critical events', async () => {
    state.validation = validation({ isValid: false });
    let res = await request(app()).get('/detailed');
    expect(res.status).toBe(503);
    expect(res.body.security).toMatchObject({ status: 'unhealthy', validationPassed: false });
    expect(res.body.checks.security_validation.status).toBe('fail');

    state.validation = validation({}, 'insecure');
    expect((await request(app()).get('/detailed')).body.security.status).toBe('unhealthy');

    state.validation = validation({}, 'basic');
    res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.security).toMatchObject({ status: 'degraded', securityLevel: 'basic' });

    // Two critical events in the last hour, and one older: a warning, still healthy.
    state.validation = validation();
    state.events = [event('critical'), event('error'), event('critical', 2 * 60 * 60 * 1000), event('info')];
    res = await request(app()).get('/detailed');
    expect(res.body.security).toMatchObject({ status: 'healthy', recentEvents: 4, criticalEvents: 3 });
    expect(res.body.checks.security_events).toMatchObject({ status: 'warn', message: 'Critical events: 3' });

    // More than five in the last hour: degraded, and the events check fails.
    state.events = Array.from({ length: 6 }, () => event('error'));
    res = await request(app()).get('/detailed');
    expect(res.body.security).toMatchObject({ status: 'degraded', criticalEvents: 6 });
    expect(res.body.checks.security_events.status).toBe('fail');
  });

  it('reports the security part unhealthy when its check throws, without the error', async () => {
    state.validationThrows = true;
    const res = await request(app()).get('/detailed');
    expect(res.status).toBe(503);
    expect(res.body.security).toEqual({ status: 'unhealthy', securityLevel: 'insecure', recentEvents: 0, criticalEvents: 0, validationPassed: false });
    expect(JSON.stringify(res.body)).not.toContain('blew up');
  });

  it('warns on memory above 512 MB, as degraded, never unhealthy', async () => {
    vi.mocked(process.memoryUsage).mockReturnValue({ rss: 600 * MB, heapTotal: 300 * MB, heapUsed: 250 * MB, external: 0, arrayBuffers: 0 });
    const res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.system.status).toBe('degraded');
    expect(res.body.checks.memory_usage).toMatchObject({ status: 'warn', message: 'Memory usage: 600 MB (warning only)' });
  });

  it("includes the backups' state: their problems as a warning, and no report when it can't be read", async () => {
    const backups = {
      status: 'healthy' as const,
      automaticBackups: 'on' as const,
      lastRunOutcome: 'success' as const,
      lastRunFinishedAt: '2026-11-04T03:00:00.000Z',
      newestBackupAt: '2026-11-04T03:00:00.000Z',
      nextBackupAt: '2026-11-05T03:00:00.000Z',
      problems: [] as string[],
    };
    health.setBackupHealthSource(async () => backups);
    let res = await request(app()).get('/detailed');
    expect(res.body.backups).toEqual(backups);
    expect(res.body.checks.backups).toMatchObject({ status: 'pass', message: 'Newest backup: 2026-11-04T03:00:00.000Z' });

    health.setBackupHealthSource(async () => ({
      ...backups,
      status: 'degraded',
      automaticBackups: 'waiting-for-backup-key',
      problems: ['No backup key yet', 'The last backup failed'],
    }));
    res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.overall.status).toBe('degraded');
    expect(res.body.checks.backups).toMatchObject({ status: 'warn', message: 'No backup key yet; The last backup failed' });

    health.setBackupHealthSource(() => Promise.reject(new Error('backup dir unreadable (internal detail)')));
    res = await request(app()).get('/detailed');
    expect(res.status).toBe(200);
    expect(res.body.backups).toBeNull();
    expect(res.body.checks).not.toHaveProperty('backups');
  });

  it('answers 503 with a generic message when building the report fails', async () => {
    vi.mocked(process.memoryUsage).mockImplementation(() => {
      throw new Error('memoryUsage failed (internal detail)');
    });
    const res = await request(app()).get('/detailed');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ overall: { status: 'unhealthy', environment: 'test' }, error: 'Health check failed', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('internal detail');
  });
});

describe('GET /api/health/security', () => {
  it('lists the recent events, and answers by the security status', async () => {
    state.events = [event('warning')];
    let res = await request(app()).get('/security');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'healthy',
      security: { level: 'production', validation_passed: true, total_events: 1, critical_events: 0 },
      recent_events: [{ type: 'authentication', level: 'warning', message: 'a warning event', user_id: 7, ip: '203.0.113.9' }],
    });

    state.validation = validation({}, 'basic');
    res = await request(app()).get('/security');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');

    state.validation = validation({ isValid: false });
    res = await request(app()).get('/security');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });

  it('answers 503 with a generic message when the events can\'t be read', async () => {
    // The status check reads them first (call 1) and copes; the list (call 2) fails.
    state.eventsThrowOnCall = 2;
    const res = await request(app()).get('/security');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unhealthy', error: 'Security health check failed', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('internal detail');
  });
});

describe('GET /api/health/database', () => {
  it('reports the connection and the table and user counts, and answers by the database status', async () => {
    let res = await request(app()).get('/database');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'healthy',
      database: { connection_status: 'healthy', response_time_ms: 5, connection_count: 3, last_query: '2026-11-04T12:00:00.000Z' },
      tables: { total_tables: 71, total_users: 4 },
    });

    state.queryMs = 200;
    res = await request(app()).get('/database');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');

    state.queryMs = 600;
    res = await request(app()).get('/database');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unhealthy');
  });

  it('answers 503 with a generic message when a count fails or the database is down', async () => {
    state.failCounts = true;
    let res = await request(app()).get('/database');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unhealthy', error: 'Database health check failed', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('secret_internal_table');

    state.failCounts = false;
    state.failQueries = true;
    res = await request(app()).get('/database');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Database health check failed');
  });
});

describe('GET /api/ready', () => {
  const ready = (readiness: () => Promise<{ ready: boolean; checks: object }>) =>
    express().get('/ready', health.readinessCheck({ readiness } as never));

  it('answers 200 when ready and 503 when not, uncached, and 503 without a reason when the check throws', async () => {
    const checks = { startup: 'ready', shuttingDown: false, database: 'ok', migrations: 'ok' };
    let res = await request(ready(async () => ({ ready: true, checks }))).get('/ready');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ status: 'ready', checks });

    res = await request(ready(async () => ({ ready: false, checks: { ...checks, database: 'unavailable' } }))).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'not_ready', checks: { database: 'unavailable' } });

    res = await request(ready(() => Promise.reject(new Error('readiness exploded (internal detail)')))).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', timestamp: expect.any(String) });
  });
});
