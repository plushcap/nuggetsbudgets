#!/usr/bin/env node

/**
 * One-time backfill: move on-disk image files into the database: a ledger's
 * images into `stored_images`, profile pictures into `user_profile_images`.
 *
 * Account / goal / merchant / profile images used to be written under uploads/
 * and referenced by a `/uploads/...` path column. This reads each such file and
 * stores its bytes in the DB, then rewrites the column to `/api/images/<uuid>`
 * (served by GET /api/images/:uuid). After this, images ride the DB
 * backup/restore instead of the filesystem.
 *
 * Run ONCE after deploying the stored_images migration, with the old image files
 * present on the box (rsync them over from the previous host first if migrating).
 *
 *   docker exec nuggets_backend node dist/scripts/migrate-images-to-db.js
 *
 * Idempotent: it only touches rows whose column still starts with `/uploads/`, so
 * re-running is safe (already-migrated `/api/images/...` rows are skipped). A file
 * that's missing on disk is logged and left as-is (rerun after restoring it).
 *
 * Runs as the schema owner (createMigrationPool), which bypasses RLS, so it can
 * read every tenant's rows and set tenant_id explicitly.
 */

import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { createMigrationPool } from '../db/migrationPool.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';

dotenv.config();

const logger = createLogger({ service: 'migrate-images-to-db' });

// Where the app writes uploads inside the container (mirrors BackupService).
const UPLOADS_ROOT = config().UPLOADS_DIR || '/app/uploads';

const EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// The four columns that hold small identity images. `global` = a non-tenant
// (users) table → a profile picture, stored in user_profile_images by user id.
// Table/column names are hardcoded constants here (never user input), so
// interpolating them into SQL is safe.
const TARGETS: Array<{ table: string; column: string; global: boolean }> = [
  { table: 'accounts', column: 'account_image', global: false },
  { table: 'budget_items', column: 'image_path', global: false },
  { table: 'merchants', column: 'merchant_image', global: false },
  { table: 'users', column: 'profile_image', global: true },
];

async function main(): Promise<void> {
  const pool = createMigrationPool();

  let migrated = 0;
  let skippedMissing = 0;
  let failed = 0;

  try {
    for (const target of TARGETS) {
      const tenantSelect = target.global ? 'NULL::int AS tenant_id' : 'tenant_id';
      const { rows } = await pool.query(
        `SELECT id, ${target.column} AS val, ${tenantSelect} FROM ${target.table} WHERE ${target.column} LIKE '/uploads/%'`
      );

      logger.info({ table: target.table, column: target.column, candidates: rows.length }, 'Scanning for on-disk images');

      for (const row of rows) {
        const columnValue: string = row.val;
        const relative = columnValue.replace(/^\/uploads\//, '');
        const filePath = path.join(UPLOADS_ROOT, relative);
        const mime = EXTENSION_TO_MIME[path.extname(filePath).toLowerCase()];

        if (!mime) {
          logger.warn({ table: target.table, id: row.id, columnValue }, 'Unrecognized image extension; skipping');
          failed++;
          continue;
        }
        if (!fs.existsSync(filePath)) {
          logger.warn({ table: target.table, id: row.id, filePath }, 'Image file missing on disk; leaving column unchanged (rerun after restoring it)');
          skippedMissing++;
          continue;
        }

        const data = fs.readFileSync(filePath);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const inserted = target.global
            ? await client.query(
                `INSERT INTO user_profile_images (user_id, mime_type, byte_size, data)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (user_id) DO UPDATE
                   SET mime_type = EXCLUDED.mime_type, byte_size = EXCLUDED.byte_size, data = EXCLUDED.data, uuid = uuidv7()
                 RETURNING uuid`,
                [row.id, mime, data.length, data]
              )
            : await client.query(
                'INSERT INTO stored_images (tenant_id, mime_type, byte_size, data, created_by_user_id) VALUES ($1, $2, $3, $4, NULL) RETURNING uuid',
                [row.tenant_id, mime, data.length, data]
              );
          const uuid = inserted.rows[0].uuid;
          await client.query(
            `UPDATE ${target.table} SET ${target.column} = $1 WHERE id = $2`,
            [`/api/images/${uuid}`, row.id]
          );
          await client.query('COMMIT');
          migrated++;
        } catch (error) {
          await client.query('ROLLBACK');
          logger.error({ err: error, table: target.table, id: row.id }, 'Failed to migrate image');
          failed++;
        } finally {
          client.release();
        }
      }
    }

    logger.info({ migrated, skippedMissing, failed }, 'Image backfill complete');
  } finally {
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error({ err: error }, 'Image backfill failed');
    process.exit(1);
  });
