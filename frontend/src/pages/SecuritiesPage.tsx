import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Flex, Card, Text, Table, Button, Badge, IconButton, TextField } from '@radix-ui/themes';
import { Layers, Plus, Pencil, DollarSign, Search } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import SharedPagination from '../components/SharedPagination';
import { useSecuritiesPaginatedQuery } from '../hooks/queries/investments';
import PageContainer from '../components/PageContainer';
import { formatMoney } from '@nuggets/shared';

const PAGE_SIZE = 100;

const SecuritiesPage: React.FC = () => {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Filter as you type, but only once there are at least 2 characters.
  const effectiveSearch = search.trim().length >= 2 ? search.trim() : '';
  const { data, isLoading, isFetching } = useSecuritiesPaginatedQuery({
    search: effectiveSearch,
    page,
    limit: PAGE_SIZE,
    include_inactive: true,
  });

  const securities = data?.data ?? [];
  const pagination = data?.pagination;

  const onSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  return (
    <PageContainer>
      <PageHeader
        title="Securities"
        subtitle="Catalog of tracked instruments"
        icon={<Layers />}
        backPath="/investments"
        actions={
          <Flex gap="2" wrap="wrap">
            <Button variant="soft" onClick={() => navigate('/investments/prices/add')}><DollarSign size={16} /> Add price</Button>
            <Button onClick={() => navigate('/investments/securities/add')}><Plus size={16} /> Add security</Button>
          </Flex>
        }
      />

      <Box mb="3" maxWidth="420px">
        <TextField.Root
          aria-label="Search securities"
          placeholder="Search by ticker or name…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        >
          <TextField.Slot><Search size={16} /></TextField.Slot>
        </TextField.Root>
      </Box>

      {isLoading ? (
        <PageLoader label="Loading securities…" />
      ) : (
        <>
          <Card>
            <Table.Root variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Ticker</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right">Latest price</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell align="right"></Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {securities.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={5}>
                      <Text size="2" color="gray">
                        {effectiveSearch ? `No securities match “${effectiveSearch}”.` : 'No securities yet.'}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  securities.map((s) => (
                    <Table.Row key={s.uuid}>
                      <Table.Cell>
                        <Flex align="center" gap="2">
                          <Text weight="medium">{s.ticker}</Text>
                          {s.is_pass_through && <Badge color="iris" variant="soft">fund</Badge>}
                          {!s.is_active && <Badge color="gray" variant="soft">inactive</Badge>}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>{s.name}</Table.Cell>
                      <Table.Cell>{s.security_type}</Table.Cell>
                      <Table.Cell align="right">
                        {formatMoney(s.latest_price)}
                      </Table.Cell>
                      <Table.Cell align="right">
                        <IconButton size="1" variant="ghost" aria-label={`Edit ${s.ticker}`} onClick={() => navigate(`/investments/securities/${s.uuid}/edit`)}>
                          <Pencil size={14} />
                        </IconButton>
                      </Table.Cell>
                    </Table.Row>
                  ))
                )}
              </Table.Body>
            </Table.Root>
          </Card>

          {pagination && pagination.total > 0 && (
            <Box mt="3" style={{ opacity: isFetching ? 0.6 : 1 }}>
              <SharedPagination
                currentPage={pagination.page}
                totalPages={pagination.totalPages}
                totalItems={pagination.total}
                itemsPerPage={pagination.limit}
                onPageChange={setPage}
              />
            </Box>
          )}
        </>
      )}
    </PageContainer>
  );
};

export default SecuritiesPage;
