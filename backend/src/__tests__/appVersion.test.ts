import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Pool } from 'pg';
import express from 'express';
import { basicHealthCheck } from '../middleware/health-checks.js';
import { BackupService } from '../services/BackupService.js';

/**
 * The release workflow bakes the image's version and commit into the backend image as
 * APP_VERSION and GIT_SHA (backend/Dockerfile.prod). /api/health and the backup manifest
 * report that version; both used to say a fixed 1.0.0 or 'unknown' whatever ran.
 */
describe('the version the image was built as', () => {
  // The handler routes.ts mounts at /api/health and /health.
  const app = express().get('/api/health', basicHealthCheck);

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is what /api/health reports', async () => {
    vi.stubEnv('APP_VERSION', '1.4.2');
    vi.stubEnv('GIT_SHA', '0123456789abcdef0123456789abcdef01234567');
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('1.4.2');
    // The commit and NODE_ENV are for the deployment admin's detailed report, not this
    // public answer.
    expect(res.body).not.toHaveProperty('commit');
    expect(res.body).not.toHaveProperty('environment');
  });

  it('is unknown in a build without it, not a made-up number', async () => {
    vi.stubEnv('APP_VERSION', '');
    vi.stubEnv('npm_package_version', '1.0.0');
    const res = await request(app).get('/api/health');
    expect(res.body.version).toBe('unknown');
  });

  it('is the appVersion of a backup manifest', async () => {
    vi.stubEnv('APP_VERSION', '1.4.2');
    const db = { query: async () => ({ rows: [{ version: '20261102110300' }] }) } as unknown as Pool;
    const service = new BackupService(db) as unknown as { writeManifest: (dir: string) => Promise<string> };
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nuggets-manifest-'));
    try {
      const manifest = JSON.parse(await readFile(await service.writeManifest(dir), 'utf8'));
      expect(manifest).toMatchObject({ appVersion: '1.4.2', schemaVersion: '20261102110300' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
