import { sql } from 'kysely';
import type { SankeyDirection, TagReportFlowMeasure } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { centsToNumber, numericToCents } from '../../utils/money.js';
import { notAReportRoot, reportPeriodNotFound, reportRootNotFound } from './reportErrors.js';
import { budgetExpenseType } from '@nuggets/shared';

const logger = createLogger({ service: 'SankeyReportService' });

interface NamespaceTagRow {
  id: number;
  uuid: string;
  name: string;
  color: string;
  parent_id: number | null;
  level: number;
}

interface ContributionRow {
  budget_item_id: number;
  budget_item_uuid: string;
  budget_item_name: string;
  expense_type: string | null;
  rollover: boolean;
  tag_id: number | null;
  contribution: string;       // numeric arrives as string from pg
  rule_applied: string;
}

interface DrilldownItem {
  budget_item_uuid: string;
  budget_item_name: string;
  contribution: number;
  rule_applied: string;
}

/** What a Sankey report is about and over, as GET /api/reports/sankey/:rootTagUuid's query gives it. */
export interface SankeyReportInput {
  rootTagUuid: string;
  /** A range of days (either end open), or a budget period's days and allocations. */
  startDate?: string | undefined;
  endDate?: string | undefined;
  budgetPeriodUuid?: string | undefined;
  /** Echoed for the chart. */
  direction: SankeyDirection;
  includeUntagged: boolean;
  includeTransfers: boolean;
  /** The namespace's own flow measure (else 'effective') when not given. */
  flowMeasureOverride?: TagReportFlowMeasure | undefined;
}

/**
 * The cash-flow Sankey of a tag namespace (a report root and its descendants): each budget
 * item's contribution in the window (its transactions, or its allocations, by the flow
 * measure), rolled up the tag tree, with the items untagged in the namespace in a node of
 * their own, and a drilldown of each tag's items. Every query runs on getDb(), the request's
 * tenant transaction, so RLS keeps it to the active ledger.
 */
