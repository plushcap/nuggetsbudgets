import React, { useMemo, useState } from 'react';
import { Box, Card, Flex, Text } from '@radix-ui/themes';
import { Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  setBudgetItemNamespaceTag,
  type ReportRoot,
  type Tag
} from '../services/api';
import { useReportRootsQuery, useTagsQuery, useBudgetItemTagsQuery } from '../hooks/queries';
import { logger } from '../utils/logger';
import { errorMessage, errorResponseMessage } from '../utils/errors';

interface Props {
  /** Budget item UUID. When null/undefined, the section renders disabled with an explanation. */
  budgetItemUuid?: string | null | undefined;
}

interface NamespaceState {
  selectedTagUuid: string | null;
  saving: boolean;
}

/**
 * Renders one single-select dropdown per report namespace. Each selection is
 * persisted immediately via the namespace-replace endpoint.
 *
 * If the host page is creating a brand-new budget item (no uuid yet), the
 * section explains that and stays hidden until after save — keeps the UX
 * simple instead of buffering selections client-side.
 */
const BudgetItemNamespaceTags: React.FC<Props> = ({ budgetItemUuid }) => {
  const { data: reportRoots = [], isLoading: rootsLoading } = useReportRootsQuery();
  const { data: allTags = [], isLoading: tagsLoading } = useTagsQuery();
  const loading = rootsLoading || tagsLoading;
  const budgetItemTagsQuery = useBudgetItemTagsQuery(budgetItemUuid ?? undefined);
  const [byNamespace, setByNamespace] = useState<Record<string, NamespaceState>>({});

  // Pre-populate the dropdowns from the budget item's current namespace taggings,
  // again whenever a new answer arrives (adjusted while rendering, not in an effect).
  // No item: nothing is selected. A query still loading keeps what is shown.
  const taggings = budgetItemUuid ? budgetItemTagsQuery.data : null;
  const [seededFrom, setSeededFrom] = useState<typeof taggings>(undefined);
  if (taggings !== seededFrom) {
    setSeededFrom(taggings);
    if (taggings === null) {
      setByNamespace({});
    } else if (taggings) {
      const next: Record<string, NamespaceState> = {};
      for (const t of taggings) {
        if (t.report_root_uuid) {
          next[t.report_root_uuid] = { selectedTagUuid: t.uuid, saving: false };
        }
      }
      setByNamespace(next);
    }
  }

  // Group tags by their root id for fast lookup
  const descendantsByRootId = useMemo(() => {
    const result: Record<number, Tag[]> = {};
    for (const root of reportRoots) result[root.id] = [];
    // Walk the tag tree: a tag belongs to a root if any ancestor id matches the root id.
    // We approximate by checking hierarchy_path's prefix against the root's name —
    // simpler is to walk parents using the flat tag list.
    const byId = new Map<number, Tag>();
    for (const t of allTags) byId.set(t.id, t);

    const findRootOf = (tag: Tag): number | null => {
      let current: Tag | undefined = tag;
      while (current) {
        if (current.parent_id === null) {
          return current.is_report_root ? current.id : null;
        }
        current = byId.get(current.parent_id);
      }
      return null;
    };

    for (const t of allTags) {
      const rootId = findRootOf(t);
      if (rootId !== null && result[rootId] !== undefined && t.id !== rootId) {
        result[rootId].push(t);
      }
    }
    return result;
  }, [reportRoots, allTags]);

  const handleChange = async (root: ReportRoot, tagUuid: string) => {
    if (!budgetItemUuid) return;
    const normalized = tagUuid === '' ? null : tagUuid;
    setByNamespace(prev => ({
      ...prev,
      [root.uuid]: { selectedTagUuid: normalized, saving: true }
    }));
    try {
      await setBudgetItemNamespaceTag(budgetItemUuid, root.uuid, normalized);
      toast.success(normalized === null
        ? `Cleared ${root.name} tag`
        : `Saved ${root.name} tag`);
      setByNamespace(prev => ({
        ...prev,
        [root.uuid]: { selectedTagUuid: normalized, saving: false }
      }));
    } catch (err) {
      logger.error({ err, budgetItemUuid, rootUuid: root.uuid, tagUuid: normalized }, 'Namespace tag save failed');
      toast.error(errorResponseMessage(err) ?? errorMessage(err, 'Failed to save namespace tag'));
      // Reload to get the actual server state
      try {
        const { data: tags } = await budgetItemTagsQuery.refetch();
        if (tags) {
          const found = tags.find(t => t.report_root_uuid === root.uuid);
          setByNamespace(prev => ({
            ...prev,
            [root.uuid]: { selectedTagUuid: found?.uuid ?? null, saving: false }
          }));
        }
      } catch { /* ignore */ }
    }
  };

  if (loading) {
    return (
      <Card>
        <Flex align="center" gap="2">
          <Layers size={16} className="text-[var(--gray-11)]" />
          <Text size="2" color="gray">Loading tags…</Text>
        </Flex>
      </Card>
    );
  }

  if (reportRoots.length === 0) {
    return null; // Quiet when no namespaces exist yet
  }

  if (!budgetItemUuid) {
    return (
      <Card>
        <Flex direction="column" gap="2">
          <Flex align="center" gap="2">
            <Layers size={16} className="text-[var(--purple-11)]" />
            <Text size="3" weight="bold" color="gray" highContrast>Report tags</Text>
          </Flex>
          <Text size="2" color="gray">
            Save this item first, then come back to assign it within {reportRoots.length === 1 && reportRoots[0]
              ? `the "${reportRoots[0].name}" namespace`
              : `${reportRoots.length} report namespaces`}.
          </Text>
        </Flex>
      </Card>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="3">
        <Flex align="center" gap="2">
          <Layers size={16} className="text-[var(--purple-11)]" />
          <Text size="3" weight="bold" color="gray" highContrast>Report tags</Text>
        </Flex>
        <Text size="2" color="gray">
          Assign one tag per namespace. Used by the Sankey report to roll up this item's contribution.
        </Text>

        {reportRoots.map(root => {
          const state = byNamespace[root.uuid] || { selectedTagUuid: null, saving: false };
          const options = descendantsByRootId[root.id] || [];
          return (
            <div key={root.uuid}>
              <label>
                <Text size="2" weight="medium" color="gray" highContrast>
                  {root.name}
                </Text>
                <Box asChild width="100%" mt="1" px="3" py="2" display="inline-block">
                <select
                  value={state.selectedTagUuid || ''}
                  disabled={state.saving}
                  onChange={(e) => handleChange(root, e.target.value)}
                  className="field-border border border-[var(--gray-a7)] rounded-[var(--radius-3)] bg-[var(--color-surface)] text-[var(--gray-12)] focus:ring-2 focus:ring-[var(--accent-8)]"
                >
                  <option value="">— None —</option>
                  {options
                    .slice()
                    .sort((a, b) => (a.hierarchy_path || a.name).localeCompare(b.hierarchy_path || b.name))
                    .map(t => (
                      <option key={t.id} value={t.uuid}>
                        {t.hierarchy_path || t.name}
                      </option>
                    ))}
                </select>
                </Box>
              </label>
              {state.saving && (
                <Text size="1" color="gray" mt="1" as="div">Saving…</Text>
              )}
            </div>
          );
        })}
      </Flex>
    </Card>
  );
};

export default BudgetItemNamespaceTags;
