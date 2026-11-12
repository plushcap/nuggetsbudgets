import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { priceConfig } from '../components/investments/investmentEventConfigs';

/** Manual end-of-day price entry: one InvestmentEventForm with the price's field config. Bulk price refresh is an agent/MCP job per the MCP-first design. */
const AddPricePage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={priceConfig} />
  </PageContainer>
);

export default AddPricePage;
