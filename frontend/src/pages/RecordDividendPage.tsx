import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { dividendEventConfig } from '../components/investments/investmentEventConfigs';

/** Record a dividend, paid or reinvested: one InvestmentEventForm with the dividend's field config. */
const RecordDividendPage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={dividendEventConfig} />
  </PageContainer>
);

export default RecordDividendPage;
