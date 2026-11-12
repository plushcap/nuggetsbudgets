import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ResponsiveSankey } from '@nivo/sankey';
import { Card, Flex, Text, Button, Box, Badge, Select, Checkbox, Callout } from '@radix-ui/themes';
import { textColorProps } from '../utils/textColor';
import { GitBranch, Info, AlertTriangle, ArrowLeftRight } from 'lucide-react';
import {
  type SankeyFlowMeasure,
  type SankeyDrilldownItem,
  type SankeyLink
} from '../services/api';
import { useReportRootsQuery, useSankeyReportQuery } from '../hooks/queries';
import { TAG_REPORT_FLOW_MEASURES, TAG_REPORT_FLOW_MEASURE_LABELS, formatMoney } from '@nuggets/shared';
import { oneOf } from '../utils/vocabularyOptions';
import ReportHeader from '../components/ReportHeader';
import PageLoader from '../components/PageLoader';
import RadixDatePicker from '../components/RadixDatePicker';
import { todayLocal } from '../utils/dateUtils';
import { useChartTheme } from '../hooks/useChartTheme';
import ChartFigure from '../components/ChartFigure';
import { EMPTY_LIST } from '../utils/emptyList';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';


/** A diagram node: the report's tag node, with the color the diagram paints it. */
interface SankeyChartNode {
  id: string;
  /** The tag's name. Not `label`: nivo computes the node's `label` from the `label` accessor. */
  name: string;
  nodeColor: string;
}

const ruleLabel = (rule: SankeyDrilldownItem['rule_applied']): string => {
  switch (rule) {
    case 'income_transactions': return 'Income transactions';
    case 'rollover_allocation': return 'Rollover allocation';
    case 'expense_transactions': return 'Expense transactions';
    case 'actual_override': return 'Actual (override)';
    case 'allocated_override': return 'Allocated (override)';
    default: return rule;
  }
};

/**
 * Default to "today" and the first of the same month, both local days.
 */
const firstOfMonthISO = () => `${todayLocal().slice(0, 7)}-01`;

