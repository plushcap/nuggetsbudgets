import React, { useId } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, Button, Flex, Select, Text } from '@radix-ui/themes';

export interface SharedPaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage?: number;
  onPageChange: (page: number) => void;
  itemLabel?: string; // e.g., "transactions", "accounts", "items"
  className?: string;
  /** The rows-per-page sizes to offer: with onItemsPerPageChange, a "Rows per page" picker. */
  pageSizeOptions?: readonly number[];
  /** Called with the size chosen, after onPageChange moves to the page holding the first row shown. */
  onItemsPerPageChange?: (size: number) => void;
}

const SharedPagination: React.FC<SharedPaginationProps> = ({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage = 20,
  onPageChange,
  itemLabel = 'items',
  className = '',
  pageSizeOptions,
  onItemsPerPageChange,
}) => {
  const pageSizeId = useId();
  // Calculate range of items being shown
  const startItem = Math.min((currentPage - 1) * itemsPerPage + 1, totalItems);
  const endItem = Math.min(currentPage * itemsPerPage, totalItems);

  // A new size: the page that holds the first row shown now, so the rows in view stay in view.
  const changePageSize = (value: string) => {
    const size = Number(value);
    if (!onItemsPerPageChange || !Number.isInteger(size) || size < 1 || size === itemsPerPage) return;
    onPageChange(Math.floor(((currentPage - 1) * itemsPerPage) / size) + 1);
    onItemsPerPageChange(size);
  };

  // Generate page numbers to display (max 5)
  const getPageNumbers = () => {
    const pages: number[] = [];

    if (totalPages <= 5) {
      // Show all pages if 5 or fewer
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else if (currentPage <= 3) {
      // Near the start
      for (let i = 1; i <= 5; i++) {
        pages.push(i);
      }
    } else if (currentPage >= totalPages - 2) {
      // Near the end
      for (let i = totalPages - 4; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Middle pages
      for (let i = currentPage - 2; i <= currentPage + 2; i++) {
        pages.push(i);
      }
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <Card className={className}>
      <Flex direction={{ initial: 'column', sm: 'row' }} align="center" justify="between" gap="4">
        <Flex direction={{ initial: 'column', sm: 'row' }} align="center" gap={{ initial: '2', sm: '4' }}>
          {/* Item Count Text */}
          <Text size="2" color="gray">
            Showing {startItem} to {endItem} of {totalItems} {itemLabel}
          </Text>

          {pageSizeOptions && onItemsPerPageChange && (
            <Flex align="center" gap="2">
              <Text as="label" size="2" color="gray" htmlFor={pageSizeId}>
                Rows per page
              </Text>
              <Select.Root size="2" value={String(itemsPerPage)} onValueChange={changePageSize}>
                <Select.Trigger id={pageSizeId} variant="soft" color="gray" />
                <Select.Content>
                  {pageSizeOptions.map((size) => (
                    <Select.Item key={size} value={String(size)}>
                      {size}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
          )}
        </Flex>

        {/* Pagination Controls */}
        <Flex align="center" gap="2">
          {/* Previous Button */}
          <Button
            variant="outline"
            size="2"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={16} />
          </Button>

          {/* Page Numbers */}
          <Flex align="center" gap="1">
            {pageNumbers.map((pageNum) => (
              <Button
                key={pageNum}
                variant={pageNum === currentPage ? 'solid' : 'soft'}
                color={pageNum === currentPage ? 'blue' : 'gray'}
                size="2"
                onClick={() => onPageChange(pageNum)}
                aria-label={`Page ${pageNum}`}
                aria-current={pageNum === currentPage ? 'page' : undefined}
              >
                {pageNum}
              </Button>
            ))}
          </Flex>

          {/* Next Button */}
          <Button
            variant="outline"
            size="2"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={16} />
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
};

export default SharedPagination;
