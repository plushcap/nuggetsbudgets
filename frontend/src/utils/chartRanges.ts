// Shared bar-graph time-range options + bucketing helpers used by the tag and
// budget item detail pages. The shortest range uses daily bars (fast to load
// and useful for recent day-by-day detail); mid ranges use weekly bars and the
// longest ranges use monthly bars. Only the selected window is fetched so the
// pages load fast instead of pulling years of history up front.

export type ChartBucket = 'day' | 'week' | 'month';

export interface ChartRangeOption {
  key: string;
  label: string;
  days?: number;
  months?: number;
  bucket: ChartBucket;
}

export const CHART_RANGE_OPTIONS: [ChartRangeOption, ...ChartRangeOption[]] = [
  { key: '1m', label: '1 month', days: 30, bucket: 'day' },
  { key: '3m', label: '3 months', months: 3, bucket: 'week' },
  { key: '6m', label: '6 months', months: 6, bucket: 'week' },
  { key: '12m', label: '12 months', months: 12, bucket: 'month' },
  { key: '24m', label: '24 months', months: 24, bucket: 'month' },
  { key: '36m', label: '36 months', months: 36, bucket: 'month' },
];

// Resolve a range option by key, falling back to the first (default) option.
export const getChartRangeOption = (key: string): ChartRangeOption =>
  CHART_RANGE_OPTIONS.find(o => o.key === key) || CHART_RANGE_OPTIONS[0];

// Compute the inclusive start date for a given range option.
export const getRangeStartDate = (option: ChartRangeOption): Date => {
  const start = new Date();
  if (option.days) {
    start.setDate(start.getDate() - option.days);
  } else if (option.months) {
    start.setMonth(start.getMonth() - option.months);
  }
  start.setHours(0, 0, 0, 0);
  return start;
};

// Start of the week (Sunday) for a given date, at midnight.
export const getStartOfWeek = (date: Date): Date => {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay());
  return d;
};

// The display label + chronological sort key for the bucket a date falls into.
export const getBucketKey = (date: Date, bucket: ChartBucket): { label: string; sortKey: Date } => {
  if (bucket === 'day') {
    return {
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sortKey: new Date(date.getFullYear(), date.getMonth(), date.getDate()),
    };
  }
  if (bucket === 'week') {
    const weekStart = getStartOfWeek(date);
    return {
      label: weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sortKey: weekStart,
    };
  }
  return {
    label: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
    sortKey: new Date(date.getFullYear(), date.getMonth(), 1),
  };
};

// X-axis legend label for a bucket granularity.
export const getBucketAxisLegend = (bucket: ChartBucket): string =>
  bucket === 'day' ? 'Day' : bucket === 'week' ? 'Week' : 'Month';
