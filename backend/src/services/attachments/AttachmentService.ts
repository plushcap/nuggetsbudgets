import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { getDirname } from '../../utils/esm-compat.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';

const __dirname = getDirname(import.meta.url);

/**
 * Files attached to a ledger's transactions, budget items, merchants and holding events.
 * The rows are tenant-scoped (RLS): every statement runs on getDb(), under the ledger. The
 * bytes live flat in the uploads directory, named by the row's database-generated
 * safe_filename (`<uuid>_<sanitized-original>`).
 *
 * A file is a write outside the database, so what changes one runs its own short
 * transaction (withTenant), and changes the file by its outcome: an upload moves its
 * files to their names inside the transaction and removes them if it then rolls back (a later
 * file's insert failed, or the commit); a delete removes the file once the row's delete has
 * committed. A crash in between leaves at worst a file no row names, never a row naming a
 * file that is gone.
 */

/** Where uploads live: `<backend>/uploads`, which a backup archives. */
export const UPLOAD_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

/** An attachment request refused: answered with its status, `{ error, code, message }`. */
export class AttachmentError extends DomainError {
  constructor(status: 400 | 404, message: string) {
    super(status, defaultErrorCode(status), message);
  }
}

const attachmentNotFound = () => new AttachmentError(404, 'Attachment not found');

/** attachments.name: varchar(255). */
const NAME_MAX_CHARS = 255;
/**
 * The file's name on disk, safe_filename: the row's uuid, '_', and the file's name made safe
 * (generate_safe_filename), all ASCII. A file system holds a name of 255 bytes at most (the
 * column, and original_filename, hold 500).
 */
const SAFE_NAME_MAX_CHARS = 255;
const SAFE_NAME_PREFIX_CHARS = 37;
/** attachments.original_filename: varchar(500). */
const FILE_NAME_MAX_CHARS = 500;

/** Characters as Postgres counts them for a varchar: code points. */
const charCount = (text: string) => [...text].length;

/**
 * Refuses (400) an attachment whose name (the one sent, else its file's) its row can't hold, or
 * whose file's name its file can't be stored under: the insert failed on the first, 22001,
 * and the rename on the second, ENAMETOOLONG, each a 500. The file's name made safe is what
 * generate_safe_filename makes of it (each character but [a-zA-Z0-9._-] an underscore, then a run
 * of them one).
 */
function refuseNamesTooLong(name: string, fileName: string): void {
  if (charCount(name) > NAME_MAX_CHARS) {
    throw new AttachmentError(400, `An attachment's name can be at most ${NAME_MAX_CHARS} characters.`);
  }
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/gu, '_').replace(/_+/g, '_');
  // The file's own name is kept too, whole (one over 500 characters whose safe name
  // collapses to a short one failed that insert, a 500).
  if (charCount(fileName) > FILE_NAME_MAX_CHARS || SAFE_NAME_PREFIX_CHARS + safe.length > SAFE_NAME_MAX_CHARS) {
    throw new AttachmentError(400, 'The file\'s name is too long. Rename the file and upload it again.');
  }
}

/**
 * The entity an attachment hangs off. Each is a column of attachments (a multi-FK
 * "exclusive arc") and its parent table, which is checked under RLS so an attachment
 * can't point at another tenant's row.
 */
export const ENTITY_FIELDS = {
  transaction_id: 'transactions',
  budget_item_id: 'budget_items',
  merchant_id: 'merchants',
  holding_event_id: 'holding_events',
} as const;
export type EntityField = keyof typeof ENTITY_FIELDS;
export type EntityIds = Partial<Record<EntityField, number>>;

/** A file the upload has checked, still at its temporary path. */
export interface CheckedFile {
  /** Where multer wrote it, inside UPLOAD_DIR. */
  path: string;
  originalname: string;
  mimeType: string;
  size: number;
}

const ATTACHMENT_COLUMNS = [
  'id', 'uuid', 'name', 'original_filename', 'safe_filename', 'file_extension',
  'file_size', 'mime_type', 'date_uploaded', 'bill_date', 'notes', 'file_name',
  'attachment_type', 'created_at', 'transaction_id', 'budget_item_id', 'merchant_id',
  'holding_event_id',
] as const;

export class AttachmentService {
  /**
   * Refuses (404 "Referenced … not found") an upload naming a row that isn't this ledger's:
   * the attachment would otherwise point at another tenant's row. Checked under RLS, on
   * getDb().
   */
  private async assertEntitiesExist(entityIds: EntityIds): Promise<void> {
    for (const field of Object.keys(entityIds) as EntityField[]) {
      const exists = await sql<{ present: boolean }>`SELECT EXISTS(SELECT 1 FROM ${sql.table(ENTITY_FIELDS[field])} WHERE id = ${entityIds[field]}) AS present`.execute(getDb());
      if (!exists.rows[0]?.present) throw new AttachmentError(404, `Referenced ${field.replace(/_id$/, '')} not found`);
    }
  }

