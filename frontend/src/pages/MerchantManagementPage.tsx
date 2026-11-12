import React from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import MerchantListPage from './MerchantListPage';
import AddMerchantPage from './AddMerchantPage';
import EditMerchantPage from './EditMerchantPage';
import MerchantRulesPage from './MerchantRulesPage';
import ViewMerchantPage from './ViewMerchantPage';
import NotFoundPage from './NotFoundPage';

/**
 * Settings → Merchants (`/settings/merchants/*`): the list, and under it a merchant's page,
 * its edit form and its matching rules, and the add form. Each page is its own module; their
 * parts are in components/merchants/ and their logic in hooks/useMerchant*.
 */
const MerchantManagementPage: React.FC = () => {
  const location = useLocation();

  if (location.pathname !== '/settings/merchants') {
    return (
      <Routes>
        <Route path="/add" element={<AddMerchantPage />} />
        <Route path="/:merchantUuid/view" element={<ViewMerchantPage />} />
        <Route path="/:uuid/edit" element={<EditMerchantPage />} />
        <Route path="/:uuid/rules" element={<MerchantRulesPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    );
  }

  return <MerchantListPage />;
};

export default MerchantManagementPage;
