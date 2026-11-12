import React, { useEffect, useState } from 'react';
import { Box, Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { AlertTriangle, ChevronRight, Download } from 'lucide-react';
import { formatMoney } from '@nuggets/shared';
import type { Transaction } from '../../services/api';
import { formatTimestampInApplicationTimezone } from '../../utils/timezone';

/** The import's instants, in the household's time zone. */
interface ImportTimes {
  transactedAt?: string;
  importedAt?: string;
  postedDate?: string;
}

/** One line of what the import said: its caption above its value. */
const ImportDetail: React.FC<{ caption: string; children: React.ReactNode }> = ({ caption, children }) => (
  <Box>
    <Text size="1" color="gray" mb="1" as="div">{caption}</Text>
    {children}
  </Box>
);

/** What the bank's import said about a transaction, and how it differs from it now. */
export const ImportInformationCard: React.FC<{ transaction: Transaction }> = ({ transaction }) => {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [times, setTimes] = useState<ImportTimes>({});

  useEffect(() => {
    const formatTimes = async () => {
      const next: ImportTimes = {};
      if (transaction.import_transacted_at) {
        next.transactedAt = await formatTimestampInApplicationTimezone(transaction.import_transacted_at);
      }
      if (transaction.import_imported_at) {
        next.importedAt = await formatTimestampInApplicationTimezone(transaction.import_imported_at);
      }
      if (transaction.import_posted_date) {
        next.postedDate = await formatTimestampInApplicationTimezone(transaction.import_posted_date);
      }
      setTimes(next);
    };
    void formatTimes();
  }, [transaction.import_transacted_at, transaction.import_imported_at, transaction.import_posted_date]);

  const extra = transaction.import_extra;
  const hasExtra = !!extra && typeof extra === 'object' && Object.keys(extra as Record<string, unknown>).length > 0;

  return (
    <Card>
      <Heading as="h3" size="3" mb="4">
        <Flex align="center" gap="2">
          <Download size={16} className="text-[var(--accent-11)]" />
          Import Information
        </Flex>
      </Heading>

      <Flex direction="column" gap="3">
        {transaction.import_description && (
          <ImportDetail caption="Original Import Text">
            <Text size="2" color="gray" highContrast as="div">
              {transaction.import_description}
            </Text>
          </ImportDetail>
        )}

        {transaction.import_amount != null && transaction.import_amount !== transaction.amount && (
          <ImportDetail caption="Original Import Amount">
            <Text size="2" weight="medium" color="gray" highContrast as="div">
              {formatMoney(transaction.import_amount)}
            </Text>
            <Text size="1" color="orange" highContrast mt="1" as="div">
              Different from current amount
            </Text>
          </ImportDetail>
        )}

        {transaction.import_posted_date && (
          <ImportDetail caption="Import Posted Date">
            <Text size="2" color="gray" highContrast as="div">
              {times.postedDate || new Date(transaction.import_posted_date).toLocaleString()}
            </Text>
          </ImportDetail>
        )}

        {transaction.import_transacted_at && (
          <ImportDetail caption="Import Transaction Time">
            <Text size="2" color="gray" highContrast as="div">
              {times.transactedAt || new Date(transaction.import_transacted_at).toLocaleString()}
            </Text>
          </ImportDetail>
        )}

        {transaction.import_pending && (
          <ImportDetail caption="Import Status">
            <Flex align="center" gap="2">
              <AlertTriangle size={12} className="text-[var(--yellow-12)]" />
              <Text size="2" weight="medium" color="yellow" highContrast>
                Pending at Bank
              </Text>
            </Flex>
          </ImportDetail>
        )}

        {hasExtra ? (
          <ImportDetail caption="Additional Import Data">
            <pre className="text-xs text-[var(--gray-12)] whitespace-pre-wrap font-mono">{JSON.stringify(extra, null, 2)}</pre>
          </ImportDetail>
        ) : null}

        {/* Advanced: expandable */}
        {(transaction.import_provider || transaction.import_transaction_id || transaction.import_imported_at) && (
          <Box pt="3" className="border-t border-[var(--gray-6)]">
            <Button variant="ghost" color="gray" onClick={() => setShowAdvanced(!showAdvanced)} className="w-full">
              <Flex align="center" justify="between" width="100%">
                <Text size="2" weight="medium">Advanced</Text>
                <ChevronRight size={16} className={`text-[var(--gray-11)] transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
              </Flex>
            </Button>

            {showAdvanced && (
              <Flex direction="column" gap="3" mt="3" pl="2">
                {transaction.import_provider && (
                  <ImportDetail caption="Import Provider">
                    <Text size="2" weight="medium" color="gray" highContrast style={{ textTransform: 'capitalize' }} as="div">
                      {transaction.import_provider}
                    </Text>
                  </ImportDetail>
                )}

                {transaction.import_payee && (
                  <ImportDetail caption="Import Payee">
                    <Text size="2" weight="medium" color="gray" highContrast as="div">
                      {transaction.import_payee}
                    </Text>
                  </ImportDetail>
                )}

                {transaction.import_transaction_id && (
                  <ImportDetail caption="Import Transaction ID">
                    <Text size="2" color="gray" highContrast style={{ fontFamily: 'monospace', wordBreak: 'break-all' }} as="div">
                      {transaction.import_transaction_id}
                    </Text>
                  </ImportDetail>
                )}

                {transaction.import_imported_at && (
                  <ImportDetail caption="Import Date">
                    <Text size="2" color="gray" highContrast as="div">
                      {times.importedAt || new Date(transaction.import_imported_at).toLocaleString()}
                    </Text>
                  </ImportDetail>
                )}
              </Flex>
            )}
          </Box>
        )}

        <Box pt="2" className="text-center border-t border-[var(--gray-6)]">
          <Text size="1" color="gray">
            {transaction.is_import ? 'Imported Transaction' : 'Manually Created'}
          </Text>
        </Box>
      </Flex>
    </Card>
  );
};
