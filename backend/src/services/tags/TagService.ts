import { sql } from 'kysely';
import { TAG_DEEPEST_LEVEL, TAG_MAX_LEVELS, type TagReportFlowMeasure } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { errorCode, errorConstraint, errorMessage } from '../../utils/errors.js';
import {
  circularParent,
  moveNamespaceConflict,
  notTopLevel,
  ownParent,
  parentMissing,
  reportRootTopLevel,
  tagHasChildren,
  tagNameTaken,
  tagNotFound,
  tooDeep,
} from './TagError.js';
import { asId } from '../tenantReferences.js';
import { lockRowsForDelete } from '../transactions/locks.js';
import { oneRow } from '../../utils/present.js';

const logger = createLogger({ service: 'TagService' });

/** What the tag list and a single tag answer: the tag with its place in the hierarchy and its use. */
const TAG_WITH_HIERARCHY = [
  'id', 'uuid', 'name', 'color', 'icon', 'description',
  'parent_id', 'level', 'sort_order', 'is_active',
  'is_report_root', 'report_flow_measure',
  'created_at', 'updated_at',
  'hierarchy_path', 'parent_name', 'parent_uuid',
  'child_count', 'transaction_count', 'budget_item_count',
  'last_used_at',
] as const;

/** What a create or update answers: the tag's own columns. */
const TAG_COLUMNS = [
  'id', 'uuid', 'name', 'color', 'icon', 'description', 'parent_id', 'level', 'sort_order', 'is_active', 'created_at', 'updated_at',
] as const;

const DEFAULT_COLOR = '#3B82F6';
const DEFAULT_ICON = 'Tag';

/**
 * Tags go four levels deep, levels 0 to 3: a parent at the deepest level takes no
 * child, and a move may not take the tags below the moved one past it. The
 * database's tag triggers refuse the same (calculate_tag_level a new tag,
 * calculate_descendant_tag_levels a move); these checks answer first, before any write.
 */
const MAX_PARENT_LEVEL = TAG_DEEPEST_LEVEL;

/**
 * The lock a ledger's tag moves, new tags and deletes take, one at a time: the tag
 * triggers' calculate_descendant_tag_levels takes it too, with
 * this class as 1413564243. Taken before the checks here, so they read the tags as a move
 * another request committed left them, and refuse what the two together would break (a
 * loop, a tag past the deepest level, a delete of a tag just given children) with a 400,
 * not the trigger's 500 or a cascade. Held until the request's transaction ends.
 */
const TAG_TREE_LOCK_CLASS = 0x54414753;

