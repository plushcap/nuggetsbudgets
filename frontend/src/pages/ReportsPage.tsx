import React, { lazy, Suspense } from 'react';
import { Link, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import {
  TrendingUp,
  BarChart3,
  Activity,
  GitBranch
} from 'lucide-react';
import { Flex, Box, Grid, Text, Card } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import NotFoundPage from './NotFoundPage';
import PageContainer from '../components/PageContainer';

// Lazy load report pages
const NetWorthReportPage = lazy(() => import('./NetWorthReportPage'));
const SankeyReportPage = lazy(() => import('./SankeyReportPage'));

// Radix accent palette per report. Color follows the theme picker via CSS vars;
// the active/hover tile uses the report's hue, idle uses gray.
type ReportColor = 'blue' | 'green' | 'purple';

interface ReportNavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
  description: string;
  colorClass: ReportColor;
}

const ReportsPage: React.FC = () => {
  const location = useLocation();

  const reportsNavigation: ReportNavItem[] = [
    {
      name: 'Net Worth',
      href: '/reports/networth',
      icon: TrendingUp,
      description: 'Track your financial progress over time with detailed net worth analysis',
      colorClass: 'blue'
    },
    {
      name: 'Investment Performance',
      href: '/investments/performance',
      icon: Activity,
      description: 'Compare and analyze the performance of your investment accounts',
      colorClass: 'green'
    },
    {
      name: 'Sankey (Money Flow)',
      href: '/reports/sankey',
      icon: GitBranch,
      description: 'Visualize where money comes from and where it goes, by report namespace',
      colorClass: 'purple'
    },
  ];

  const isActive = (href: string) => location.pathname === href || location.pathname.startsWith(href);

  // If we're on a specific report page, render that page
  if (location.pathname !== '/reports') {
    return (
      <Suspense fallback={<PageLoader label="Loading report…" />}>
        <Routes>
          <Route path="networth" element={<NetWorthReportPage />} />
          {/* The old report showed made-up returns; the real one lives under Investments. */}
          <Route path="investment-performance" element={<Navigate to="/investments/performance" replace />} />
          <Route path="sankey" element={<SankeyReportPage />} />
          <Route path="sankey/:rootTagUuid" element={<SankeyReportPage />} />
          {/* Add more report routes here as they're created */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    );
  }

  // Map each report color to its Radix accent CSS-var classes. Static keys avoid
  // dynamically-constructed class names (which Tailwind can't see / the theme can't drive).
  const tileColorMap: Record<ReportColor, string> = {
    blue: 'bg-[var(--blue-4)] text-[var(--accent-11)]',
    green: 'bg-[var(--green-4)] text-[var(--green-12)]',
    purple: 'bg-[var(--purple-4)] text-[var(--purple-11)]',
  };

  const titleColorMap: Record<ReportColor, string> = {
    blue: 'text-[var(--accent-11)]',
    green: 'text-[var(--green-12)]',
    purple: 'text-[var(--purple-11)]',
  };

  return (
    <PageContainer>
      <PageHeader
        title="Reports"
        subtitle="Analyze your financial data with comprehensive reports and visualizations."
        icon={<BarChart3 size={20} />}
      />

      {/* Reports Grid */}
      <Grid columns={{ initial: '1', sm: '2', lg: '3', xl: '4' }} gap="6">
        {reportsNavigation.map((item) => {
          const IconComponent = item.icon;
          const active = isActive(item.href);
          const tileClass = active
            ? tileColorMap[item.colorClass]
            : 'bg-[var(--gray-3)] text-[var(--gray-11)]';

          const cardContent = (
            <Card
              className={`transition-all duration-200 cursor-pointer relative ${
                active ? 'shadow-lg' : 'hover:shadow-lg'
              }`}
            >
              <Flex align="start" gap="4">
                <Flex
                  align="center"
                  justify="center"
                  width="48px"
                  height="48px"
                  flexShrink="0"
                  className={`${tileClass} transition-colors duration-200 rounded-[var(--radius-3)]`}
                >
                  <IconComponent size={24} />
                </Flex>
                <Box flexGrow="1" minWidth="0">
                  <Text
                    as="div"
                    size="4"
                    weight="bold"
                    mb="1"
                    className={active ? titleColorMap[item.colorClass] : 'text-[var(--gray-12)]'}
                  >
                    {item.name}
                  </Text>
                  <Text as="p" size="2" color="gray">
                    {item.description}
                  </Text>
                </Box>
              </Flex>
            </Card>
          );

          return (
            <Link key={item.name} to={item.href}>
              {cardContent}
            </Link>
          );
        })}
      </Grid>
    </PageContainer>
  );
};

export default ReportsPage;
