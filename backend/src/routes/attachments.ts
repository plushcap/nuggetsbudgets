// File attachment routes: upload, download and delete of documents attached to a
// transaction, budget item, merchant or holding event. The upload is checked here (its
// count and size, the entity it names before any file is written, each file's bytes
// against its extension); AttachmentService stores and serves the rows and their files,
// under the ledger's RLS.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { tenantHandler, tenantNetworkHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';
import { UploadRejectedError } from '../utils/imageUpload.js';
import { contentDisposition, sanitizeImage, sniffFileType, SNIFF_BYTES, type SniffedType } from '../utils/uploadSafety.js';
import { calendarDay } from '@nuggets/shared';
import {
  AttachmentError,
  AttachmentService,
  ENTITY_FIELDS,
  UPLOAD_DIR,
  type CheckedFile,
  type EntityField,
  type EntityIds,
} from '../services/attachments/AttachmentService.js';
import { refuseNulFields } from '../middleware/nulText.js';
import { getCurrentTenantId } from '../context/requestContext.js';
import { DomainError } from '../services/domainErrors.js';

const logger = createLogger({ service: 'AttachmentsRoute' });

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.xls', '.xlsx'];

// Content types we're willing to render inline (open in a new tab) — PDFs and
// raster images only. Office documents and anything else are forced to download.
// SVG/HTML are never in this map, so they can never be served as inline markup.
const INLINE_CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

