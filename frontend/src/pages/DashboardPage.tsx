import React from 'react';
import DashboardSummary from '../components/DashboardSummary';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';

const DashboardPage: React.FC = () => {
  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your financial status at a glance"
      />

      {/* Dashboard Summary Cards */}
      <DashboardSummary />
    </PageContainer>
  );
};

export default DashboardPage;