  /**
   * {@link assertEntitiesExist} for ledger `tenantId`, in a short transaction of its own: what
   * an upload checks before any of its files is written, while the request's body is
   * still being read. {@link create} checks again as it inserts.
   */
  async checkEntities(tenantId: number, entityIds: EntityIds): Promise<void> {
    await withTenant(tenantId, () => this.assertEntitiesExist(entityIds));
  }

  /**
   * Attaches `files` to the entity `entityIds` names in ledger `tenantId` (one or more of its
   * columns, checked again here under RLS), with the upload's `name` (each file's own name when
   * none), notes and bill date, in one transaction of its own. Each file is moved from its
   * temporary path to the name its row was given; if the transaction then rolls back (a later
   * file's insert failed, or the commit), the files moved go too, so no file is left that no
   * row names. Answers the rows, file_size a number.
   */
  async create(
    tenantId: number,
    files: readonly CheckedFile[],
    entityIds: EntityIds,
    fields: { name: string | null; notes: string | null; billDate: string | null }
  ) {
    for (const file of files) refuseNamesTooLong(fields.name ?? file.originalname, file.originalname);
    const moved: string[] = [];
    try {
      return await withTenant(tenantId, async () => {
        await this.assertEntitiesExist(entityIds);
        const created = [];
        for (const file of files) {
          // Inserted with empty safe_filename/file_extension/file_name so the
          // generate_safe_filename BEFORE-INSERT trigger derives them from the
          // uuid + original filename. tenant_id defaults to the RLS GUC.
          const row = await getDb()
            .insertInto('attachments')
            .values({
              ...entityIds,
              name: fields.name ?? file.originalname,
              original_filename: file.originalname,
              safe_filename: '',
              file_extension: '',
              file_name: '',
              file_size: String(file.size),
              mime_type: file.mimeType,
              notes: fields.notes,
              bill_date: fields.billDate,
              attachment_type: 'document',
            })
            .returning(ATTACHMENT_COLUMNS)
            .executeTakeFirstOrThrow();

          // The temporary file takes its final, database-derived name.
          const finalPath = path.join(UPLOAD_DIR, row.safe_filename);
          await fsp.rename(file.path, finalPath);
          moved.push(finalPath);
          created.push({ ...row, file_size: row.file_size == null ? null : Number(row.file_size) });
        }
        return created;
      });
    } catch (err) {
      await Promise.all(moved.map((file) => fsp.unlink(file).catch(() => undefined)));
      throw err;
    }
  }

  /**
   * Where the bytes of the attachment `uuid` names are, and the name to serve them with.
   * RLS scopes the lookup to the caller's ledger: another ledger's attachment is not found.
   */
  async file(uuid: string): Promise<{ path: string; extension: string; downloadName: string }> {
    const row = await getDb()
      .selectFrom('attachments')
      .select(['safe_filename', 'original_filename', 'file_extension'])
      .where('uuid', '=', uuid)
      .executeTakeFirst();
    if (!row || !row.safe_filename) throw attachmentNotFound();

    // safe_filename is generated by the database and sanitised to [a-zA-Z0-9._-] (no path
    // separators), but the resolved path is checked to stay inside UPLOAD_DIR before it is
    // read: defence in depth against any future change to that generation.
    const resolved = path.resolve(UPLOAD_DIR, row.safe_filename);
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) throw new AttachmentError(400, 'Invalid attachment path');
    if (!fs.existsSync(resolved)) throw new AttachmentError(404, 'Attachment file missing');

    return {
      path: resolved,
      extension: (row.file_extension ? `.${row.file_extension}` : path.extname(row.safe_filename)).toLowerCase(),
      downloadName: row.original_filename || row.safe_filename,
    };
  }

  /**
   * Deletes the attachment `uuid` names in ledger `tenantId` (RLS scopes it to the ledger), in
   * a transaction of its own, then its file, best effort. The file goes only once the delete
   * has committed: removed inside the request's transaction, a rollback left the row
   * naming a file that was gone.
   */
  async remove(tenantId: number, uuid: string): Promise<void> {
    const deleted = await withTenant(tenantId, () =>
      getDb().deleteFrom('attachments').where('uuid', '=', uuid).returning(['safe_filename']).executeTakeFirst()
    );
    if (!deleted) throw attachmentNotFound();
    // A missing file shouldn't fail the request.
    if (deleted.safe_filename) {
      await fsp.unlink(path.join(UPLOAD_DIR, deleted.safe_filename)).catch(() => undefined);
    }
  }
}