// What each allowed extension's bytes must be, and the type stored
// for it: the extension and the browser's MIME type are the uploader's word, the first
// bytes aren't. Office formats are a ZIP (.docx, .xlsx) or an OLE2 file (.doc, .xls).
const EXTENSION_TYPES: Record<string, { sniffed: SniffedType; mimeType: string }> = {
  '.pdf': { sniffed: 'application/pdf', mimeType: 'application/pdf' },
  '.png': { sniffed: 'image/png', mimeType: 'image/png' },
  '.jpg': { sniffed: 'image/jpeg', mimeType: 'image/jpeg' },
  '.jpeg': { sniffed: 'image/jpeg', mimeType: 'image/jpeg' },
  '.docx': { sniffed: 'application/zip', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  '.xlsx': { sniffed: 'application/zip', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  '.doc': { sniffed: 'application/x-ole-storage', mimeType: 'application/msword' },
  '.xls': { sniffed: 'application/x-ole-storage', mimeType: 'application/vnd.ms-excel' },
};

/**
 * multer's limits: 10 files of up to 5 MB, and the few fields the form has. Without the
 * count limits one request could carry thousands of 5 MB files onto the uploads volume.
 * Over a limit is a 400 UPLOAD_REJECTED (413 for a file too large), by answerError.
 */
export const ATTACHMENT_UPLOAD_LIMITS = {
  fileSize: 5 * 1024 * 1024,
  files: 10,
  fields: 20,
  parts: 30,
  fieldSize: 64 * 1024,
} as const;

/**
 * Check an uploaded file's bytes against its extension, and strip an image's metadata
 * in place. Returns the type to store and the size on disk, or throws
 * UploadRejectedError.
 */
async function checkUploadedFile(file: Express.Multer.File): Promise<{ mimeType: string; size: number }> {
  const expected = EXTENSION_TYPES[path.extname(file.originalname).toLowerCase()];
  const handle = await fsp.open(file.path, 'r');
  let head: Buffer;
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    head = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  if (!expected || sniffFileType(head) !== expected.sniffed) {
    throw new UploadRejectedError(`“${path.basename(file.originalname)}” isn’t the kind of file its name says it is.`);
  }
  if (expected.sniffed === 'image/jpeg' || expected.sniffed === 'image/png') {
    const image = sanitizeImage(await fsp.readFile(file.path));
    await fsp.writeFile(file.path, image.data);
    return { mimeType: expected.mimeType, size: image.data.length };
  }
  return { mimeType: expected.mimeType, size: file.size };
}

/** Positive integer from a multipart string field, or null. */
function parseId(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The entity an upload names: whichever of its fields the body (as parsed so far) has. */
function entityIdsOf(body: Record<string, unknown> | undefined): EntityIds {
  const entityIds: EntityIds = {};
  for (const field of Object.keys(ENTITY_FIELDS) as EntityField[]) {
    const id = parseId(body?.[field]);
    if (id != null) entityIds[field] = id;
  }
  return entityIds;
}

const NO_ENTITY = 'An attachment must reference one of: transaction_id, budget_item_id, merchant_id, holding_event_id';
const ENTITY_CHANGED = 'Name what the attachment is for (transaction_id, budget_item_id, merchant_id or holding_event_id) once, before its files';

/** An upload's entity fields as a key: what its first file found them, and was checked against. */
const entityKey = (body: unknown) => JSON.stringify(entityIdsOf(body as Record<string, unknown> | undefined));

/**
 * An upload's entity is checked before multer writes any of its files. They were
 * written to the uploads volume first, and removed once the handler refused the request, so a
 * request naming another ledger's row (or none) still wrote up to ATTACHMENT_UPLOAD_LIMITS of
 * bytes. Now, after the route's guards (at its mount: authenticateToken, resolveTenant,
 * requireTenantMember) and before the first byte is written:
 *   - {@link rememberUploadTenant} keeps the request's ledger before multer reads the body;
 *   - the file filter doesn't write a file sent before any field naming its entity (the form
 *     names it first), nor any file after it, and the handler then refuses the upload
 *     ({@link fileBeforeEntity});
 *   - the storage's destination checks the entity under the ledger's RLS
 *     (AttachmentService.checkEntities, once per request, as the first file found it) before
 *     the first file is written: a refusal stops the upload, with nothing written, and is
 *     answered as any refusal is;
 *   - an entity field after the first file would change what was checked: the file filter
 *     refuses the next file (multer removes those written), and the handler a change after the
 *     last ({@link entityAtFirstFile}), a 400 either way.
 * multer's limits hold throughout. The handler checks the entity again as it inserts.
 */
const uploadTenant = new WeakMap<Request, number>();
const fileBeforeEntity = new WeakSet<Request>();
const entityAtFirstFile = new WeakMap<Request, string>();
const entityChecks = new WeakMap<Request, Promise<void>>();

/** Keep the request's ledger for the upload's checks: multer's callbacks may run outside the request's context. */
function rememberUploadTenant(req: Request, _res: Response, next: NextFunction): void {
  const tenantId = getCurrentTenantId();
  if (typeof tenantId === 'number') uploadTenant.set(req, tenantId);
  next();
}

/** The upload parser: multer with the checks above, for `attachments`' entity check. */
function attachmentUploadFor(attachments: AttachmentService) {
  /** The upload's entity, checked under RLS once per request (each file's destination waits on it). */
  const checkedEntity = (req: Request): Promise<void> => {
    let check = entityChecks.get(req);
    if (!check) {
      const tenantId = uploadTenant.get(req);
      check = tenantId === undefined
        ? Promise.reject(new DomainError(400, 'NO_ACTIVE_TENANT', 'No active tenant selected'))
        : attachments.checkEntities(tenantId, entityIdsOf(req.body as Record<string, unknown> | undefined));
      // Each file's destination answers it: not an unhandled rejection meanwhile.
      check.catch(() => undefined);
      entityChecks.set(req, check);
    }
    return check;
  };

  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      checkedEntity(req).then(
        () => {
          if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          cb(null, UPLOAD_DIR);
        },
        (err: Error) => cb(err, '')
      );
    },
    filename: (_req, file, cb) => {
      // Temp name until the DB row gives us the real safe_filename. originalname
      // is attacker-controlled: strip any directory component and unsafe chars so
      // it cannot escape the uploads directory.
      const safeOriginal = path.basename(String(file.originalname))
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 100);
      cb(null, `temp_${randomUUID()}_${safeOriginal}`);
    },
  });

  return multer({
    storage,
    limits: ATTACHMENT_UPLOAD_LIMITS,
    // Browsers send a file's name as UTF-8 bytes; multer's default reads them as Latin-1,
    // which stored "für" as "fÃ¼r".
    defParamCharset: 'utf8',
    fileFilter: (req, file, cb) => {
      // After a file sent before its entity, none is written: the handler refuses the upload.
      if (fileBeforeEntity.has(req)) {
        cb(null, false);
        return;
      }
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        logger.warn({ filename: file.originalname, extension: ext }, 'Attachment upload rejected - invalid file type');
        cb(null, false);
        return;
      }
      // Not written before the field naming its entity has come, and been checked (above).
      const entity = entityKey(req.body);
      if (entity === '{}') {
        fileBeforeEntity.add(req);
        cb(null, false);
        return;
      }
      // The entity checked is the one the first file found: a field since would change it.
      const first = entityAtFirstFile.get(req);
      if (first === undefined) entityAtFirstFile.set(req, entity);
      else if (first !== entity) {
        cb(new AttachmentError(400, ENTITY_CHANGED));
        return;
      }
      cb(null, true);
    },
  });
}

