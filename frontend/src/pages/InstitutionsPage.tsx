import React, { useState } from 'react';
import { logger } from '../utils/logger';
import { errorMessage, errorResponseMessage } from '../utils/errors';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Edit, Search, Building2, Trash2 } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useInstitutionsQuery, useDeleteInstitutionMutation } from '../hooks/queries/referenceData';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Card, Flex, Box, Text, Button, TextField, IconButton, Table, Badge } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

const InstitutionsPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchTerm, setSearchTerm] = useState('');

  // Page renders its own error panel below, so suppress the global error toast.
  const {
    data: institutions = [],
    isLoading: loading,
    error,
    refetch,
  } = useInstitutionsQuery({ meta: { suppressErrorToast: true } });
  const deleteInstitutionMutation = useDeleteInstitutionMutation();

  // Confirmation dialog
  const { confirmAsync, dialogProps } = useConfirmation();

  const filteredInstitutions = institutions.filter(institution =>
    institution.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleDelete = async (uuid: string, name: string) => {
    const confirmed = await confirmAsync({
      title: 'Delete Institution',
      message: `Are you sure you want to delete "${name}"?\n\nThis action cannot be undone.`,
      variant: 'danger',
      confirmText: 'Delete Institution',
      cancelText: 'Cancel',
      icon: <Trash2 size={24} />,
      details: [
        'This will only work if no accounts are using this institution',
        'You must reassign or delete associated accounts first'
      ]
    });

    if (!confirmed) return;

    try {
      await deleteInstitutionMutation.mutateAsync(uuid);
      toast.success('Institution deleted successfully');
    } catch (error) {
      logger.error({ err: error, institutionUuid: uuid }, 'Failed to delete institution');

      // Show the server's reason in a confirmation dialog
      await confirmAsync({
        title: 'Unable to Delete Institution',
        message: errorResponseMessage(error) ?? errorMessage(error, 'Failed to delete institution'),
        confirmText: 'OK',
        cancelText: '',
        variant: 'warning',
        icon: <Trash2 size={24} />,
        details: [
          'Check if this institution is being used by any accounts',
          'Reassign accounts to other institutions or delete them first'
        ]
      });
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <Flex direction="column" gap="6" className="animate-pulse">
          {/* Header Skeleton */}
          <Flex align="center" gap="3">
            <Box width="40px" height="40px" className="rounded-[var(--radius-5)] bg-[var(--gray-3)]" />
            <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
              <Box height="24px" width="192px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              <Box height="16px" width="256px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
            </Flex>
          </Flex>
          {/* Content Skeleton */}
          <Card>
            <Flex direction="column" gap="4">
              <Box height="40px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              <Box height="80px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              <Box height="80px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
            </Flex>
          </Card>
        </Flex>
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Text color="red" size="2">{error.message}</Text>
            <Button onClick={() => refetch()}>
              Try Again
            </Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Institutions"
        subtitle="Manage financial institutions for account assignments"
        icon={<Building2 size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings"
        primaryAction={{
          label: 'Add Institution',
          onClick: () => navigate('/settings/institutions/add'),
          icon: <Plus size={20} />
        }}
      />

      {/* Search and Stats Card */}
      <Card mb="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
          <Box flexGrow="1" maxWidth="28rem">
            <TextField.Root
              aria-label="Search institutions"
              placeholder="Search institutions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              size="3"
              variant="surface"
            >
              <TextField.Slot>
                <Search size={16} />
              </TextField.Slot>
            </TextField.Root>
          </Box>
          <Flex align="center" gap="4">
            <Text size="2" color="gray">
              Total: <Text weight="medium" className="text-[var(--gray-12)]">{filteredInstitutions.length}</Text>
            </Text>
          </Flex>
        </Flex>
      </Card>

      {/* Institutions List */}
      {filteredInstitutions.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Building2 size={48} className="sm:w-16 sm:h-16 text-[var(--gray-6)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="4" weight="medium" className="text-[var(--gray-12)]">
                {searchTerm ? 'No institutions found' : 'No institutions yet'}
              </Text>
              <Text size="2" color="gray" align="center">
                {searchTerm
                  ? 'Try adjusting your search criteria or clear the search to see all institutions.'
                  : 'Get started by creating your first financial institution.'
                }
              </Text>
            </Flex>
            {!searchTerm && (
              <Button size="3" asChild>
                <Link to="/settings/institutions/add">
                  <Plus size={16} />
                  Add Your First Institution
                </Link>
              </Button>
            )}
          </Flex>
        </Card>
      ) : (
        <Card>
          {/* Desktop: Table view */}
          <Box display={{ initial: 'none', md: 'block' }}>
            <Table.Root>
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Institution Name</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Accounts</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Notes</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Created</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredInstitutions.map((institution) => (
                  <Table.Row key={institution.uuid}>
                    <Table.Cell>
                      <Flex align="center" gap="3">
                        <Flex align="center" justify="center" flexShrink="0" width="40px" height="40px" className="rounded-[var(--radius-4)] bg-[var(--accent-3)]">
                          <Building2 size={20} className="text-[var(--accent-11)]" />
                        </Flex>
                        <Text weight="medium" className="text-[var(--gray-12)]">{institution.name}</Text>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge variant="soft">
                        {institution.account_count || 0} {(institution.account_count || 0) !== 1 ? 'accounts' : 'account'}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray" title={institution.notes || 'No notes'}>
                        {institution.notes || 'No notes'}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="2" color="gray">
                        {new Date(institution.created_at).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric'
                        })}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex gap="1" justify="center">
                        <IconButton
                          size="2"
                          variant="ghost"
                          asChild
                        >
                          <Link to={`/settings/institutions/edit/${institution.uuid}`} aria-label="Edit institution">
                            <Edit size={16} />
                          </Link>
                        </IconButton>
                        <IconButton
                          size="2"
                          variant="ghost"
                          color="red"
                          onClick={() => handleDelete(institution.uuid, institution.name)}
                          aria-label="Delete institution"
                        >
                          <Trash2 size={16} />
                        </IconButton>
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>

          {/* Mobile: Card view */}
          <Box display={{ initial: 'block', md: 'none' }} p="4">
            <Flex direction="column" gap="4">
              {filteredInstitutions.map((institution) => (
                <Card key={institution.uuid} className="[--card-background-color:var(--gray-2)]">
                  <Flex direction="column" gap="3">
                    <Flex align="start" justify="between">
                      <Flex align="center" gap="3" flexGrow="1" flexBasis="0%" minWidth="0">
                        <Flex align="center" justify="center" flexShrink="0" width="40px" height="40px" className="rounded-[var(--radius-4)] bg-[var(--accent-3)]">
                          <Building2 size={20} className="text-[var(--accent-11)]" />
                        </Flex>
                        <Text weight="bold" className="text-[var(--gray-12)]" style={{ wordBreak: 'break-word' }}>
                          {institution.name}
                        </Text>
                      </Flex>
                      <Flex gap="1" ml="2" flexShrink="0">
                        <IconButton size="3" variant="ghost" asChild>
                          <Link to={`/settings/institutions/edit/${institution.uuid}`} aria-label="Edit institution">
                            <Edit size={20} />
                          </Link>
                        </IconButton>
                        <IconButton
                          size="3"
                          variant="ghost"
                          color="red"
                          onClick={() => handleDelete(institution.uuid, institution.name)}
                          aria-label="Delete institution"
                        >
                          <Trash2 size={20} />
                        </IconButton>
                      </Flex>
                    </Flex>
                    <Flex direction="column" gap="2">
                      <Flex justify="between" align="center">
                        <Text size="2" color="gray">Accounts:</Text>
                        <Badge variant="soft">
                          {institution.account_count || 0} account{(institution.account_count || 0) !== 1 ? 's' : ''}
                        </Badge>
                      </Flex>
                      {institution.notes && (
                        <Flex direction="column" gap="1">
                          <Text size="2" weight="medium" color="gray">Notes:</Text>
                          <Text size="2" color="gray" style={{ wordBreak: 'break-word' }}>
                            {institution.notes}
                          </Text>
                        </Flex>
                      )}
                      <Flex justify="between" align="center" pt="1" className="border-t border-[var(--gray-6)]">
                        <Text size="1" color="gray">Created:</Text>
                        <Text size="1" color="gray">
                          {new Date(institution.created_at).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric'
                          })}
                        </Text>
                      </Flex>
                    </Flex>
                  </Flex>
                </Card>
              ))}
            </Flex>
          </Box>
        </Card>
      )}

      {/* Confirmation Dialog */}
      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default InstitutionsPage;
