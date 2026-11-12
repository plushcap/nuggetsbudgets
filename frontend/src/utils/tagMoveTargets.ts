import { TAG_DEEPEST_LEVEL } from '@nuggets/shared';

/** What a tag needs to say where it sits: its id, its parent's, its level and whether it is a report root. */
export interface PlacedTag {
  id: number;
  parent_id: number | null;
  level: number;
  is_report_root?: boolean | null | undefined;
}

/** The tag `tagId` and every tag below it, and how many levels of tags are below it. */
function subtree(tags: readonly PlacedTag[], tagId: number): { ids: Set<number>; height: number } {
  const children = new Map<number, number[]>();
  for (const t of tags) {
    if (t.parent_id !== null) children.set(t.parent_id, [...(children.get(t.parent_id) ?? []), t.id]);
  }
  const ids = new Set<number>([tagId]);
  let height = 0;
  for (let level = [tagId]; ; height++) {
    level = level.flatMap((id) => children.get(id) ?? []).filter((id) => !ids.has(id));
    if (level.length === 0) break;
    level.forEach((id) => ids.add(id));
  }
  return { ids, height };
}

/**
 * The tags the tag `tagId` may be moved under, as the server checks a move: not
 * itself or a tag below it, and only where it and the tags below it stay within the deepest
 * level (the parent's level + 1 + how many levels of tags are below it). A report root is a
 * top-level tag, so it takes none. Its current parent is always one: staying put isn't a
 * move, and an older install may hold a tag deeper than the deepest level.
 */
export function tagMoveTargets<T extends PlacedTag>(tags: readonly T[], tagId: number): T[] {
  const tag = tags.find((t) => t.id === tagId);
  const { ids: below, height } = subtree(tags, tagId);
  return tags.filter(
    (t) =>
      t.id === tag?.parent_id ||
      (!tag?.is_report_root && !below.has(t.id) && t.level + 1 + height <= TAG_DEEPEST_LEVEL)
  );
}

/**
 * Whether the tag `tagId` may be moved to the top level: the server refuses it when the tags
 * below it would pass the deepest level there (four levels of them or more, which an older
 * install may hold). A top-level tag stays where it is.
 */
export function mayMoveToTop(tags: readonly PlacedTag[], tagId: number): boolean {
  const tag = tags.find((t) => t.id === tagId);
  return !tag || tag.parent_id === null || subtree(tags, tagId).height <= TAG_DEEPEST_LEVEL;
}
