import React, { useState, useRef, useId } from 'react';
import { Search, Filter, X, Calendar, DollarSign, Tag, ChevronDown } from 'lucide-react';
import { BudgetItem, BudgetPeriod } from '../services/api';
import { useSeededState } from '../hooks/useSeededState';
import { Card, TextField, Select, Button, Flex, Text, Badge, Box, Grid } from '@radix-ui/themes';
import CurrencyInput from './CurrencyInput';
import FieldError, { fieldErrorProps } from './forms/FieldError';
import RadixDatePicker from './RadixDatePicker';
import { periodChoices } from '../utils/budgetPeriods';
import { REVIEW_STATUSES, REVIEW_STATUS_LABELS, TRANSACTION_TYPE_LABELS, type TransactionReviewStatus, type TransactionType, formatMoney, budgetItemStatus } from '@nuggets/shared';
import { TRANSACTION_TYPE_OPTIONS } from '../utils/vocabularyOptions';

export interface TransactionFilters {
  search?: string;
  /** The database's values (@nuggets/shared), which the filter sends as they are; 'all' sends none. */
  reviewStatus?: 'all' | TransactionReviewStatus;
  dateFrom?: string;
  dateTo?: string;
  transactionType?: 'all' | TransactionType;
  budgetPeriodId?: number | null;
  budgetItemId?: number | null;
  amountMin?: number | undefined;
  amountMax?: number | undefined;
}

type AmountBound = 'amountMin' | 'amountMax';

/**
 * Why an amount bound that isn't an amount changes nothing, naming what the filter still
 * uses: the box's one message (CurrencyInput leaves its own hint out).
 */
function keptBoundMessage(applied: number | undefined): string {
  return applied === undefined
    ? "Not an amount: enter it like 1,234.56. The filter doesn't use it until it is one."
    : `Not an amount: enter it like 1,234.56. The filter still uses ${formatMoney(applied)}.`;
}

export interface SharedTransactionFilterProps {
  filters: TransactionFilters;
  onFiltersChange: (filters: TransactionFilters) => void;
  budgetPeriods: BudgetPeriod[];
  budgetItems: BudgetItem[];
  loading?: boolean;
  totalCount?: number;
  filteredCount?: number;
  className?: string;
  // Allow customization of which filters to show
  showFilters?: {
    search?: boolean;
    reviewStatus?: boolean;
    dateRange?: boolean;
    transactionType?: boolean;
    budgetPeriod?: boolean;
    budgetItem?: boolean;
    amountRange?: boolean;
  };
}

