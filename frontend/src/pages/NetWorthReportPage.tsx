import React, { useState } from 'react';
import { TrendingUp } from 'lucide-react';
import NetWorthChart from '../components/NetWorthChart';
import ReportHeader from '../components/ReportHeader';
import { Card, Box, SegmentedControl } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

interface TimePeriod {
  label: string;
  period: 'day' | 'week' | 'month' | 'year';
  limit: number;
}

// The period the report opens on.
const PAST_THREE_MONTHS: TimePeriod = { label: 'Past 3 Months', period: 'week', limit: 13 };

const TIME_PERIODS: TimePeriod[] = [
  { label: 'Past Month', period: 'day', limit: 30 },
  PAST_THREE_MONTHS,
  { label: 'Past Year', period: 'month', limit: 12 },
  { label: 'All Time', period: 'month', limit: 1000 }
];

const NetWorthReportPage: React.FC = () => {
  const [selectedPeriod, setSelectedPeriod] = useState<TimePeriod>(PAST_THREE_MONTHS);

  return (
    <PageContainer>
      <ReportHeader
        icon={TrendingUp}
        title="Net Worth Report"
        description="Track your financial progress over time"
      />

      <Card>
        <Box p={{ initial: '2', sm: '4' }}>
          {/* Time Period Selector */}
          <Box mb="6">
            <SegmentedControl.Root
              aria-label="Time period"
              value={selectedPeriod.label}
              onValueChange={(value) => {
                const next = TIME_PERIODS.find((p) => p.label === value);
                if (next) setSelectedPeriod(next);
              }}
            >
              {TIME_PERIODS.map((period) => (
                <SegmentedControl.Item key={period.label} value={period.label}>
                  {period.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
          </Box>

          {/* Chart Container - Responsive height */}
          <Box width="100%" minHeight="300px">
            <NetWorthChart
              height={400}
              period={selectedPeriod.period}
              limit={selectedPeriod.limit}
            />
          </Box>
        </Box>
      </Card>
    </PageContainer>
  );
};

export default NetWorthReportPage;
