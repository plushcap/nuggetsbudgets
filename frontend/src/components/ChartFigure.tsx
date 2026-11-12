import React, { useId, useState } from 'react';
import { Box, Button, Flex, Table, Text } from '@radix-ui/themes';
import { ChevronDown, Table as TableIcon } from 'lucide-react';

export interface ChartFigureProps {
  /** What the chart shows ("Net worth over time"). */
  title: string;
  /** The point of it in a sentence ("Up from $41,200 to $48,900 over 12 months."). */
  summary: string;
  /** The data table's column headings. */
  columns: string[];
  /** The data, as the person would read it: formatted values, one array per row. */
  rows: React.ReactNode[][];
  /** The chart. */
  children: React.ReactNode;
}

/**
 * A chart with a text alternative: a screen reader reads the chart as one image,
 * named by its title and described by the summary shown under it, and anyone can open
 * the numbers it draws as a table ("Show data"), which also serves people who can't tell
 * its colours apart.
 */
const ChartFigure: React.FC<ChartFigureProps> = ({ title, summary, columns, rows, children }) => {
  const [showData, setShowData] = useState(false);
  const baseId = useId();
  const tableId = `${baseId}-data`;
  const summaryId = `${baseId}-summary`;
  return (
    <Box asChild m="0">
      <figure>
        <Box role="img" aria-label={title} aria-describedby={summaryId}>
          {children}
        </Box>
        <Flex asChild direction="column" gap="2" mt="2">
          <figcaption>
            <Text id={summaryId} size="1" color="gray">
              {summary}
            </Text>
            {rows.length > 0 && (
              <Box>
                <Button
                  type="button"
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-expanded={showData}
                  aria-controls={tableId}
                  onClick={() => setShowData((shown) => !shown)}
                >
                  <TableIcon aria-hidden size={12} />
                  {showData ? 'Hide data' : 'Show data'}
                  <ChevronDown aria-hidden size={12} className={`transition-transform ${showData ? 'rotate-180' : ''}`} />
                </Button>
              </Box>
            )}
          </figcaption>
        </Flex>
        <Box id={tableId} hidden={!showData} mt="2">
          {showData && (
            <Table.Root size="1" variant="surface">
              <caption className="sr-only">{title}</caption>
              <Table.Header>
                <Table.Row>
                  {columns.map((column) => (
                    <Table.ColumnHeaderCell key={column}>{column}</Table.ColumnHeaderCell>
                  ))}
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {rows.map((row, i) => (
                  <Table.Row key={i}>
                    {row.map((cell, j) =>
                      j === 0 ? (
                        <Table.RowHeaderCell key={j}>{cell}</Table.RowHeaderCell>
                      ) : (
                        <Table.Cell key={j}>{cell}</Table.Cell>
                      ),
                    )}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      </figure>
    </Box>
  );
};

export default ChartFigure;