const SankeyReportPage: React.FC = () => {
  const { rootTagUuid: rootTagUuidParam } = useParams<{ rootTagUuid?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const chart = useChartTheme();

  const [showDiagramOnMobile, setShowDiagramOnMobile] = useState(false);

  // URL-bound state
  const startDate = searchParams.get('start_date') || firstOfMonthISO();
  const endDate = searchParams.get('end_date') || todayLocal();
  const direction = (searchParams.get('direction') === 'rl' ? 'rl' : 'lr') as 'lr' | 'rl';
  const includeUntagged = searchParams.get('include_untagged') !== 'false';
  const includeTransfers = searchParams.get('include_transfers') === 'true';
  // A measure the server takes, or the namespace's own: a URL's other spelling ('Actual')
  // would be refused (400), so it reads as none.
  const measureOverride: SankeyFlowMeasure | null = oneOf(TAG_REPORT_FLOW_MEASURES, searchParams.get('flow_measure')) ?? null;

  const { data: reportRoots = EMPTY_LIST, isLoading: loadingRoots } = useReportRootsQuery();

  // Inline error UI below handles failures, so suppress the global error toast.
  const sankeyQuery = useSankeyReportQuery(
    rootTagUuidParam,
    {
      start_date: startDate,
      end_date: endDate,
      direction,
      include_untagged: includeUntagged,
      include_transfers: includeTransfers,
      ...(measureOverride ? { flow_measure_override: measureOverride } : {}),
    },
    { meta: { suppressErrorToast: true } },
  );
  const data = sankeyQuery.data ?? null;
  // The drilldown's node; nothing is selected when a fresh report loads.
  const [selectedNodeUuid, setSelectedNodeUuid] = useSeededState<string | null>(() => null, [data]);
  const loading = sankeyQuery.isLoading;
  const error = sankeyQuery.isError
    ? ((sankeyQuery.error as Error)?.message || 'Failed to load report')
    : null;

  // If no namespace selected and at least one exists, redirect to the first one.
  useEffect(() => {
    const firstRoot = reportRoots[0];
    if (!loadingRoots && !rootTagUuidParam && firstRoot) {
      navigate(`/reports/sankey/${firstRoot.uuid}?${searchParams.toString()}`, { replace: true });
    }
  }, [loadingRoots, rootTagUuidParam, reportRoots, navigate, searchParams]);

  const updateParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const handleNamespaceChange = (newUuid: string) => {
    navigate(`/reports/sankey/${newUuid}?${searchParams.toString()}`);
  };

  const sankeyData = useMemo((): { nodes: SankeyChartNode[]; links: SankeyLink[] } | null => {
    if (!data) return null;
    // Each node carries the tag's own color (set on the Tags page) so the
    // Sankey is colored per-tag. The synthetic "untagged" node ships a neutral
    // gray from the backend. Links inherit a gradient from source→target.
    const isValidHex = (c?: string | null) =>
      typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
    return {
      nodes: data.nodes.map(n => ({
        id: n.id,
        name: n.label,
        nodeColor: isValidHex(n.color) ? n.color : chart.axis,
      })),
      links: data.links,
    };
  }, [data, chart.axis]);

  const nodeName = (id: string) => sankeyData?.nodes.find((node) => node.id === id)?.name ?? id;

  const selectedDrilldown: SankeyDrilldownItem[] | null = useMemo(() => {
    if (!data || !selectedNodeUuid) return null;
    const key = selectedNodeUuid === 'untagged' ? 'untagged' : selectedNodeUuid;
    return data._drilldown[key] || null;
  }, [data, selectedNodeUuid]);

  if (loadingRoots) {
    return (
      <PageContainer>
        <PageLoader label="Loading report…" />
      </PageContainer>
    );
  }

  if (reportRoots.length === 0) {
    return (
      <PageContainer>
        <ReportHeader
          icon={GitBranch}
          title="Sankey — Money Flow"
          description="Visualize where money comes from and where it goes, by report namespace"
        />
        <Card>
          <Flex direction="column" gap="3" align="center" p="5" className="text-center">
            <GitBranch size={40} className="text-[var(--purple-11)]" />
            <Text size="5" weight="bold">No report namespaces yet</Text>
            <Text size="2" color="gray">
              To use the Sankey report, mark a top-level tag as a "report namespace" from the Tags page,
              then assign budget items to tags inside that namespace.
            </Text>
            <Button onClick={() => navigate('/tags')} size="3">
              Go to Tags
            </Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <ReportHeader
        icon={GitBranch}
        title="Sankey — Money Flow"
        description="Visualize where money comes from and where it goes, by report namespace"
      />

      {/* Controls */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', md: 'row' }} gap="3" align={{ md: 'end' }} wrap="wrap">
          <Flex direction="column" flexGrow="1" minWidth="220px">
            <Text as="label" htmlFor="sankey-namespace" size="2" weight="medium" mb="1" className="block">Namespace</Text>
            <Select.Root
              value={rootTagUuidParam || ''}
              onValueChange={(value) => handleNamespaceChange(value)}
            >
              <Select.Trigger id="sankey-namespace" />
              <Select.Content>
                {reportRoots.map(r => (
                  <Select.Item key={r.uuid} value={r.uuid}>
                    {r.name} ({r.budget_item_tagging_count} tagged)
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Box>
            <Text as="div" id="sankey-start" size="2" weight="medium" mb="1" >Start date</Text>
            <RadixDatePicker
              aria-labelledby="sankey-start"
              value={startDate}
              onChange={(d) => updateParam('start_date', d)}
            />
          </Box>

          <Box>
            <Text as="div" id="sankey-end" size="2" weight="medium" mb="1" >End date</Text>
            <RadixDatePicker
              aria-labelledby="sankey-end"
              value={endDate}
              onChange={(d) => updateParam('end_date', d)}
            />
          </Box>

          <Box>
            <Text as="label" htmlFor="sankey-measure" size="2" weight="medium" mb="1" className="block">Flow measure</Text>
            <Select.Root
              value={measureOverride ?? 'default'}
              onValueChange={(value) => updateParam('flow_measure', value === 'default' ? null : value)}
            >
              <Select.Trigger id="sankey-measure" />
              <Select.Content>
                <Select.Item value="default">(namespace default)</Select.Item>
                {TAG_REPORT_FLOW_MEASURES.map((m) => (
                  <Select.Item key={m} value={m}>{TAG_REPORT_FLOW_MEASURE_LABELS[m]}</Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Box>

          <Button
            variant="soft"
            onClick={() => updateParam('direction', direction === 'lr' ? 'rl' : 'lr')}
            title="Toggle direction"
          >
            <ArrowLeftRight size={16} />
            {direction === 'lr' ? 'L → R' : 'R → L'}
          </Button>

          <Text as="label" size="2">
            <Flex align="center" gap="2">
              <Checkbox
                checked={includeUntagged}
                onCheckedChange={(checked) => updateParam('include_untagged', checked ? null : 'false')}
              />
              Include untagged
            </Flex>
          </Text>

          <Text as="label" size="2">
            <Flex align="center" gap="2">
              <Checkbox
                checked={includeTransfers}
                onCheckedChange={(checked) => updateParam('include_transfers', checked ? 'true' : null)}
              />
              Include transfers
            </Flex>
          </Text>
        </Flex>
      </Card>

      {loading && (
        <PageLoader label="Loading report…" />
      )}

      {error && (
        <Callout.Root color="red" mb="4">
          <Callout.Icon>
            <AlertTriangle size={20} />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {!loading && data && (
        <>
          {/* Chart + drilldown */}
          <Flex direction={{ initial: 'column', lg: 'row' }} gap="4">
            <Box flexGrow="1" minWidth="0">
              <Card>
                <Flex align="center" justify="between" mb="3">
                  <Flex align="center" gap="2">
                    <Text size="4" weight="bold">{data.namespace.name}</Text>
                    <Badge color="purple">{data.namespace.flow_measure}</Badge>
                  </Flex>
                  <Text size="1" color="gray">
                    {data.period.start_date} → {data.period.end_date}
                  </Text>
                </Flex>

                {/* Mobile: collapse-to-list */}
                <Box className="block sm:hidden">
                  {!showDiagramOnMobile ? (
                    <>
                      <Button size="2" onClick={() => setShowDiagramOnMobile(true)} mb="3">
                        Show diagram
                      </Button>
                      <Flex direction="column" gap="2">
                        {data.totals.by_root_child.map(row => (
                          <Flex key={row.tag_uuid} align="center" justify="between" py="2" className="border-b border-[var(--gray-4)]">
                            <Text size="2" weight="medium">{row.label}</Text>
                            <Text size="2">{formatMoney(row.total)}</Text>
                          </Flex>
                        ))}
                        {data.totals.untagged_total > 0 && (
                          <Flex align="center" justify="between" py="2">
                            <Text size="2" color="gray">Untagged</Text>
                            <Text size="2">{formatMoney(data.totals.untagged_total)}</Text>
                          </Flex>
                        )}
                      </Flex>
                    </>
                  ) : (
                    <Button size="2" variant="soft" onClick={() => setShowDiagramOnMobile(false)} mb="3">
                      Hide diagram
                    </Button>
                  )}
                </Box>

                {/* Diagram: desktop always, mobile if toggled */}
                <div className={showDiagramOnMobile ? 'block' : 'hidden sm:block'}>
                  <div>
                    {sankeyData && sankeyData.nodes.length > 0 ? (
                      <ChartFigure
                        title="Where the money went"
                        summary={`${sankeyData.links.length} ${sankeyData.links.length === 1 ? 'flow' : 'flows'} between ${sankeyData.nodes.length} tags; income ${formatMoney(data.totals.balance_check.income_total)}, outflow ${formatMoney(data.totals.balance_check.outflow_total)}.`}
                        columns={['From', 'To', 'Amount']}
                        rows={sankeyData.links.map((link) => [nodeName(link.source), nodeName(link.target), formatMoney(link.value)])}
                      >
                      <Box height="720px">
                      <ResponsiveSankey<SankeyChartNode, SankeyLink>
                        data={sankeyData}
                        margin={{ top: 20, right: 200, bottom: 20, left: 140 }}
                        align="justify"
                        layout="horizontal"
                        // 'auto' minimizes link crossings algorithmically.
                        sort="auto"
                        colors={(node) => node.nodeColor || chart.axis}
                        nodeOpacity={1}
                        nodeThickness={18}
                        nodeBorderWidth={0}
                        linkOpacity={0.45}
                        linkContract={3}
                        enableLinkGradient
                        labelPosition="outside"
                        labelOrientation="horizontal"
                        labelPadding={8}
                        label={(node) => node.name || node.id}
                        theme={chart.nivo}
                        onClick={(d) => {
                          // d can be a node or a link; only a node has an id
                          const id = 'id' in d ? d.id : undefined;
                          if (!id) return;
                          if (id === 'untagged') setSelectedNodeUuid('untagged');
                          else if (id.startsWith('tag:')) setSelectedNodeUuid(id.slice('tag:'.length));
                        }}
                      />
                      </Box>
                      </ChartFigure>
                    ) : (
                      <Flex align="center" justify="center" height="720px">
                        <Text size="2" color="gray">
                          Nothing to chart for this period. Tag some budget items and try again.
                        </Text>
                      </Flex>
                    )}
                  </div>
                </div>

                {/* Balance check */}
                <Flex gap="4" wrap="wrap" mt="3" pt="3" className="border-t border-[var(--gray-4)]">
                  <Flex gap="1" align="center">
                    <Info size={12} className="text-[var(--gray-11)]" />
                    <Text size="1" color="gray">
                      Income {formatMoney(data.totals.balance_check.income_total)}
                    </Text>
                  </Flex>
                  <Text size="1" color="gray">
                    Outflow {formatMoney(data.totals.balance_check.outflow_total)}
                  </Text>
                  <Text size="1" {...textColorProps(Math.abs(data.totals.balance_check.unallocated_residual) < 0.01 ? 'green' : 'amber')}>
                    Residual {formatMoney(data.totals.balance_check.unallocated_residual)}
                  </Text>
                  {data.totals.untagged_total > 0 && (
                    <Text size="1" color="gray">
                      Untagged {formatMoney(data.totals.untagged_total)}
                    </Text>
                  )}
                </Flex>
              </Card>
            </Box>

            {/* Drilldown panel */}
            <Box flexShrink="0" width={{ initial: '100%', lg: '288px' }}>
              <Card>
                <Text size="3" weight="bold" mb="2" as="div">
                  {selectedNodeUuid ? 'Tag detail' : 'Top-level totals'}
                </Text>
                {selectedNodeUuid && selectedDrilldown ? (
                  <Flex direction="column" gap="2">
                    {selectedDrilldown.length === 0 ? (
                      <Text size="2" color="gray">No contributing items.</Text>
                    ) : selectedDrilldown.map(item => (
                      <Box key={item.budget_item_uuid} pb="2" className="border-b border-[var(--gray-4)]">
                        <Text size="2" weight="medium">{item.budget_item_name}</Text>
                        <Flex align="center" justify="between">
                          <Text size="1" color="gray">{ruleLabel(item.rule_applied)}</Text>
                          <Text size="2">{formatMoney(item.contribution)}</Text>
                        </Flex>
                      </Box>
                    ))}
                    <Button size="1" variant="soft" onClick={() => setSelectedNodeUuid(null)} mt="2">
                      Back to top-level totals
                    </Button>
                  </Flex>
                ) : (
                  <Flex direction="column" gap="2">
                    {data.totals.by_root_child.map(row => (
                      <Flex key={row.tag_uuid} align="center" justify="between" py="1">
                        <Text size="2">{row.label}</Text>
                        <Text size="2" weight="medium">{formatMoney(row.total)}</Text>
                      </Flex>
                    ))}
                    {data.totals.untagged_total > 0 && (
                      <Flex align="center" justify="between" py="1">
                        <Text size="2" color="gray">Untagged</Text>
                        <Text size="2">{formatMoney(data.totals.untagged_total)}</Text>
                      </Flex>
                    )}
                    <Text size="1" color="gray" mt="2" as="div">
                      Click a node on the diagram to drill into its contributing budget items.
                    </Text>
                  </Flex>
                )}
              </Card>
            </Box>
          </Flex>
        </>
      )}
    </PageContainer>
  );
};

export default SankeyReportPage;