const SharedTransactionFilter: React.FC<SharedTransactionFilterProps> = ({
  filters,
  onFiltersChange,
  budgetPeriods,
  budgetItems,
  loading = false,
  totalCount = 0,
  filteredCount = 0,
  className = '',
  showFilters = {
    search: true,
    reviewStatus: true,
    dateRange: true,
    transactionType: true,
    budgetPeriod: true,
    budgetItem: true,
    amountRange: true,
  }
}) => {
  const fieldId = useId();
  const [isExpanded, setIsExpanded] = useState(false);
  // The filters as edited here, ahead of the debounced onFiltersChange; new
  // filters from the parent replace them.
  const [localFilters, setLocalFilters] = useSeededState<TransactionFilters>(() => filters, [filters]);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  // An amount bound whose text isn't an amount leaves the filter as it was: read as
  // empty, it dropped the bound and showed every amount. Its box is given NaN meanwhile, so
  // clearing the filters is a change it sees, and empties it.
  const [unreadableBounds, setUnreadableBounds] = useState<Record<AmountBound, boolean>>({ amountMin: false, amountMax: false });
  // A box with an accounting negative being typed (`(12.00` before its `)`): unreadable, and
  // the filter keeps its bound, but its message waits as the box's own hint does.
  const [pendingBounds, setPendingBounds] = useState<Record<AmountBound, boolean>>({ amountMin: false, amountMax: false });
  const handlePendingBound = (key: AmountBound) => (pending: boolean) =>
    setPendingBounds((prev) => (prev[key] === pending ? prev : { ...prev, [key]: pending }));

  // Debounced filter updates
  const updateFilters = (newFilters: TransactionFilters) => {
    setLocalFilters(newFilters);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      onFiltersChange(newFilters);
    }, 300);
  };

  // Handle individual filter changes
  const handleFilterChange = <K extends keyof TransactionFilters>(key: K, value: TransactionFilters[K]) => {
    const newFilters = { ...localFilters, [key]: value };
    updateFilters(newFilters);
  };

  const handleAmountBound = (key: AmountBound) => (parsed: number | null, unreadable: boolean) => {
    setUnreadableBounds((prev) => (prev[key] === unreadable ? prev : { ...prev, [key]: unreadable }));
    if (!unreadable) handleFilterChange(key, parsed ?? undefined);
  };

  // Clear all filters
  const clearAllFilters = () => {
    setUnreadableBounds({ amountMin: false, amountMax: false });
    setPendingBounds({ amountMin: false, amountMax: false });
    const clearedFilters: TransactionFilters = {
      search: '',
      reviewStatus: 'all',
      dateFrom: '',
      dateTo: '',
      transactionType: 'all',
      budgetPeriodId: null,
      budgetItemId: null,
      amountMin: undefined,
      amountMax: undefined
    };
    updateFilters(clearedFilters);
  };

  // Check if any filters are active
  const hasActiveFilters = () => {
    return !!(
      localFilters.search ||
      (localFilters.reviewStatus && localFilters.reviewStatus !== 'all') ||
      localFilters.dateFrom ||
      localFilters.dateTo ||
      (localFilters.transactionType && localFilters.transactionType !== 'all') ||
      localFilters.budgetPeriodId ||
      localFilters.budgetItemId ||
      localFilters.amountMin ||
      localFilters.amountMax
    );
  };

  // Count active filters
  const activeFilterCount = () => {
    let count = 0;
    if (localFilters.search) count++;
    if (localFilters.reviewStatus && localFilters.reviewStatus !== 'all') count++;
    if (localFilters.dateFrom || localFilters.dateTo) count++;
    if (localFilters.transactionType && localFilters.transactionType !== 'all') count++;
    if (localFilters.budgetPeriodId) count++;
    if (localFilters.budgetItemId) count++;
    if (localFilters.amountMin || localFilters.amountMax) count++;
    return count;
  };

  const activeCount = activeFilterCount();

  return (
    <Card className={className}>
      {/* Always visible filter bar */}
      <Flex direction="column" gap="3" p="4">
        {/* Search */}
        {showFilters.search && (
          <TextField.Root
            aria-label="Search transactions"
            placeholder="Search transactions..."
            value={localFilters.search || ''}
            onChange={(e) => handleFilterChange('search', e.target.value)}
            size="3"
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </TextField.Root>
        )}

        {/* Quick Filters Row */}
        <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
          {/* Left: Quick filter dropdowns */}
          <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" flexGrow="1" flexBasis="0%">
            {/* Review Status Quick Filter */}
            {showFilters.reviewStatus && (
              <Select.Root
                value={localFilters.reviewStatus || 'all'}
                onValueChange={(value) => handleFilterChange('reviewStatus', value as TransactionFilters['reviewStatus'])}
                size="3"
              >
                <Select.Trigger aria-label="Review status" style={{ minWidth: '150px' }} />
                <Select.Content>
                  <Select.Item value="all">All Reviews</Select.Item>
                  {REVIEW_STATUSES.map((s) => (
                    <Select.Item key={s} value={s}>{REVIEW_STATUS_LABELS[s]}</Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}

            {/* Transaction Type Quick Filter */}
            {showFilters.transactionType && (
              <Select.Root
                value={localFilters.transactionType || 'all'}
                onValueChange={(value) => handleFilterChange('transactionType', value as TransactionFilters['transactionType'])}
                size="3"
              >
                <Select.Trigger aria-label="Transaction type" style={{ minWidth: '150px' }} />
                <Select.Content>
                  <Select.Item value="all">All Types</Select.Item>
                  {TRANSACTION_TYPE_OPTIONS.map((t) => (
                    <Select.Item key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </Flex>

          {/* Right: Action buttons */}
          <Flex gap="3" justify={{ initial: 'between', sm: 'end' }}>
            {/* Advanced filters toggle */}
            <Button
              variant={hasActiveFilters() ? 'soft' : 'outline'}
              {...(hasActiveFilters() ? {} : { color: 'gray' as const })}
              onClick={() => setIsExpanded(!isExpanded)}
              style={{ flex: '1 1 auto' }}
            >
              <Filter size={16} />
              Filters
              {activeCount > 0 && (
                <Badge size="1" ml="1">
                  {activeCount}
                </Badge>
              )}
              <ChevronDown size={16} className={`transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </Button>

            {/* Clear filters */}
            {hasActiveFilters() && (
              <Button
                variant="outline"
                color="red"
                onClick={clearAllFilters}
                aria-label="Clear all filters"
              >
                <X size={16} />
                <Box as="span" className="hidden sm:inline">Clear</Box>
              </Button>
            )}
          </Flex>
        </Flex>

        {/* Filter stats */}
        {!loading && (
          <Text size="2" color="gray" align={{ initial: 'center', sm: 'left' }}>
            {filteredCount !== totalCount ? (
              <>Showing {filteredCount} of {totalCount} transactions</>
            ) : (
              <>{totalCount} transactions</>
            )}
          </Text>
        )}
      </Flex>

      {/* Expanded filters */}
      {isExpanded && (
        <Box p="4" className="border-t border-[var(--gray-6)]">
          <Grid columns={{ initial: '1', md: '2', lg: '4' }} gap="4">
            {/* Date Range */}
            {showFilters.dateRange && (
              <Flex direction="column" gap="2">
                <Text as="div" id={`${fieldId}-date-range`} size="2" weight="medium">
                  <Calendar size={16} className="inline mr-1" />
                  Date Range
                </Text>
                <Grid columns="2" gap="2" role="group" aria-labelledby={`${fieldId}-date-range`}>
                  <RadixDatePicker
                    aria-label="From"
                    placeholder="From"
                    value={localFilters.dateFrom || ''}
                    onChange={(value) => handleFilterChange('dateFrom', value)}
                    size="2"
                  />
                  <RadixDatePicker
                    aria-label="To"
                    placeholder="To"
                    value={localFilters.dateTo || ''}
                    onChange={(value) => handleFilterChange('dateTo', value)}
                    size="2"
                  />
                </Grid>
              </Flex>
            )}

            {/* Budget Period */}
            {showFilters.budgetPeriod && (
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor={`${fieldId}-budget-period`} size="2" weight="medium">
                  <Calendar size={16} className="inline mr-1" />
                  Budget Period
                </Text>
                <Select.Root
                  value={localFilters.budgetPeriodId?.toString() || 'none'}
                  onValueChange={(value) => handleFilterChange('budgetPeriodId', value === 'none' ? null : parseInt(value))}
                  size="2"
                >
                  <Select.Trigger id={`${fieldId}-budget-period`} />
                  <Select.Content>
                    <Select.Item value="none">All Periods</Select.Item>
                    {periodChoices(budgetPeriods, localFilters.budgetPeriodId).map(period => (
                      <Select.Item key={period.id} value={period.id.toString()}>
                        {period.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Flex>
            )}

            {/* Budget Item */}
            {showFilters.budgetItem && (
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor={`${fieldId}-budget-item`} size="2" weight="medium">
                  <Tag size={16} className="inline mr-1" />
                  Budget Item
                </Text>
                <Select.Root
                  value={localFilters.budgetItemId?.toString() || 'none'}
                  onValueChange={(value) => handleFilterChange('budgetItemId', value === 'none' ? null : parseInt(value))}
                  size="2"
                >
                  <Select.Trigger id={`${fieldId}-budget-item`} />
                  <Select.Content>
                    <Select.Item value="none">All Items</Select.Item>
                    {budgetItems.map(item => (
                      <Select.Item key={item.id} value={item.id.toString()}>
                        {item.name}{item.status === budgetItemStatus.enum.archived ? ' (archived)' : ''}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Flex>
            )}

            {/* Amount Range */}
            {showFilters.amountRange && (
              <Flex direction="column" gap="2">
                <Text as="div" id={`${fieldId}-amount-range`} size="2" weight="medium">
                  <DollarSign size={16} className="inline mr-1" />
                  Amount Range
                </Text>
                <Grid columns="2" gap="2" role="group" aria-labelledby={`${fieldId}-amount-range`}>
                  {([['amountMin', 'Minimum amount', 'Min'], ['amountMax', 'Maximum amount', 'Max']] as const).map(([key, label, placeholder]) => {
                    const boxId = `${fieldId}-${key}`;
                    const kept = unreadableBounds[key] && !pendingBounds[key] ? keptBoundMessage(localFilters[key]) : null;
                    return (
                      <Flex key={key} direction="column" gap="1">
                        <CurrencyInput
                          id={boxId}
                          aria-label={label}
                          placeholder={placeholder}
                          // NaN while it can't be read: the text stays in sight after it loses focus,
                          // and a reset to no bound is a change the box sees.
                          value={unreadableBounds[key] ? Number.NaN : (localFilters[key] ?? null)}
                          onChange={handleAmountBound(key)}
                          onPendingChange={handlePendingBound(key)}
                          size="2"
                          allowNegative
                          hideOwnHint
                          {...fieldErrorProps(boxId, kept)}
                        />
                        <FieldError fieldId={boxId} message={kept} />
                      </Flex>
                    );
                  })}
                </Grid>
              </Flex>
            )}
          </Grid>
        </Box>
      )}
    </Card>
  );
};

export default SharedTransactionFilter;
