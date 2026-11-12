import { sql, type Kysely, type RawBuilder } from 'kysely';
import path from 'path';
import type { DB } from '../db/schema.generated.js';
import { getDb } from '../db/withTenant.js';
import { sanitizeImage } from '../utils/uploadSafety.js';
import { UploadRejectedError } from '../utils/imageUpload.js';

/**
 * ImageService — small identity images stored as bytea, so they ride the DB
 * backup/restore instead of living only on the filesystem.
 *
 * - A ledger's images (account / goal / merchant) are `stored_images` rows, always
 *   that ledger's: store and read them on `getDb()`, the request's tenant
 *   transaction. tenant_id defaults to the current ledger and RLS keeps every
 *   other ledger's rows out.
 * - Profile pictures are `user_profile_images` rows, one per user. That table has
 *   no tenant and no RLS, so these functions scope it by user id themselves.
 */

/** Raster image types we accept — deliberately excludes SVG (can carry script). */
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const EXTENSION_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export interface StoreImageInput {
  /** The type the upload claimed. What's stored is the type its bytes are. */
  mimeType: string;
  data: Buffer;
  /** Audit only (shared-data model) — who uploaded it. */
  createdByUserId?: number | null;
}

export function isAllowedImageMimeType(mimeType: string): boolean {
  return ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

/** Map a filename's extension to a safe raster MIME type, or null if unknown. */
export function mimeTypeForFilename(filename: string): string | null {
  return EXTENSION_TO_MIME[path.extname(filename).toLowerCase()] ?? null;
}

/**
 * The image as it is stored: its type read from its bytes, whatever the upload claimed,
 * and its metadata (EXIF location, XMP, comments) removed. Throws
 * UploadRejectedError (a 400) when the bytes aren't a JPEG, PNG, GIF or WebP image, so a
 * spoofed upload can never be stored and later served as executable content.
 */
function storableImage(input: StoreImageInput): { mimeType: string; data: Buffer } {
  const image = sanitizeImage(input.data);
  if (!isAllowedImageMimeType(image.mimeType)) throw new UploadRejectedError('Only JPG, PNG, GIF and WebP images can be uploaded.');
  return image;
}

/**
 * Insert one of the current ledger's images and return its public uuid. `db` is
 * `getDb()`: the row's tenant_id is the ledger's (its column default), and outside
 * a ledger the insert fails. The bytes must be a raster image ({@link storableImage}).
 */
export async function storeImage(db: Kysely<DB>, input: StoreImageInput): Promise<string> {
  const image = storableImage(input);

  const row = await db
    .insertInto('stored_images')
    .values({
      mime_type: image.mimeType,
      byte_size: image.data.length,
      data: image.data,
      created_by_user_id: input.createdByUserId ?? null,
    })
    .returning('uuid')
    .executeTakeFirstOrThrow();

  return row.uuid;
}

/** Fetch one of the current ledger's images by uuid, or null if it doesn't exist / is not visible under RLS. */
export async function getImage(
  db: Kysely<DB>,
  uuid: string
): Promise<{ mimeType: string; data: Buffer; byteSize: number } | null> {
  const row = await db
    .selectFrom('stored_images')
    .select(['mime_type', 'data', 'byte_size'])
    .where('uuid', '=', uuid)
    .executeTakeFirst();

  if (!row) return null;
  return { mimeType: row.mime_type, data: row.data as Buffer, byteSize: row.byte_size };
}

/**
 * The image GET /api/images/:uuid serves `viewerUserId`: one of the current ledger's
 * (stored_images, under RLS), else a profile picture they may see ({@link getProfileImage});
 * null for neither. On the request's tenant transaction (getDb()).
 */
export async function imageForViewer(
  uuid: string,
  viewerUserId: number
): Promise<{ mimeType: string; data: Buffer; byteSize: number } | null> {
  const db = getDb();
  return (await getImage(db, uuid)) ?? (await getProfileImage(db, uuid, viewerUserId));
}

/** The public URL a column stores for an image uuid (served by GET /api/images/:uuid). */
export function imageUrl(uuid: string): string {
  return `/api/images/${uuid}`;
}

const IMAGE_URL_RE = /^\/api\/images\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The image uuid in an `/api/images/<uuid>` URL, or null for anything else. */
function imageUuidOf(url: string | null | undefined): string | null {
  if (!url) return null;
  return IMAGE_URL_RE.exec(url)?.[1]?.toLowerCase() ?? null;
}

/** The uuid in an image URL ('/api/images/<uuid>', any case, absolute or not), or NULL: SQL. */
const imageUuidIn = (column: RawBuilder<unknown>) =>
  sql`substring(lower(${column}) from '/api/images/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})')`;

/**
 * The image uuids (text, NULL for a column that names none) the current ledger's rows
 * point at: an account's, a budget item's (a goal's) or a merchant's image. Under RLS a
 * ledger's transaction sees only its own rows. An image none of them names is unused:
 * the retention job deletes it a day after it was stored, and deleteImageByUrl
 * at once.
 */
export const tenantImageReferences = sql<{ uuid: string | null }>`
  SELECT ${imageUuidIn(sql.ref('account_image'))} AS uuid FROM accounts WHERE account_image IS NOT NULL
  UNION SELECT ${imageUuidIn(sql.ref('image_path'))} FROM budget_items WHERE image_path IS NOT NULL
  UNION SELECT ${imageUuidIn(sql.ref('merchant_image'))} FROM merchants WHERE merchant_image IS NOT NULL`;

/**
 * Delete the ledger image a column URL points at (`/api/images/<uuid>`) unless something
 * else in the ledger still points at it (tenantImageReferences): one image can be an
 * account's, a goal's and a merchant's at once, since a merchant's merchant_image may name
 * any of the ledger's images. So call it after the row that named it has been changed. No-op
 * for a null/legacy `/uploads/...` path or any unrecognized value, so it's safe to call on
 * replace/delete without knowing the prior storage form. Under RLS it reaches only the
 * current ledger's images, never another's or a profile picture.
 */
export async function deleteImageByUrl(db: Kysely<DB>, url: string | null | undefined): Promise<void> {
  const uuid = imageUuidOf(url);
  if (!uuid) return;
  // Locked first, then checked in a statement of its own (a new snapshot): a request
  // pointing a row at this image (isTenantImageUrl locks it) has committed by then, and
  // the check sees its row.
  const image = await db.selectFrom('stored_images').select('id').where('uuid', '=', uuid).forUpdate().executeTakeFirst();
  if (!image) return;
  await sql`
    DELETE FROM stored_images
     WHERE id = ${image.id}
       AND NOT EXISTS (SELECT 1 FROM (${tenantImageReferences}) refs WHERE refs.uuid = ${uuid})`.execute(db);
}

/**
 * Whether `url` is `/api/images/<uuid>` for an image of the current ledger: what an
 * image column a client may set (merchant_image) has to name, so it can't point at
 * another ledger's image or a profile picture. The image is locked (FOR KEY SHARE) until
 * the request ends, so deleteImageByUrl can't delete it in the meantime.
 */
export async function isTenantImageUrl(db: Kysely<DB>, url: string): Promise<boolean> {
  const uuid = imageUuidOf(url);
  if (!uuid) return false;
  const row = await db.selectFrom('stored_images').select('id').where('uuid', '=', uuid).forKeyShare().executeTakeFirst();
  return row !== undefined;
}

/**
 * Store `userId`'s profile picture, replacing any they had, and return its uuid. A
 * replacement gets a new uuid: the image route caches a uuid's bytes for good.
 */
export async function storeProfileImage(
  db: Kysely<DB>,
  userId: number,
  input: StoreImageInput
): Promise<string> {
  const image = storableImage(input);
  const values = {
    mime_type: image.mimeType,
    byte_size: image.data.length,
    data: image.data,
    created_by_user_id: input.createdByUserId ?? null,
  };
  const row = await db
    .insertInto('user_profile_images')
    .values({ user_id: userId, ...values })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({ ...values, uuid: sql<string>`uuidv7()`, created_at: sql<Date>`now()` })
    )
    .returning('uuid')
    .executeTakeFirstOrThrow();
  return row.uuid;
}

