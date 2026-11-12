import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { sellEventConfig } from '../components/investments/investmentEventConfigs';

/** Record a sale: one InvestmentEventForm with the sale's field config, with the specific-lots list. */
const RecordSellPage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={sellEventConfig} />
  </PageContainer>
);

export default RecordSellPage;