async function lockTagTree(): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(${TAG_TREE_LOCK_CLASS}::int, current_tenant_id())`.execute(getDb());
}

/** The per-namespace uniqueness of a budget item's tags (one tag per report root). */
export const NAMESPACE_INDEX = 'idx_taggings_one_tag_per_report_namespace';

/** A tag as a client writes it. Fields not sent take their defaults. */
export interface TagInput {
  name: string;
  color?: string | null | undefined;
  icon?: string | null | undefined;
  description?: string | null | undefined;
  /** As the client sent it: a tag id (a number, or its digits as text), or null for none. */
  parent_id?: unknown;
  sort_order?: number | null | undefined;
  is_active?: boolean | undefined;
}

/**
 * A parent as a client sends it, as a number to compare with ids: not sent (undefined),
 * none (null), a tag id, or 'invalid' for anything that can't be one. A move compared the
 * value as sent, so a tag's own id as text wasn't its own id, and the move made a cycle.
 */
function sentParent(value: unknown): number | null | undefined | 'invalid' {
  if (value === undefined || value === null) return value;
  return asId(value) ?? 'invalid';
}

/**
 * How many levels of tags are below tag `tagId` (0 for none), counted up to TAG_MAX_LEVELS:
 * more is too deep wherever it goes. The walk leaves out the tag itself, as the trigger's
 * does (in a loop of parents an older install may hold, the move takes it out).
 */
async function heightBelow(tagId: number): Promise<number> {
  const { rows } = await sql<{ height: number }>`
    WITH RECURSIVE below(id, depth) AS (
      SELECT id, 1 FROM tags WHERE parent_id = ${tagId} AND id <> ${tagId}
      UNION ALL
      SELECT t.id, b.depth + 1 FROM tags t JOIN below b ON t.parent_id = b.id
       WHERE b.depth < ${TAG_MAX_LEVELS} AND t.id <> ${tagId}
    )
    SELECT COALESCE(MAX(depth), 0)::int AS height FROM below
  `.execute(getDb());
  return oneRow(rows, 'the height').height;
}

/** The ids of tag `tagId` and every tag below it (get_child_tag_ids includes the tag itself). */
export async function tagAndDescendantIds(tagId: number): Promise<number[]> {
  const rows = await sql<{ tag_id: number }>`SELECT tag_id FROM get_child_tag_ids(${tagId})`.execute(getDb());
  return rows.rows.map((row) => row.tag_id);
}

/** The id of the tag `uuid` names, or null. */
export async function tagIdOf(uuid: string): Promise<number | null> {
  const row = await getDb().selectFrom('tags').select('id').where('uuid', '=', uuid).executeTakeFirst();
  return row?.id ?? null;
}

/**
 * The ledger's tags: their hierarchy, report namespaces and order. Names are unique
 * ignoring case and surrounding space; a report root is a top-level tag.
 */
export class TagService {
  /** Every tag, by level, then order, then name. */
  list() {
    return getDb()
      .selectFrom('tags_with_hierarchy')
      .select(TAG_WITH_HIERARCHY)
      .orderBy('level', 'asc')
      .orderBy('sort_order', 'asc')
      .orderBy('name', 'asc')
      .execute();
  }

  /** The report roots (namespaces), each with how many tags are below it and how many budget items it tags. */
  async listReportRoots() {
    const result = await sql<{
      id: number;
      uuid: string | null;
      name: string;
      color: string | null;
      icon: string | null;
      description: string | null;
      report_flow_measure: string | null;
      created_at: Date | null;
      updated_at: Date | null;
      descendant_count: string;
      budget_item_tagging_count: string;
    }>`
      SELECT
        t.id,
        t.uuid,
        t.name,
        t.color,
        t.icon,
        t.description,
        t.report_flow_measure,
        t.created_at,
        t.updated_at,
        (SELECT COUNT(*) FROM get_child_tag_ids(t.id)) - 1 AS descendant_count,
        (SELECT COUNT(*) FROM taggings tg
            WHERE tg.report_root_id = t.id
              AND tg.taggable_type = 'budget_item') AS budget_item_tagging_count
      FROM tags t
      WHERE t.is_report_root = true
      ORDER BY t.name ASC
    `.execute(getDb());
    return result.rows;
  }

  /** The tag `uuid` names, with its place in the hierarchy, or undefined. */
  find(uuid: string) {
    return getDb().selectFrom('tags_with_hierarchy').select(TAG_WITH_HIERARCHY).where('uuid', '=', uuid).executeTakeFirst();
  }

  /** A new tag, unless its name is taken or its parent can't take a child. `input.name` is trimmed. */
  async create(input: TagInput): Promise<TagRow> {
    const name = input.name.trim();
    await lockTagTree();
    if (await this.nameTaken(name)) throw tagNameTaken();

    const parentId = sentParent(input.parent_id);
    if (parentId === 'invalid') throw parentMissing();
    if (parentId !== null && parentId !== undefined) await this.parentLevel(parentId, 'create');

    const created = await getDb()
      .insertInto('tags')
      .values({
        name,
        color: input.color || DEFAULT_COLOR,
        icon: input.icon || DEFAULT_ICON,
        description: input.description?.trim() || null,
        parent_id: parentId ?? null,
        sort_order: input.sort_order || 0,
        is_active: input.is_active !== undefined ? input.is_active : true,
      })
      .returning(TAG_COLUMNS)
      .executeTakeFirstOrThrow();

    logger.info({ tagId: created.id, parentId }, 'Tag created');
    return created;
  }

  /**
   * Rewrites the tag `uuid` names. A parent not sent keeps the current one; the other
   * fields not sent take their defaults. A move may not make the tag its own ancestor,
   * take a report root under a parent, take the tags below the moved one past the deepest
   * level, nor put two tags of one report namespace on a budget item.
   */
  async update(uuid: string, input: TagInput): Promise<TagRow> {
    const name = input.name.trim();
    await lockTagTree();
    const current = await getDb()
      .selectFrom('tags')
      .select(['id', 'parent_id', 'is_report_root'])
      .where('uuid', '=', uuid)
      .executeTakeFirst();
    if (!current) throw tagNotFound();

    if (await this.nameTaken(name, current.id)) throw tagNameTaken();

    const parentId = sentParent(input.parent_id);
    if (parentId === 'invalid') throw parentMissing();
    if (parentId !== undefined && parentId !== current.parent_id) {
      if (parentId === current.id) throw ownParent();
      let level = 0;
      if (parentId !== null) {
        const parent = await this.parentLevel(parentId, 'move');
        if ((await tagAndDescendantIds(current.id)).includes(parentId)) throw circularParent();
        // A report root is a top-level tag (chk_tags_report_root_top_level, a 500).
        if (current.is_report_root) throw reportRootTopLevel();
        level = parent + 1;
      }
      // The tags below come along.
      if (level + (await heightBelow(current.id)) > MAX_PARENT_LEVEL) throw tooDeep('move');
    }

    let updated: TagRow | undefined;
    try {
      const written = await getDb()
        .updateTable('tags')
        .set({
          name,
          color: input.color || DEFAULT_COLOR,
          icon: input.icon || DEFAULT_ICON,
          description: input.description?.trim() || null,
          parent_id: parentId !== undefined ? parentId : current.parent_id,
          sort_order: input.sort_order !== undefined ? input.sort_order : 0,
          is_active: input.is_active !== undefined ? input.is_active : true,
        })
        .where('uuid', '=', uuid)
        .returning('id')
        .executeTakeFirst();
      // Read back once the statement is done: a moved tag's level is set by an AFTER trigger
      // (trg_calculate_descendant_tag_levels), which RETURNING doesn't see.
      updated = written && (await getDb().selectFrom('tags').select(TAG_COLUMNS).where('id', '=', written.id).executeTakeFirstOrThrow());
    } catch (err) {
      // Re-parenting a tag can cascade into the descendant-taggings refresh trigger and
      // violate the per-namespace uniqueness on a budget item that already carries
      // another descendant of the new root. The error answer rolls the request back.
      if (errorCode(err) === '23505' && errorConstraint(err) === NAMESPACE_INDEX) {
        logger.warn({ uuid, err: errorMessage(err) }, 'Tag re-parent rejected: would violate namespace uniqueness');
        throw moveNamespaceConflict();
      }
      throw err;
    }
    if (!updated) throw tagNotFound();

    logger.info({ tagId: updated.id }, 'Tag updated');
    return updated;
  }

  /**
   * Marks or unmarks the tag `uuid` names as a report namespace root; only a top-level
   * tag can be one. A flow measure not sent is left as it is.
   */
  async setReportRoot(
    uuid: string,
    isReportRoot: boolean,
    flowMeasure: TagReportFlowMeasure | undefined
  ) {
    const current = await getDb().selectFrom('tags').select(['id', 'parent_id']).where('uuid', '=', uuid).executeTakeFirst();
    if (!current) throw tagNotFound();
    if (isReportRoot && current.parent_id !== null) throw notTopLevel();

    const result = await getDb()
      .updateTable('tags')
      .set(flowMeasure !== undefined ? { is_report_root: isReportRoot, report_flow_measure: flowMeasure } : { is_report_root: isReportRoot })
      .where('uuid', '=', uuid)
      .returning(['id', 'uuid', 'name', 'is_report_root', 'report_flow_measure'])
      .executeTakeFirst();

    logger.info({ tagUuid: uuid, isReportRoot, reportFlowMeasure: flowMeasure }, 'Tag report-root updated');
    return result;
  }

  /**
   * Deletes the tag `uuid` names, unless tags sit below it. Under the ledger's tag lock: a
   * move under it that another request hadn't committed yet wasn't counted, and the delete
   * then took the moved tag and everything below it with it (ON DELETE CASCADE).
   */
  async remove(uuid: string): Promise<void> {
    await lockTagTree();
    const children = await getDb()
      .selectFrom('tags')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('parent_id', '=', (eb) => eb.selectFrom('tags').select('id').where('uuid', '=', uuid))
      .executeTakeFirstOrThrow();
    if (parseInt(children.count) > 0) throw tagHasChildren();

    // The merchants, then the budget items, whose auto-tag it is, each in id order:
    // the delete empties it on them (ON DELETE SET NULL), which took them in the order it found
    // them, and could deadlock with a write of several items in id order (a zone change, a
    // merchant merge, which locks its merchants before its items).
    const autoTagged = (table: 'merchants' | 'budget_items') =>
      getDb().selectFrom(table).select('id')
        .where('transaction_auto_tag_id', '=', (eb) => eb.selectFrom('tags').select('id').where('uuid', '=', uuid))
        .orderBy('id').forNoKeyUpdate().execute();
    await lockRowsForDelete('this tag', async () => {
      await autoTagged('merchants');
      await autoTagged('budget_items');
    });

    const deleted = await getDb().deleteFrom('tags').where('uuid', '=', uuid).returning(['id']).execute();
    const [removed] = deleted;
    if (!removed) throw tagNotFound();

    logger.info({ tagId: removed.id }, 'Tag deleted');
  }

  /** Whether another tag than `exceptId` has this name, ignoring case and surrounding space. */
  private async nameTaken(name: string, exceptId?: number): Promise<boolean> {
    let query = getDb().selectFrom('tags').select('id').where(sql`LOWER(TRIM(name))`, '=', sql`LOWER(${name})`);
    if (exceptId !== undefined) query = query.where('id', '!=', exceptId);
    return (await query.execute()).length > 0;
  }

  /**
   * The level of the tag `parentId`; refused when it isn't there or can't take a child
   * (`verb`: what was being done). A value that can't be a tag id (one past `integer`, 'x')
   * names no tag: Postgres refused it in the query, a 500.
   */
  private async parentLevel(parentId: unknown, verb: 'create' | 'move'): Promise<number> {
    const id = asId(parentId);
    if (id === null) throw parentMissing();
    const parent = await getDb().selectFrom('tags').select(['id', 'level']).where('id', '=', id).executeTakeFirst();
    if (!parent) throw parentMissing();
    if ((parent.level ?? 0) >= MAX_PARENT_LEVEL) throw tooDeep(verb);
    return parent.level ?? 0;
  }
}

/** A tag's own columns, as a create or update answers them. */
export type TagRow = {
  id: number;
  uuid: string;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  parent_id: number | null;
  level: number | null;
  sort_order: number | null;
  is_active: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
};
