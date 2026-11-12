import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { feeEventConfig } from '../components/investments/investmentEventConfigs';

/** Record a fee: one InvestmentEventForm with the fee's field config. */
const RecordFeePage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={feeEventConfig} />
  </PageContainer>
);

export default RecordFeePage;
