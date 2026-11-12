import React from 'react';
import PageContainer from '../components/PageContainer';
import InvestmentEventForm from '../components/investments/InvestmentEventForm';
import { corporateActionConfig } from '../components/investments/investmentEventConfigs';

/** Apply a corporate action across a security's open lots: one InvestmentEventForm with the actions' field config. */
const CorporateActionPage: React.FC = () => (
  <PageContainer width="form">
    <InvestmentEventForm config={corporateActionConfig} />
  </PageContainer>
);

export default CorporateActionPage;