/**
 * Files attached to a ledger's transactions, accounts, bills and budget items
 * (/api/attachments): upload, download, delete. Mounted behind authenticateToken,
 * resolveTenant and requireTenantMember, so the upload parser runs after them. The
 * service's refusals (AttachmentError) are answered by the route wrapper.
 *
 * The upload and the delete change files as well as rows, so their database work runs in
 * transactions of their own (tenantNetworkHandler; AttachmentService opens them), and the
 * files change by how those end: tenantHandler's transaction ends after its handler,
 * too late for that.
 */
export function createAttachmentRoutes(): Router {
  const router = Router();
  const attachments = new AttachmentService();
  const attachmentUpload = attachmentUploadFor(attachments);

  // Upload one or more attachments for a single entity, named in the form before the files.
  router.post('/upload', rememberUploadTenant, attachmentUpload.array('attachments'), refuseNulFields, tenantNetworkHandler(async (req: AuthenticatedRequest, res, tenantId) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    try {
      // Exactly-one-arm is not required by the schema (at least one is), but the
      // callers only ever attach to a single entity, so collect whichever FK ids
      // were provided and validate at least one.
      const entityIds = entityIdsOf(req.body as Record<string, unknown>);
      const providedFields = Object.keys(entityIds) as EntityField[];
      // A file sent before the field naming its entity wasn't written (attachmentUploadFor).
      if (fileBeforeEntity.has(req)) {
        res.status(400).json({
          error: providedFields.length === 0 ? NO_ENTITY : `Send ${providedFields.join(', ')} before the files it names`,
        });
        return;
      }
      // An entity field after the last file: not what was checked.
      const firstEntity = entityAtFirstFile.get(req);
      if (firstEntity !== undefined && firstEntity !== entityKey(req.body)) throw new AttachmentError(400, ENTITY_CHANGED);
      if (files.length === 0) {
        res.status(400).json({ error: 'No valid files uploaded (allowed: PDF, DOC, DOCX, JPG, PNG, XLS, XLSX; max 5MB)' });
        return;
      }
      if (providedFields.length === 0) {
        res.status(400).json({ error: NO_ENTITY });
        return;
      }

      const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
      // A real day (calendarDay, 1800 to 2999), or none: anything else reached the INSERT,
      // which Postgres refused, a 500.
      const billDate = text(req.body.bill_date);
      if (billDate !== null && !calendarDay.safeParse(billDate).success) {
        throw new AttachmentError(400, 'bill_date must be a real date, as YYYY-MM-DD, from 1800 to 2999');
      }
      // Every file's bytes are checked before any row is written.
      const checked: CheckedFile[] = [];
      for (const file of files) checked.push({ path: file.path, originalname: file.originalname, ...(await checkUploadedFile(file)) });

      // The entity is checked again under RLS as the rows go in: it may have gone meanwhile.
      const created = await attachments.create(tenantId, checked, entityIds, {
        name: text(req.body.name),
        notes: text(req.body.notes),
        billDate,
      });
      logger.info({ userId: req.user.userId, count: created.length, entity: providedFields }, 'Attachments uploaded');
      res.status(201).json({ attachments: created });
    } finally {
      // A file moved to its final name is gone from its temporary path (and the service
      // removed it again if its transaction rolled back); any still there (a refused or
      // failed upload) goes, so it doesn't leak bytes onto the uploads volume.
      await Promise.all(files.map((f) => fsp.unlink(f.path).catch(() => undefined)));
    }
  }));

  // Stream an attachment's bytes. Replaces the old unauthenticated
  // /uploads/<safe_filename> static path: the lookup runs under RLS, so an attachment
  // belonging to another tenant is simply not found (404). Non-inline types are forced to
  // download, and nosniff blocks the browser from reinterpreting the bytes as HTML/JS.
  router.get('/file/:uuid', tenantHandler(async (req: AuthenticatedRequest, res) => {
    const file = await attachments.file(String(req.params.uuid));
    const inlineType = INLINE_CONTENT_TYPES[file.extension];

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', inlineType ?? 'application/octet-stream');
    // RFC 6266 filename*: a name outside Latin-1 made Node refuse the header, a 500.
    res.setHeader('Content-Disposition', contentDisposition(inlineType ? 'inline' : 'attachment', file.downloadName));

    fs.createReadStream(file.path).pipe(res);
  }));

  // Delete an attachment by uuid (RLS scopes the delete to the current tenant), and its
  // file once the delete has committed.
  router.delete('/:uuid', tenantNetworkHandler(async (req: AuthenticatedRequest, res, tenantId) => {
    const uuid = String(req.params.uuid);
    await attachments.remove(tenantId, uuid);
    logger.info({ userId: req.user.userId, attachmentUuid: uuid }, 'Attachment deleted');
    res.json({ message: 'Attachment deleted', uuid });
  }));

  return router;
}
