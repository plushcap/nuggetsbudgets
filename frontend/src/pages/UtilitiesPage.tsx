import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { AlertTriangle, Download, FileCode, ListChecks, Wrench } from 'lucide-react';
import { Box, Button, Callout, Card, Code, Flex, Heading, Text } from '@radix-ui/themes';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { downloadAppliedMigrations, downloadDatabaseSchema, type DownloadedFile } from '../services/api';
import { isSessionExpiredError } from '../services/api/base';
import { apiErrorMessage } from '../utils/errors';
import { saveBlob } from '../utils/saveBlob';
import PageContainer from '../components/PageContainer';

type Kind = 'schema' | 'migrations';

/** What a download that didn't finish says when the server gave no reason (the connection was cut). */
const UNFINISHED = "The download didn't finish. Try again; if it keeps failing, the server log has the details.";

const DOWNLOADS: Record<Kind, { title: string; button: string; icon: React.ReactNode; fetch: () => Promise<DownloadedFile> }> = {
  schema: {
    title: 'Database schema',
    button: 'Download database schema',
    icon: <FileCode size={20} className="text-[var(--accent-11)]" aria-hidden="true" />,
    fetch: downloadDatabaseSchema,
  },
  migrations: {
    title: 'Applied migrations',
    button: 'Download applied migrations',
    icon: <ListChecks size={20} className="text-[var(--accent-11)]" aria-hidden="true" />,
    fetch: downloadAppliedMigrations,
  },
};

/**
 * Settings → Utilities, for deployment admins: the two files that show how this
 * database differs from what a migration expected, to attach to a bug report when an
 * upgrade's migration fails. Neither holds a ledger's data.
 */
const UtilitiesPage: React.FC = () => {
  // Each download's own: the two can run at once.
  const [busy, setBusy] = useState<Partial<Record<Kind, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Kind, string>>>({});

  const download = async (kind: Kind) => {
    setBusy((current) => ({ ...current, [kind]: true }));
    setErrors((current) => ({ ...current, [kind]: undefined }));
    try {
      const file = await DOWNLOADS[kind].fetch();
      saveBlob(file.blob, file.fileName);
      toast.success(`Downloaded ${file.fileName}`);
    } catch (error) {
      // The API helper has logged it. An expired session is AuthContext's to report (it
      // signs the person out).
      if (!isSessionExpiredError(error)) setErrors((current) => ({ ...current, [kind]: apiErrorMessage(error, UNFINISHED) }));
    } finally {
      setBusy((current) => ({ ...current, [kind]: false }));
    }
  };

  const panel = (kind: Kind, description: React.ReactNode) => {
    const { title, button, icon } = DOWNLOADS[kind];
    const headingId = `utilities-${kind}-heading`;
    return (
      <Card size="3" asChild>
        <section aria-labelledby={headingId}>
          <Flex direction="column" gap="3">
            <Flex align="center" gap="2">
              {icon}
              <Heading as="h2" size="4" id={headingId}>{title}</Heading>
            </Flex>
            {description}
            <Box>
              <Button onClick={() => download(kind)} loading={busy[kind] === true} size="2">
                <Download size={16} aria-hidden="true" />
                {button}
              </Button>
            </Box>
            <Text as="p" size="2" color="gray" role="status">
              {busy[kind] ? `Preparing the ${title.toLowerCase()}…` : ''}
            </Text>
            {errors[kind] && (
              <Callout.Root color="red" role="alert">
                <Callout.Icon>
                  <AlertTriangle size={16} aria-hidden="true" />
                </Callout.Icon>
                <Callout.Text>
                  {`Couldn't download the ${title.toLowerCase()}: ${errors[kind]}`}
                </Callout.Text>
              </Callout.Root>
            )}
          </Flex>
        </section>
      </Card>
    );
  };

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Utilities"
        subtitle="Files to attach to a report about the database"
        icon={<Wrench size={20} className="text-[var(--accent-11)]" aria-hidden="true" />}
        backPath="/settings"
      />

      <Flex direction="column" gap="5">
        <Text as="p" size="3">
          When an upgrade stops because a database migration failed, these two files show how this database
          differs from what the migration expected. Download both and attach them to an issue on the Nuggets
          GitHub repository, with the backend&apos;s log lines about the failure. Neither file holds any of your
          financial data.
        </Text>

        {panel(
          'schema',
          <Text as="p" size="2">
            The definition of every table, index, trigger, function and row-level security policy in this
            database, as <Code>pg_dump --schema-only</Code> writes it. It has no rows: no accounts, transactions or
            other financial data, and no passwords.
          </Text>
        )}

        {panel(
          'migrations',
          <Text as="p" size="2">
            Every migration this database has run, from its <Code>schema_migrations</Code> table: each one&apos;s
            version, name, checksum and when it ran. It shows which migrations ran, which didn&apos;t, and which
            were changed after they ran.
          </Text>
        )}

        <Text as="p" size="2" color="gray">
          If the backend can&apos;t start because a migration failed or was refused, it writes both files
          itself, with a report (<Code>nuggets-migration-failure.txt</Code>), to the backups directory
          (<Code>BACKUPS_PATH</Code> on the host).
        </Text>
      </Flex>
    </PageContainer>
  );
};

export default UtilitiesPage;