export class SankeyReportService {
  async getReport(input: SankeyReportInput) {
    // Resolve the report root
    const root = await getDb()
      .selectFrom('tags')
      .select(['id', 'uuid', 'name', 'color', 'report_flow_measure', 'is_report_root'])
      .where('uuid', '=', input.rootTagUuid)
      .executeTakeFirst();

    if (!root) throw reportRootNotFound();
    if (!root.is_report_root) throw notAReportRoot();

    const flowMeasure: TagReportFlowMeasure =
      input.flowMeasureOverride ||
      (root.report_flow_measure as TagReportFlowMeasure) ||
      'effective';

    // Derive the actual transaction window + allocation period filter
    let txStartDate: string | null;
    let txEndDate: string | null;
    let periodId: number | null = null;

    if (input.budgetPeriodUuid) {
      const periodRow = await getDb()
        .selectFrom('budget_period')
        .select([
          'id',
          sql<string>`start_date::TEXT`.as('start_date'),
          sql<string>`end_date::TEXT`.as('end_date')
        ])
        .where('uuid', '=', input.budgetPeriodUuid)
        .executeTakeFirst();
      if (!periodRow) throw reportPeriodNotFound();
      periodId = periodRow.id;
      txStartDate = periodRow.start_date;
      txEndDate = periodRow.end_date;
    } else {
      txStartDate = input.startDate ?? null;
      txEndDate = input.endDate ?? null;
    }

    const { includeUntagged, includeTransfers } = input;

    // Pull every tag in the namespace (root + descendants) with hierarchy info.
    // get_child_tag_ids() DB function — kept as raw sql
    const namespaceTagsResult = await sql<NamespaceTagRow>`
      SELECT t.id, t.uuid, t.name, t.color, t.parent_id, t.level
         FROM tags t
        WHERE t.id IN (SELECT tag_id FROM get_child_tag_ids(${root.id}))
        ORDER BY t.level ASC, t.name ASC
    `.execute(getDb());

    const tagsById = new Map<number, NamespaceTagRow>();
    for (const t of namespaceTagsResult.rows) tagsById.set(t.id, t);

    // Per-budget-item contributions joined with their namespace tag (if any).
    // For the residual, also include items with no tag in this namespace.
    // CTEs with DB function call (calculate_budget_for_period_item) — kept as raw sql
    const contributionsResult = await sql<ContributionRow>`
      WITH tx_contrib AS (
         SELECT t.budget_item_id, SUM(t.amount) AS amount
           FROM transactions t
          WHERE t.budget_item_id IS NOT NULL
            AND t.is_split_parent = false
            AND (${txStartDate}::date IS NULL OR t.transaction_date >= ${txStartDate})
            AND (${txEndDate}::date IS NULL OR t.transaction_date <= ${txEndDate})
            AND (${includeTransfers}::boolean OR t.type != 'transfer')
          GROUP BY t.budget_item_id
       ),
       alloc_contrib AS (
         SELECT bpi.budget_item_id,
                SUM(calculate_budget_for_period_item(bpi.id)) AS amount
           FROM budget_period_items bpi
           INNER JOIN budget_period bp ON bp.id = bpi.budget_period_id
          WHERE (${periodId}::int IS NULL OR bpi.budget_period_id = ${periodId})
            AND (${periodId}::int IS NOT NULL
                 OR (bp.start_date <= ${txEndDate}::date AND bp.end_date >= ${txStartDate}::date))
          GROUP BY bpi.budget_item_id
       ),
       item_tag AS (
         SELECT tg.taggable_id AS budget_item_id, tg.tag_id
           FROM taggings tg
          WHERE tg.taggable_type = 'budget_item'
            AND tg.report_root_id = ${root.id}
       )
       SELECT
         bi.id AS budget_item_id,
         bi.uuid AS budget_item_uuid,
         bi.name AS budget_item_name,
         bi.expense_type,
         bi.rollover,
         it.tag_id,
         CASE
           WHEN ${flowMeasure}::text = 'actual'    THEN COALESCE(tx.amount, 0)
           WHEN ${flowMeasure}::text = 'allocated' THEN COALESCE(ac.amount, 0)
           WHEN bi.expense_type = 'Income' THEN COALESCE(tx.amount, 0)
           WHEN bi.rollover = true         THEN COALESCE(ac.amount, 0)
           ELSE COALESCE(tx.amount, 0)
         END AS contribution,
         CASE
           WHEN ${flowMeasure}::text = 'actual'    THEN 'actual_override'
           WHEN ${flowMeasure}::text = 'allocated' THEN 'allocated_override'
           WHEN bi.expense_type = 'Income' THEN 'income_transactions'
           WHEN bi.rollover = true         THEN 'rollover_allocation'
           ELSE 'expense_transactions'
         END AS rule_applied
       FROM budget_items bi
       LEFT JOIN item_tag    it ON it.budget_item_id = bi.id
       LEFT JOIN tx_contrib  tx ON tx.budget_item_id = bi.id
       LEFT JOIN alloc_contrib ac ON ac.budget_item_id = bi.id
       -- Archived items keep their history in reports.
       WHERE bi.status IN ('active', 'archived')
       ORDER BY bi.id
    `.execute(getDb());

    // ---- In-memory aggregation ----
    // In integer cents (utils/money.ts): summed as floats, the totals came out as
    // 405.54999999999995. Converted to dollars only in the answer.

    // Direct (leaf-level) contributions before rollup, keyed by tag_id.
    // Also captures untagged + drilldown items.
    const directByTag = new Map<number, number>();
    // Same keyed map, but only counts contributions from budget items whose
    // expense_type = 'Income'. Used to detect "income subtrees" so we can
    // reverse their link direction and produce a classic income-left /
    // outflow-right Sankey layout.
    const directIncomeByTag = new Map<number, number>();
    const drilldown = new Map<number | 'untagged', DrilldownItem[]>();
    let untaggedTotal = 0;
    let incomeTotal = 0;
    let outflowTotal = 0;

    for (const row of contributionsResult.rows) {
      const contributionCents = numericToCents(row.contribution);
      // Skip true zeroes — they add no signal.
      if (contributionCents === 0) continue;

      const absContribution = Math.abs(contributionCents);
      const isIncome = row.expense_type === budgetExpenseType.enum.Income;
      if (isIncome) incomeTotal += absContribution;
      else outflowTotal += absContribution;

      const drillItem: DrilldownItem = {
        budget_item_uuid: row.budget_item_uuid,
        budget_item_name: row.budget_item_name,
        contribution: centsToNumber(contributionCents),
        rule_applied: row.rule_applied
      };

      if (row.tag_id === null || !tagsById.has(row.tag_id)) {
        // Untagged-within-this-namespace
        untaggedTotal += absContribution;
        if (!drilldown.has('untagged')) drilldown.set('untagged', []);
        drilldown.get('untagged')!.push(drillItem);
      } else {
        directByTag.set(row.tag_id, (directByTag.get(row.tag_id) ?? 0) + absContribution);
        if (isIncome) {
          directIncomeByTag.set(row.tag_id, (directIncomeByTag.get(row.tag_id) ?? 0) + absContribution);
        }
        if (!drilldown.has(row.tag_id)) drilldown.set(row.tag_id, []);
        drilldown.get(row.tag_id)!.push(drillItem);
      }
    }

    // Roll contributions up the tree. Each tag (including the root)
    // accumulates the sum of contributions from itself + all descendants.
    const rollupByTag = new Map<number, number>();
    for (const [tagId, value] of directByTag.entries()) {
      let current: number | null = tagId;
      while (current !== null) {
        rollupByTag.set(current, (rollupByTag.get(current) ?? 0) + value);
        const node = tagsById.get(current);
        current = node ? node.parent_id : null;
      }
    }

    // Same rollup for income-only contributions.
    const rollupIncomeByTag = new Map<number, number>();
    for (const [tagId, value] of directIncomeByTag.entries()) {
      let current: number | null = tagId;
      while (current !== null) {
        rollupIncomeByTag.set(current, (rollupIncomeByTag.get(current) ?? 0) + value);
        const node = tagsById.get(current);
        current = node ? node.parent_id : null;
      }
    }

    // Classify each level-1 child of the root: "income subtree" if its rolled-up
    // income contributions exceed half its total. These get their link direction
    // reversed (child→parent) so income tags land on the left, root in the middle,
    // and outflow tags on the right — the classic cash-flow Sankey layout.
    const incomeSubtreeRoots = new Set<number>();
    for (const tag of namespaceTagsResult.rows) {
      if (tag.parent_id !== root.id) continue;
      const total = rollupByTag.get(tag.id) ?? 0;
      const income = rollupIncomeByTag.get(tag.id) ?? 0;
      if (total > 0 && income > total / 2) {
        incomeSubtreeRoots.add(tag.id);
      }
    }

    // Find which level-1 child of the root (if any) contains this tag.
    const findLevel1Ancestor = (tagId: number): number | null => {
      let current: number | null = tagId;
      while (current !== null) {
        const node = tagsById.get(current);
        if (!node) return null;
        if (node.parent_id === root.id) return current;
        if (current === root.id) return null;
        current = node.parent_id;
      }
      return null;
    };

    // Build nodes — emit each namespace tag whose rollup is non-zero,
    // plus every ancestor on the path to the root (already covered by rollup).
    const nodes: Array<{ id: string; label: string; level: number; color: string }> = [];
    const emittedTagIds = new Set<number>();
    for (const [tagId, total] of rollupByTag.entries()) {
      if (total === 0) continue;
      const t = tagsById.get(tagId);
      if (!t) continue;
      nodes.push({
        id: `tag:${t.uuid}`,
        label: t.name,
        level: t.level,
        color: t.color
      });
      emittedTagIds.add(tagId);
    }

    // Untagged synthetic node, attached as a direct child of root in the link set.
    const UNTAGGED_NODE_ID = 'untagged';
    if (includeUntagged && untaggedTotal > 0) {
      nodes.push({
        id: UNTAGGED_NODE_ID,
        label: 'Untagged',
        level: 1,
        color: '#9ca3af'
      });
    }

    // Links: for every parent↔child edge in the namespace tree where
    // the child's rollup is non-zero, emit a link with value = child rollup.
    // Income subtrees flow child→parent (so leaves land on the LEFT of the root);
    // outflow subtrees flow parent→child (so leaves extend to the RIGHT of the root).
    const links: Array<{ source: string; target: string; value: number }> = [];
    for (const tag of namespaceTagsResult.rows) {
      if (!emittedTagIds.has(tag.id)) continue;
      if (tag.parent_id === null) continue; // root has no parent
      const parent = tagsById.get(tag.parent_id);
      if (!parent || !emittedTagIds.has(parent.id)) continue;
      const value = rollupByTag.get(tag.id) ?? 0;
      if (value === 0) continue;

      const l1 = findLevel1Ancestor(tag.id);
      const isInIncomeSubtree = l1 !== null && incomeSubtreeRoots.has(l1);

      if (isInIncomeSubtree) {
        // Reverse: income flows toward the root.
        links.push({
          source: `tag:${tag.uuid}`,
          target: `tag:${parent.uuid}`,
          value: centsToNumber(value)
        });
      } else {
        links.push({
          source: `tag:${parent.uuid}`,
          target: `tag:${tag.uuid}`,
          value: centsToNumber(value)
        });
      }
    }

    if (includeUntagged && untaggedTotal > 0) {
      links.push({
        source: `tag:${root.uuid}`,
        target: UNTAGGED_NODE_ID,
        value: centsToNumber(untaggedTotal)
      });
    }

    // Top-level totals: each direct child of the root.
    const byRootChild: Array<{ tag_uuid: string; label: string; total: number }> = [];
    for (const tag of namespaceTagsResult.rows) {
      if (tag.parent_id !== root.id) continue;
      const total = rollupByTag.get(tag.id) ?? 0;
      if (total === 0) continue;
      byRootChild.push({ tag_uuid: tag.uuid, label: tag.name, total: centsToNumber(total) });
    }

    // Drilldown payload keyed by tag uuid, plus 'untagged'.
    const drilldownOut: Record<string, DrilldownItem[]> = {};
    for (const [key, items] of drilldown.entries()) {
      if (key === 'untagged') {
        drilldownOut['untagged'] = items;
      } else {
        const t = tagsById.get(key as number);
        if (t) drilldownOut[t.uuid] = items;
      }
    }

    const maxDepth = nodes.length === 0
      ? 0
      : Math.max(...nodes.filter(n => n.id !== UNTAGGED_NODE_ID).map(n => n.level), 0);

    // Counts, not amounts, in the log (CLAUDE.md).
    logger.info({ rootTagUuid: input.rootTagUuid, flowMeasure, nodeCount: nodes.length, linkCount: links.length }, 'Sankey report computed');

    return {
      namespace: {
        uuid: root.uuid,
        name: root.name,
        flow_measure: flowMeasure,
        max_depth: maxDepth
      },
      period: {
        start_date: txStartDate,
        end_date: txEndDate,
        budget_period_uuid: input.budgetPeriodUuid ?? null
      },
      direction: input.direction,
      nodes,
      links,
      totals: {
        by_root_child: byRootChild,
        untagged_total: centsToNumber(untaggedTotal),
        balance_check: {
          income_total: centsToNumber(incomeTotal),
          outflow_total: centsToNumber(outflowTotal),
          unallocated_residual: centsToNumber(incomeTotal - outflowTotal)
        }
      },
      _drilldown: drilldownOut
    };
  }
}