/** Delete `userId`'s profile picture, if they have one. */
export async function deleteProfileImage(db: Kysely<DB>, userId: number): Promise<void> {
  await db.deleteFrom('user_profile_images').where('user_id', '=', userId).execute();
}

/**
 * A profile picture by uuid, for `viewerUserId`: their own, one of someone who shares
 * an organization or a ledger with them, or any for a deployment admin. Otherwise null,
 * as for one that doesn't exist. user_profile_images has no RLS, so this is the check.
 */
export async function getProfileImage(
  db: Kysely<DB>,
  uuid: string,
  viewerUserId: number
): Promise<{ mimeType: string; data: Buffer; byteSize: number } | null> {
  const row = await db
    .selectFrom('user_profile_images as p')
    .select(['p.mime_type', 'p.data', 'p.byte_size'])
    .where('p.uuid', '=', uuid)
    .where((eb) =>
      eb.or([
        eb('p.user_id', '=', viewerUserId),
        eb.exists(
          eb
            .selectFrom('organization_users as viewer')
            .innerJoin('organization_users as owner', 'owner.organization_id', 'viewer.organization_id')
            .select('viewer.id')
            .where('viewer.user_id', '=', viewerUserId)
            .whereRef('owner.user_id', '=', 'p.user_id')
        ),
        eb.exists(
          eb
            .selectFrom('tenant_users as viewer')
            .innerJoin('tenant_users as owner', 'owner.tenant_id', 'viewer.tenant_id')
            .select('viewer.id')
            .where('viewer.user_id', '=', viewerUserId)
            .whereRef('owner.user_id', '=', 'p.user_id')
        ),
        eb.exists(
          eb
            .selectFrom('deployment_users as d')
            .select('d.id')
            .where('d.user_id', '=', viewerUserId)
            .where('d.role', '=', 'admin')
        ),
      ])
    )
    .executeTakeFirst();

  if (!row) return null;
  return { mimeType: row.mime_type, data: row.data as Buffer, byteSize: row.byte_size };
}
