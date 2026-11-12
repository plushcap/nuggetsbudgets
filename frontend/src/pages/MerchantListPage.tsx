import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Flex } from '@radix-ui/themes';
import { Plus, Store } from 'lucide-react';
import type { Merchant } from '../services/api';
import { usePaginatedMerchantsQuery } from '../hooks/queries';
import { useMerchantListPaging } from '../hooks/useMerchantListPaging';
import { useMerchantListActions } from '../hooks/useMerchantListActions';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import SharedPagination from '../components/SharedPagination';
import PageContainer from '../components/PageContainer';
import MerchantAdminMenu from '../components/merchants/MerchantAdminMenu';
import MerchantSearchCard from '../components/merchants/MerchantSearchCard';
import MerchantCard from '../components/merchants/MerchantCard';
import MerchantTable from '../components/merchants/MerchantTable';
import MerchantListEmpty from '../components/merchants/MerchantListEmpty';
import DeleteMerchantDialog from '../components/merchants/DeleteMerchantDialog';
import MergeMerchantDialog from '../components/merchants/MergeMerchantDialog';
import { merchantPaths } from '../components/merchants/merchantFields';
import { EMPTY_LIST } from '../utils/emptyList';

const PAGE_SIZE = 50;

/** The ledger's merchants, a page at a time: cards on a phone, a table on a desktop. */
const MerchantListPage: React.FC = () => {
  const navigate = useNavigate();
  const paging = useMerchantListPaging();
  const actions = useMerchantListActions();
  const merchantsQuery = usePaginatedMerchantsQuery({
    page: paging.currentPage,
    limit: PAGE_SIZE,
    search: paging.debouncedSearchTerm,
  });
  const merchants: Merchant[] = merchantsQuery.data?.merchants ?? EMPTY_LIST;
  const totalMerchants = merchantsQuery.data?.pagination.total ?? 0;
  const totalPages = merchantsQuery.data?.pagination.totalPages ?? 0;

  // Stable, so the memoized cards re-render only when their own merchant changes.
  const openEdit = useCallback((m: Merchant) => navigate(merchantPaths.edit(m)), [navigate]);
  const openRules = useCallback((m: Merchant) => navigate(merchantPaths.rules(m)), [navigate]);
  const openView = useCallback((m: Merchant) => navigate(merchantPaths.view(m)), [navigate]);
  const addMerchant = () => navigate(merchantPaths.add);

  if (merchantsQuery.isLoading) {
    return (
      <PageContainer>
        <Flex direction="column" gap="4">
          <Box height="32px" width="25%" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]" />
          <Flex direction="column" gap="4">
            {[1, 2, 3].map((i) => (
              <Box key={i} height="80px" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]" />
            ))}
          </Flex>
        </Flex>
      </PageContainer>
    );
  }

  const { selectedMerchant } = actions;
  const others = selectedMerchant ? merchants.filter((m) => m.uuid !== selectedMerchant.uuid) : [];

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Merchant Management"
        subtitle="Manage merchants and their matching rules"
        icon={<Store size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
        primaryAction={{
          label: 'Add Merchant',
          onClick: addMerchant,
          icon: <Plus size={20} />,
        }}
      />

      <Flex justify="end" mb="4">
        <MerchantAdminMenu onRemoveUnused={actions.removeUnused} onExport={actions.exportAll} exporting={actions.exporting} />
      </Flex>

      <MerchantSearchCard searchTerm={paging.searchTerm} onSearchChange={paging.setSearchTerm} total={totalMerchants} />

      {/* Phones: cards */}
      <Box display={{ initial: 'block', md: 'none' }}>
        <Flex direction="column" gap="4">
          {merchants.map((merchant) => (
            <MerchantCard
              key={merchant.id}
              merchant={merchant}
              viewPath={merchantPaths.view(merchant)}
              onEdit={openEdit}
              onManageRules={openRules}
              onDelete={actions.openDelete}
              onMerge={actions.openMerge}
            />
          ))}
        </Flex>
      </Box>

      {/* Desktops: a table */}
      <Box display={{ initial: 'none', md: 'block' }}>
        <MerchantTable
          merchants={merchants}
          viewPath={merchantPaths.view}
          onOpen={openView}
          onEdit={openEdit}
          onManageRules={openRules}
          onDelete={actions.openDelete}
          onMerge={actions.openMerge}
        />
      </Box>

      {merchants.length === 0 && <MerchantListEmpty searching={Boolean(paging.searchTerm)} onAdd={addMerchant} />}

      {actions.dialog === 'delete' && selectedMerchant && (
        <DeleteMerchantDialog
          merchant={selectedMerchant}
          merchants={others}
          replacementMerchant={actions.replacementMerchant}
          onReplacementChange={actions.setReplacementMerchant}
          onConfirm={actions.deleteSelected}
          onCancel={actions.closeDialog}
        />
      )}

      {actions.dialog === 'merge' && selectedMerchant && (
        <MergeMerchantDialog
          sourceMerchant={selectedMerchant}
          merchants={others}
          targetMerchant={actions.targetMerchant}
          onTargetChange={actions.setTargetMerchant}
          onConfirm={actions.mergeSelected}
          onCancel={actions.closeDialog}
        />
      )}

      {merchants.length > 0 && (
        <Box pb="6" mt="8">
          <SharedPagination
            currentPage={paging.currentPage}
            totalPages={totalPages}
            totalItems={totalMerchants}
            itemsPerPage={PAGE_SIZE}
            onPageChange={paging.setCurrentPage}
            itemLabel="merchants"
          />
        </Box>
      )}

      <ConfirmationDialog {...actions.confirmationProps} />
    </PageContainer>
  );
};

export default MerchantListPage;
