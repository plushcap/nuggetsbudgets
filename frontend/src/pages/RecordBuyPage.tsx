import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { buyEventConfig } from '../components/investments/investmentEventConfigs';

/** Manual buy entry: one InvestmentEventForm with the buy's field config. Bulk/CSV imports are handled by AI agents via MCP, not here. */
const RecordBuyPage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={buyEventConfig} />
  </PageContainer>
);

export default RecordBuyPage;
