import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { BACKUP_SETTING_KEYS, type BackupFile, type StoredSetting } from '@nuggets/shared';
import {
  Download, Upload, Database, Shield,
  FileText, Trash2, Calendar, HardDrive,
  AlertTriangle, Clock, CheckCircle,
  Settings as SettingsIcon, Zap,
  ChevronLeft, ChevronRight, RotateCcw, ShieldCheck
} from 'lucide-react';
import { Box, Card, Flex, Grid, Text, Button, TextField, IconButton, Switch, Callout } from '@radix-ui/themes';
import { logger } from '../utils/logger';
import { useSeededState } from '../hooks/useSeededState';
import { errorMessage, errorDetailsText, apiErrorMessage } from '../utils/errors';
import { useConfirmation } from '../hooks/useConfirmation';
import { isReauthCancelledError, useReauth } from '../hooks/useReauth';
import ConfirmationDialog from '../components/ConfirmationDialog';
import ReauthDialog from '../components/ReauthDialog';
import SettingsPageHeader from '../components/SettingsPageHeader';
import OneDriveSync from '../components/OneDriveSync';
import DeploymentTimeZoneCard from '../components/DeploymentTimeZoneCard';
import {
  startBackupScheduler, stopBackupScheduler, updateBackupSettings,
  uploadBackupToOneDrive, getOneDriveStatus, checkBackupOneDriveStatus,
  getBackups,
  createBackup as apiCreateBackup,
  getBackupCreateStatus,
  restoreBackup as apiRestoreBackup,
  restoreBackupFromServer,
  getRestoreStatus,
  verifyBackup as apiVerifyBackup,
  verifyBackupFromServer,
  getVerifyStatus,
  getBackupHeader,
  downloadBackup as apiDownloadBackup,
  deleteBackup as apiDeleteBackup,
} from '../services/api';
import type { BackupKeyAnswer, RestoreStatus, VerifyStatus } from '../services/api/backup';
import { SessionExpiredError } from '../services/api/base';
import { backupRunsQueryKey, useBackupKeysQuery, useBackupRunsQuery, useBackupSchedulerStatusQuery, useBackupSettingsQuery } from '../hooks/queries';
import BackupKeysCard from '../components/backup/BackupKeysCard';
import BackupRunsCard, { VerifiedLine } from '../components/backup/BackupRunsCard';
import LastRestoreCallout from '../components/backup/LastRestoreCallout';
import BackupKeyPrompt, { useBackupKeyPrompt } from '../components/backup/BackupKeyPrompt';
import { backupFormatOf, headerOfFile } from '../utils/ageKeys';
import { formatInstantDate } from '../utils/dateUtils';
import NuggetSpinner from '../components/NuggetSpinner';
import { saveBlob } from '../utils/saveBlob';
import PageContainer from '../components/PageContainer';
import FilePickerButton from '../components/forms/FilePickerButton';

/** A backup as the list shows it: whether OneDrive has it is unknown (undefined) until OneDrive answers for it. */
type Backup = Omit<BackupFile, 'onedriveUploaded'> & { onedriveUploaded?: boolean | undefined };

/** The settings being edited: the server's, and any changed here that it didn't list (only a value). */
type BackupSettings = Record<string, Partial<StoredSetting> & { value: string | null }>;

const PAGE_SIZE = 5;

/** What a running restore is doing, in words. */
const RESTORE_PHASES: Record<NonNullable<RestoreStatus['phase']>, string> = {
  decrypting: 'Decrypting the backup',
  checking: 'Checking the backup',
  restoring: 'Restoring into a scratch database',
  migrating: 'Bringing it up to this version',
  verifying: 'Checking the restored data',
  swapping: 'Putting the restored data in place',
  'restoring-uploads': 'Restoring the uploaded files',
};

/** The restore ran out of time on the page's side; it may still be running on the server. */
const RESTORE_WAIT_MS = 6 * 60 * 60 * 1000;

/** The restore replaced the sign-ins along with everything else. */
class SignInReplacedError extends Error {}

/** How the restore ended, as the server's status says: its message is the reason to show. */
class RestoreOutcomeError extends Error {}

/** A backup's file name, by its extension: `.tar.age` (or `.age`), or an older `.enc`. What it is comes from its bytes. */
const isBackupFileName = (name: string) => name.endsWith('.age') || name.endsWith('.enc');

/** What the file chooser offers for a backup. */
const BACKUP_FILE_TYPES = '.tar.age,.age,.enc';

/** The backup a status names, in words: its signed id and date, when it has them. */
const backupNamed = (status: { backupId?: string | null | undefined; backupCreatedAt?: string | null | undefined }) =>
  status.backupId ? `${status.backupId}${status.backupCreatedAt ? `, made ${formatInstantDate(status.backupCreatedAt)}` : ''}` : null;

/** Wait for the verify the server started: it runs in the background, while the app keeps serving. */
async function waitForVerify(onProgress: (status: VerifyStatus) => void): Promise<VerifyStatus> {
  const deadline = Date.now() + RESTORE_WAIT_MS;
  let unreachable = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let status: VerifyStatus;
    try {
      status = await getVerifyStatus();
      unreachable = 0;
    } catch (error) {
      if (++unreachable >= 30) throw new RestoreOutcomeError('Lost contact with the server during the verify', { cause: error });
      continue;
    }
    onProgress(status);
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new RestoreOutcomeError(status.error || 'The backup did not verify');
    if (status.status === 'idle') throw new RestoreOutcomeError('The server restarted before the verify finished');
  }
  throw new RestoreOutcomeError('Gave up waiting for the verify; it may still be running on the server');
}

/**
 * Wait for the restore the server started to finish: it runs in the background (it can
 * take longer than a proxy waits for an answer). Resolves when it completed; throws with
 * the server's reason when it failed, or SignInReplacedError once the data has been replaced:
 * a restore ends every sign-in, this one too.
 */
async function waitForRestore(onProgress: (status: RestoreStatus) => void): Promise<RestoreStatus> {
  const deadline = Date.now() + RESTORE_WAIT_MS;
  let unreachable = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    let status: RestoreStatus;
    try {
      status = await getRestoreStatus();
      unreachable = 0;
    } catch (error) {
      if (error instanceof SessionExpiredError) throw new SignInReplacedError('Signed out by the restore', { cause: error });
      // The server can be busy swapping the data in; give it a minute.
      if (++unreachable >= 30) throw new RestoreOutcomeError('Lost contact with the server during the restore', { cause: error });
      continue;
    }
    onProgress(status);
    if (status.status === 'completed') return status;
    if (status.status === 'failed') throw new RestoreOutcomeError(status.error || 'The restore failed');
    if (status.status === 'idle') throw new RestoreOutcomeError('The server restarted before the restore finished');
  }
  throw new RestoreOutcomeError('Gave up waiting for the restore; it may still be running on the server');
}

const BackupPage: React.FC = () => {
  const { confirmAsync, dialogProps } = useConfirmation();
  const { withReauth, ensureReauthenticated, dialogProps: reauthDialogProps } = useReauth();
  const queryClient = useQueryClient();
  // The record of backups: each listed file's last verify.
  const runsQuery = useBackupRunsQuery();
  const runByFile = useMemo(() => new Map((runsQuery.data?.runs ?? []).map((run) => [run.fileName, run])), [runsQuery.data]);
  const refreshRuns = useCallback(() => void queryClient.invalidateQueries({ queryKey: backupRunsQueryKey }), [queryClient]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restorePhase, setRestorePhase] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyPhase, setVerifyPhase] = useState<string | null>(null);
  const { askForKey, promptProps } = useBackupKeyPrompt();

  // The backup keys: backups can be made once there is one (or, on an upgraded install, the old key).
  const keysQuery = useBackupKeysQuery();
  const canBackUp = keysQuery.data ? keysQuery.data.mode !== 'none' : false;

  // Scheduler state
  const schedulerStatusQuery = useBackupSchedulerStatusQuery();
  const status = schedulerStatusQuery.data ?? null;
  const statusLoading = schedulerStatusQuery.isLoading;
  const settingsQuery = useBackupSettingsQuery();
  const settingsLoading = settingsQuery.isLoading;
  // An editable copy of the saved settings, taken again each time they load.
  const [settings, setSettings] = useSeededState<BackupSettings | null>(
    (current) => settingsQuery.data?.settings ?? current ?? null,
    [settingsQuery.data],
  );
  const [saving, setSaving] = useState(false);
  const [schedulerActionLoading, setSchedulerActionLoading] = useState(false);

  // OneDrive state
  const [onedriveStatus, setOnedriveStatus] = useState<{ configured: boolean; connected: boolean } | null>(null);
  const [onedriveStatusLoading, setOnedriveStatusLoading] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<Set<string>>(new Set());

  /**
   * Fill in the OneDrive upload status of `backupList`. `knownStatus` is the
   * connection status already fetched; without it, it's fetched first.
   */
  const loadOnedriveStatusForBackups = useCallback(async (
    backupList: Backup[],
    knownStatus?: { configured: boolean; connected: boolean } | null,
  ) => {
    const skipStatusFetch = knownStatus !== undefined;
    try {
      setOnedriveStatusLoading(true);

      let currentOnedriveStatus = knownStatus ?? null;
      if (!skipStatusFetch) {
        const answer = await getOneDriveStatus();
        // Not set up: not connected either.
        currentOnedriveStatus = { configured: answer.configured, connected: answer.configured && answer.connected };
        setOnedriveStatus(currentOnedriveStatus);
      }

      // If OneDrive is connected and we have backups, check their upload status
      if (currentOnedriveStatus?.connected && backupList.length > 0) {
        const fileNames = backupList.map(b => b.fileName);
        const statusResponse = await checkBackupOneDriveStatus(fileNames);

        // Update backups with OneDrive status
        setBackups(prevBackups =>
          prevBackups.map(backup => ({
            ...backup,
            onedriveUploaded: statusResponse.status[backup.fileName] !== undefined
              ? statusResponse.status[backup.fileName]
              : backup.onedriveUploaded
          }))
        );
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to load OneDrive status');
      // Don't show error toast, just fail silently
      if (!skipStatusFetch) {
        setOnedriveStatus(null);
      }
    } finally {
      setOnedriveStatusLoading(false);
    }
  }, []);

  // Fetch the list; `loading` is already set (it starts true; reloadBackups sets it).
  // A promise chain rather than async/await: the React Compiler's set-state-in-effect
  // check reads state set after an `await` in a callback as set synchronously.
  const fetchBackups = useCallback(
    () =>
      getBackups()
        .then((data) => {
          const backupList: Backup[] = data.backups;
          setBackups(backupList);
          setCurrentPage(0);

          // Trigger OneDrive status check in background for the first page only
          const firstPage = backupList.slice(0, PAGE_SIZE);
          if (firstPage.length > 0) {
            // Use setTimeout to ensure state update completes first
            setTimeout(() => {
              void loadOnedriveStatusForBackups(firstPage);
            }, 100);
          }
        })
        .catch((error: unknown) => {
          toast.error('Failed to load backups');
          logger.error({ err: error }, 'Failed to load backups');
        })
        .finally(() => setLoading(false)),
    [loadOnedriveStatusForBackups],
  );

  useEffect(() => {
    void fetchBackups();
  }, [fetchBackups]);

  const reloadBackups = () => {
    setLoading(true);
    refreshRuns();
    return fetchBackups();
  };

  // Going to another page checks the OneDrive status of its backups not checked yet
  // (the first page is checked when the list loads).
  const goToPage = (page: number) => {
    setCurrentPage(page);
    const unchecked = backups
      .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
      .filter((b) => b.onedriveUploaded === undefined);
    if (unchecked.length > 0) {
      void loadOnedriveStatusForBackups(unchecked, onedriveStatus);
    }
  };



  const reloadAllData = async () => {
    await Promise.all([settingsQuery.refetch(), schedulerStatusQuery.refetch()]);
  };

  const handleSettingChange = (key: string, value: string) => {
    if (settings) {
      setSettings({
        ...settings,
        [key]: {
          ...settings[key],
          value
        }
      });
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      
      // Only the editable keys that changed: the server rejects any other key, and an
      // untouched value is left as stored.
      const saved = (settingsQuery.data?.settings ?? {}) as Partial<BackupSettings>;
      const settingsToSave = BACKUP_SETTING_KEYS.reduce((acc, key) => {
        const value = settings[key]?.value;
        if (value !== undefined && value !== saved[key]?.value) acc[key] = value ?? '';
        return acc;
      }, {} as Record<string, string>);

      await updateBackupSettings(settingsToSave);

      toast.success('Settings saved successfully');
      await reloadAllData();
    } catch (error) {
      logger.error({ err: error }, 'Failed to save backup settings');
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAutomaticBackup = async () => {
    if (!settings?.backup_enabled) return;
    
    const newValue = settings.backup_enabled.value === 'true' ? 'false' : 'true';
    const isEnabling = newValue === 'true';
    
    try {
      setSchedulerActionLoading(true);
      
      // First update the setting
      handleSettingChange('backup_enabled', newValue);
      
      // Then control the scheduler based on the new setting
      if (isEnabling) {
        const response = await startBackupScheduler();
        if (response.success) {
          toast.success('Automatic backup enabled and scheduler started');
        } else {
          toast.error('Setting updated but failed to start scheduler');
        }
      } else {
        const response = await stopBackupScheduler();
        if (response.success) {
          toast.success('Automatic backup disabled and scheduler stopped');
        } else {
          toast.error('Setting updated but failed to stop scheduler');
        }
      }
      
      await reloadAllData();
      
    } catch (error) {
      logger.error({ err: error }, 'Failed to toggle automatic backup');
      toast.error('Failed to update automatic backup');
    } finally {
      setSchedulerActionLoading(false);
    }
  };

  const createBackup = async () => {
    setCreating(true);
    try {
      // The backup now runs server-side (POST returns 202); poll until it
      // finishes — a large DB dump can take minutes.
      await apiCreateBackup();
      const deadline = Date.now() + 15 * 60 * 1000; // 15-minute safety cap
      let done = false;
      while (!done && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const status = await getBackupCreateStatus();
        if (status.status === 'completed') {
          done = true;
        } else if (status.status === 'failed') {
          throw new Error(status.error || 'Backup failed');
        } else if (status.status === 'idle') {
          // The server answered 'running' when it started; 'idle' means it restarted since.
          throw new Error('The server restarted before the backup finished');
        }
      }
      if (!done) {
        throw new Error('Timed out waiting for the backup to complete');
      }
      toast.success('Backup created successfully!');
      await reloadBackups(); // Refresh list (will also check OneDrive status)
    } catch (error) {
      const detail = errorDetailsText(error) ?? errorMessage(error, 'Failed to create backup');
      if (detail.includes('Docker secret')) {
        toast.error('Backup system not configured. Docker secret required.');
      } else {
        toast.error(`Failed to create backup: ${detail}`);
      }
      logger.error({ err: error }, 'Failed to create backup');
    } finally {
      setCreating(false);
    }
  };

  const handleFileSelect = (file: File) => {
    if (!isBackupFileName(file.name)) {
      toast.error('Please select a backup file (.tar.age, or an older .enc)');
      return;
    }
    setSelectedFile(file);
  };

  /** What opens a backup chosen on this computer: the prompt reads its header from the file itself. */
  const keysForUpload = async (file: File, action: 'restore' | 'verify'): Promise<BackupKeyAnswer | null> => {
    const format = await backupFormatOf(file).catch(() => 'unknown' as const);
    if (format === 'unknown') {
      toast.error("That file isn't a Nuggets backup");
      return null;
    }
    return askForKey({ format, fileName: file.name, action, header: () => headerOfFile(file) });
  };

  /** What opens a backup on the server: the prompt fetches its header. */
  const keysForServer = async (backup: Backup, action: 'restore' | 'verify'): Promise<BackupKeyAnswer | null> => {
    if (backup.format !== 'age' && backup.format !== 'legacy') {
      toast.error("That file isn't a backup this version can open");
      return null;
    }
    return askForKey({ format: backup.format, fileName: backup.fileName, action, header: () => getBackupHeader(backup.fileName) });
  };

  /** A restore or verify form: the backup file, and what opens it. */
  const backupForm = (file: File, keys: BackupKeyAnswer) => {
    const formData = new FormData();
    formData.append('backup', file);
    if (keys.fileKey) formData.append('fileKey', keys.fileKey);
    if (keys.encryptionKey) formData.append('encryptionKey', keys.encryptionKey);
    return formData;
  };

  const confirmRestore = (what: string) =>
    confirmAsync({
      title: 'Restore Database Backup',
      message: `This replaces all of the current data and uploaded files with those in ${what}.`,
      variant: 'danger',
      confirmText: 'Restore Database',
      cancelText: 'Cancel Restore',
      icon: <AlertTriangle size={24} />,
      details: [
        'All current financial data, user accounts and settings are replaced by the backup\'s',
        'All uploaded files and attachments are replaced',
        'Nothing can be changed while it runs, and you may have to sign in again afterwards',
        'The data from before is kept on the server until the next restore',
      ],
    });

  /**
   * A restore takes step-up: the password or a passkey, unless confirmed in the last few
   * minutes. Asked here, before anything is sent: the server checks it before it reads an
   * upload, but a browser may send the whole file before it reads the refusal. False when the
   * user closed the prompt, or the check failed (said).
   */
  const confirmIdentity = async (): Promise<boolean> => {
    try {
      await ensureReauthenticated();
      return true;
    } catch (error) {
      if (!isReauthCancelledError(error)) toast.error(apiErrorMessage(error, 'Couldn’t check that it’s you'));
      return false;
    }
  };

  /** Start a restore with `start`, then follow it until it is done. */
  const runRestore = async (start: () => Promise<unknown>) => {
    setRestoring(true);
    setRestorePhase('Starting the restore');
    try {
      await start();
      const done = await waitForRestore((status) => setRestorePhase(status.phase ? RESTORE_PHASES[status.phase] : null));
      const named = backupNamed(done);
      toast.success(`Backup${named ? ` ${named}` : ''} restored. The page reloads with the restored data.`);
      setSelectedFile(null);
      setTimeout(() => window.location.reload(), 3000);
    } catch (error) {
      if (error instanceof SignInReplacedError) {
        // Signed out by the swap: how the restore ended (the uploads come after it) shows once signed in.
        toast.success('The restore signed everyone out: sign in again, and this page shows how it went.', { duration: 10000 });
        return;
      }
      // The confirmation lapsed as the restore was sent, and the user closed the prompt.
      if (isReauthCancelledError(error)) return;
      // The status's reason, or the API's for a refused start (409 running, 404, 413 too large).
      const detail = error instanceof RestoreOutcomeError ? error.message : apiErrorMessage(error, 'the server log has the details');
      toast.error(`Failed to restore backup: ${detail}`);
      logger.error({ err: error }, 'Failed to restore backup');
    } finally {
      setRestoring(false);
      setRestorePhase(null);
    }
  };

  const restoreBackup = async () => {
    if (!selectedFile) {
      toast.error('Please select a backup file');
      return;
    }
    // The key first: a wrong one is said before a large upload, and before the confirmation.
    const keys = await keysForUpload(selectedFile, 'restore');
    if (!keys || !(await confirmRestore(selectedFile.name)) || !(await confirmIdentity())) return;
    await runRestore(() => withReauth(() => apiRestoreBackup(backupForm(selectedFile, keys))));
  };

  const restoreFromServer = async (backup: Backup) => {
    const keys = await keysForServer(backup, 'restore');
    if (!keys || !(await confirmRestore(backup.fileName)) || !(await confirmIdentity())) return;
    await runRestore(() => withReauth(() => restoreBackupFromServer(backup.fileName, keys)));
  };

  /** Start a verify with `start`, then follow it: the data stays as it is, and the app keeps serving. */
  const runVerify = async (start: () => Promise<unknown>) => {
    setVerifying(true);
    setVerifyPhase('Starting the verify');
    try {
      await start();
      const done = await waitForVerify((status) => setVerifyPhase(status.phase ? RESTORE_PHASES[status.phase] : null));
      const named = backupNamed(done);
      toast.success(`Backup${named ? ` ${named}` : ''} verified: it restores, migrates and passes the checks. Nothing was changed.`, {
        duration: 8000,
      });
    } catch (error) {
      const detail = error instanceof RestoreOutcomeError ? error.message : apiErrorMessage(error, 'the server log has the details');
      toast.error(`The backup did not verify: ${detail}`);
      logger.error({ err: error }, 'Failed to verify backup');
    } finally {
      // The record shows the verify, passed or failed.
      refreshRuns();
      setVerifying(false);
      setVerifyPhase(null);
    }
  };

  const verifyUpload = async () => {
    if (!selectedFile) {
      toast.error('Please select a backup file');
      return;
    }
    const keys = await keysForUpload(selectedFile, 'verify');
    if (!keys) return;
    await runVerify(() => apiVerifyBackup(backupForm(selectedFile, keys)));
  };

  const verifyFromServer = async (backup: Backup) => {
    const keys = await keysForServer(backup, 'verify');
    if (!keys) return;
    await runVerify(() => verifyBackupFromServer(backup.fileName, keys));
  };

  const downloadBackup = async (fileName: string) => {
    try {
      saveBlob(await apiDownloadBackup(fileName), fileName);

      toast.success('Backup downloaded successfully');
    } catch (error) {
      toast.error('Failed to download backup');
      logger.error({ err: error }, 'Failed to download backup');
    }
  };

  const handleDeleteBackup = async (fileName: string) => {
    const confirmed = await confirmAsync({
      title: 'Delete Backup',
      message: `Delete backup "${fileName}"?\n\nThis backup file will be permanently removed.`,
      variant: 'danger',
      confirmText: 'Delete Backup',
      cancelText: 'Keep Backup',
      icon: <Trash2 size={24} />
    });
    if (!confirmed) return;

    try {
      await apiDeleteBackup(fileName);
      toast.success('Backup deleted successfully');
      await reloadBackups(); // Refresh list (will also check OneDrive status)
    } catch (error) {
      toast.error('Failed to delete backup');
      logger.error({ err: error }, 'Failed to delete backup');
    }
  };

  const handleDownloadBackup = async (fileName: string) => {
    try {
      await downloadBackup(fileName);
      toast.success('Backup downloaded successfully');
    } catch (error) {
      toast.error('Failed to download backup');
      logger.error({ err: error }, 'Failed to download backup');
    }
  };

  const handleUploadToOneDrive = async (fileName: string) => {
    try {
      setUploadingFiles(prev => new Set(prev).add(fileName));
      await uploadBackupToOneDrive(fileName);
      toast.success(`${fileName} uploaded to OneDrive successfully`);
      
      // Update the specific backup's status immediately
      setBackups(prevBackups =>
        prevBackups.map(backup =>
          backup.fileName === fileName
            ? { ...backup, onedriveUploaded: true }
            : backup
        )
      );
    } catch (error) {
      toast.error(`Failed to upload ${fileName} to OneDrive`);
      logger.error({ err: error, fileName }, 'Failed to upload backup to OneDrive');
    } finally {
      setUploadingFiles(prev => {
        const newSet = new Set(prev);
        newSet.delete(fileName);
        return newSet;
      });
    }
  };

  if (loading) {
    return (
      <PageContainer>
        <Flex direction="column" align="center" justify="center" minHeight="400px" gap="4">
          <NuggetSpinner size={32} />
          <Text className="text-[var(--gray-11)]">Loading backup system...</Text>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Database Backup & Restore"
        subtitle="Create encrypted backups of your financial data"
        icon={<Database size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
      />

      {/* What the last restore did, once its admin has signed in again */}
      <LastRestoreCallout />

      {/* The deployment's time zone: the backup schedule's, and every ledger's without its own */}
      <DeploymentTimeZoneCard />

      {/* Scheduler Status & Configuration */}
      <Card mb="6">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2">
            <Zap size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold">Automatic Backup Schedule</Text>
          </Flex>

          {statusLoading ? (
            <Flex direction="column" align="center" py="4" gap="2">
              <NuggetSpinner size={32} />
              <Text className="text-[var(--gray-11)]">Loading scheduler status...</Text>
            </Flex>
          ) : (
            <>
              <Grid columns={{ initial: '1', md: '2' }} gap="4">
                <Flex align="center" gap="3">
                  <Box
                    width="12px"
                    height="12px"
                    className={`rounded-full ${status?.configured ? 'bg-[var(--green-9)]' : 'bg-[var(--red-9)]'}`}
                  />
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Configuration</Text>
                    <Text size="2" className="text-[var(--gray-11)]">
                      {status?.configured ? 'Backup time configured' : 'Backup time missing'}
                    </Text>
                  </Flex>
                </Flex>

                <Flex align="center" gap="3">
                  <Box
                    width="12px"
                    height="12px"
                    className={`rounded-full ${status?.scheduler?.running ? 'bg-[var(--green-9)]' : status?.scheduler?.waitingForBackupKey ? 'bg-[var(--amber-9)]' : 'bg-[var(--gray-8)]'}`}
                  />
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Scheduler Status</Text>
                    <Text size="2" className="text-[var(--gray-11)]">
                      {status?.scheduler?.running ? 'Running' : status?.scheduler?.waitingForBackupKey ? 'Waiting for a backup key' : 'Stopped'}
                    </Text>
                  </Flex>
                </Flex>
              </Grid>

              {status?.scheduler?.waitingForBackupKey && (
                <Callout.Root highContrast color="amber">
                  <Callout.Icon>
                    <AlertTriangle size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Automatic backups are on, but every backup is encrypted to your backup keys and there is none
                    yet. They start once you make or add one under Backup keys.
                  </Callout.Text>
                </Callout.Root>
              )}

              {status?.scheduler?.usingOldBackupKey && (
                <Callout.Root highContrast color="amber">
                  <Callout.Icon>
                    <AlertTriangle size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Backups still use the old backup key, which this server holds. Set up a backup key under Backup
                    keys, and backups from then on open only with your private key.
                  </Callout.Text>
                </Callout.Root>
              )}

              {status?.scheduler?.nextBackupTime && (
                <Callout.Root>
                  <Callout.Icon>
                    <Clock size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Next automatic backup: {new Date(status.scheduler.nextBackupTime).toLocaleString()}
                  </Callout.Text>
                </Callout.Root>
              )}

              {status?.scheduler?.lastRunOutcome === 'failed' && (
                <Callout.Root color="red">
                  <Callout.Icon>
                    <AlertTriangle size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    The last automatic backup failed
                    {status.scheduler.lastRunFinishedAt
                      ? ` (${new Date(status.scheduler.lastRunFinishedAt).toLocaleString()})`
                      : ''}
                    . The server log has the details.
                  </Callout.Text>
                </Callout.Root>
              )}
            </>
          )}

          {/* Settings Form */}
          {settings && !settingsLoading && (
            <Flex direction="column" gap="6" pt="6" className="border-t border-[var(--gray-4)]">
              <Flex align="center" gap="2">
                <SettingsIcon size={16} className="text-[var(--gray-11)]" />
                <Text size="4" weight="bold">Backup Configuration</Text>
              </Flex>

              {/* Enable Automatic Backup */}
              <Flex justify="between" align="center">
                <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%">
                  <Text weight="medium">Enable Automatic Backups</Text>
                  <Text size="2" className="text-[var(--gray-11)]">
                    {settings.backup_enabled?.description}
                  </Text>
                </Flex>
                {schedulerActionLoading ? (
                  <NuggetSpinner size={24} />
                ) : (
                  <Switch
                    checked={(status?.scheduler?.running || status?.scheduler?.waitingForBackupKey) ?? false}
                    onCheckedChange={handleToggleAutomaticBackup}
                    disabled={schedulerActionLoading}
                    color="green"
                    size="3"
                    aria-label="Enable automatic backups"
                  />
                )}
              </Flex>

              {/* The schedule: three short fields side by side on a wide page */}
              <Grid columns={{ initial: '1', md: '3' }} gap="4">
                {/* Backup Time */}
                <Flex direction="column" gap="2">
                  <Text as="label" htmlFor="backup-time" size="2" weight="medium">Backup Time (24-hour format, in the deployment time zone above)</Text>
                  <TextField.Root
                    id="backup-time"
                    type="time"
                    value={settings.backup_time?.value || '03:00'}
                    onChange={(e) => handleSettingChange('backup_time', e.target.value)}
                    size="3"
                  />
                  <Text size="1" color="gray">
                    {settings.backup_time?.description}
                  </Text>
                </Flex>

                {/* Backup Frequency */}
                <Flex direction="column" gap="2">
                  <Text as="label" htmlFor="backup-frequency-days" size="2" weight="medium">Backup Frequency (Days)</Text>
                  <TextField.Root
                    id="backup-frequency-days"
                    type="number"
                    min="1"
                    max="365"
                    value={settings.backup_frequency_days?.value || '7'}
                    onChange={(e) => handleSettingChange('backup_frequency_days', e.target.value)}
                    size="3"
                  />
                  <Text size="1" color="gray">
                    {settings.backup_frequency_days?.description || 'How often backups run (1=daily, 7=weekly, 30=monthly)'}
                  </Text>
                </Flex>

                {/* Retention Days */}
                <Flex direction="column" gap="2">
                  <Text as="label" htmlFor="backup-retention-days" size="2" weight="medium">Backup Retention (Days)</Text>
                  <TextField.Root
                    id="backup-retention-days"
                    type="number"
                    min="1"
                    max="365"
                    value={settings.backup_retention_days?.value || '90'}
                    onChange={(e) => handleSettingChange('backup_retention_days', e.target.value)}
                    size="3"
                  />
                  <Text size="1" color="gray">
                    {settings.backup_retention_days?.description}
                  </Text>
                </Flex>
              </Grid>

              {/* Save Button */}
              <Flex>
                <Button
                  onClick={handleSaveSettings}
                  disabled={saving}
                  loading={saving}
                  size="3"
                >
                  <CheckCircle size={16} />
                  Save Settings
                </Button>
              </Flex>
            </Flex>
          )}
        </Flex>
      </Card>

      {/* OneDrive Cloud Storage Sync */}
      <OneDriveSync onUploadComplete={reloadBackups} />

      {/* Info Card */}
      <Callout.Root mb="6">
        <Callout.Icon>
          <Shield size={20} />
        </Callout.Icon>
        <Callout.Text>
          <Flex direction="column" gap="2">
            <Text weight="bold">Secure Backup System</Text>
            <Flex direction="column" gap="1" style={{ fontSize: '14px' }}>
              <Text>• Complete database with all financial data and user accounts</Text>
              <Text>• All uploaded images and attachments included</Text>
              <Text>• Encrypted with age to your backup keys: only your private keys open it, not this server</Text>
              <Text>• Signed by this server, so a restore here takes only its own backups</Text>
              <Text>• One file that opens with the age command too (age -d, then tar)</Text>
            </Flex>
          </Flex>
        </Callout.Text>
      </Callout.Root>

      {/* Backup keys: the owner's age public keys */}
      <BackupKeysCard />

      <Grid columns={{ initial: '1', lg: '2' }} gap="6">
        {/* Create Backup */}
        <Card>
          <Flex direction="column" gap="6">
            <Flex align="center" gap="2">
              <Database size={24} className="text-[var(--accent-11)]" />
              <Text size="5" weight="bold">Create Backup</Text>
            </Flex>

            {keysQuery.data && !canBackUp && (
              <Text size="1" color="amber" highContrast>
                Make or add a backup key above before creating a backup.
              </Text>
            )}
            <Button
              onClick={createBackup}
              disabled={creating || !canBackUp}
              loading={creating}
              size="3"
              style={{ width: '100%' }}
            >
              <Download size={16} />
              {creating ? 'Creating Backup...' : 'Create Backup'}
            </Button>
          </Flex>
        </Card>

        {/* Restore Backup */}
        <Card>
          <Flex direction="column" gap="6">
            <Flex align="center" gap="2">
              <Upload size={24} className="text-[var(--orange-12)]" />
              <Text size="5" weight="bold">Restore Backup</Text>
            </Flex>

            <Callout.Root highContrast color="orange">
              <Callout.Icon>
                <AlertTriangle size={20} />
              </Callout.Icon>
              <Callout.Text>
                <Flex direction="column" gap="1">
                  <Text weight="bold">⚠️ Warning</Text>
                  <Text size="2">
                    This will completely replace your current database and uploads.
                    All existing data will be lost.
                  </Text>
                </Flex>
              </Callout.Text>
            </Callout.Root>

            <Flex direction="column" gap="2" align="start">
              <Text as="div" id="backup-file-caption" size="2" weight="medium">Backup File (.tar.age, or an older .enc)</Text>
              {/* The file chosen shows in the card below. */}
              <FilePickerButton accept={BACKUP_FILE_TYPES} onFiles={([file]) => file && handleFileSelect(file)} aria-describedby="backup-file-caption backup-file-hint" size="3">
                <Upload size={16} />
                {selectedFile ? 'Choose another backup file' : 'Choose backup file'}
              </FilePickerButton>
              <Text id="backup-file-hint" size="1" color="gray">
                Restore and Verify ask for the private key of one of the backup keys it was made for (an older .enc backup:
                the old backup key). The key stays in this browser. Verify restores it into a scratch database, checks it and
                drops it, while the app keeps running. A restore also asks for your password or a passkey, unless you
                confirmed one in the last few minutes. Here, the app restores only backups this server made; another server’s
                goes through the restore command on the server.
              </Text>
            </Flex>

            {selectedFile && (
              <Card className="[--card-background-color:var(--gray-2)]">
                <Flex align="center" gap="2" wrap="wrap">
                  <FileText size={16} className="text-[var(--gray-11)]" style={{ flexShrink: 0 }} />
                  <Text size="2" weight="medium" style={{ wordBreak: 'break-all' }}>
                    {selectedFile.name}
                  </Text>
                  <Text size="2" color="gray" style={{ flexShrink: 0 }}>
                    ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)
                  </Text>
                </Flex>
              </Card>
            )}

            <Grid columns={{ initial: '1', sm: '2' }} gap="3">
              <Button
                onClick={() => void verifyUpload()}
                disabled={verifying || restoring || !selectedFile}
                loading={verifying}
                size="3"
                variant="soft"
              >
                <ShieldCheck size={16} />
                {verifying ? 'Verifying...' : 'Verify'}
              </Button>
              <Button
                onClick={() => void restoreBackup()}
                disabled={restoring || verifying || !selectedFile}
                loading={restoring}
                size="3"
                color="orange"
              >
                <Upload size={16} />
                {restoring ? 'Restoring...' : 'Restore Database'}
              </Button>
            </Grid>
            {restorePhase && (
              <Text size="2" color="gray" role="status">
                {restorePhase}…
              </Text>
            )}
            {verifyPhase && (
              <Text size="2" color="gray" role="status">
                Verifying: {verifyPhase}…
              </Text>
            )}
          </Flex>
        </Card>
      </Grid>

      {/* Backup History */}
      <Card mt="8">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2" pb="4" className="border-b border-[var(--gray-4)]">
            <HardDrive size={24} className="text-[var(--gray-11)]" />
            <Text size="5" weight="bold">Backup History</Text>
          </Flex>

          {backups.length === 0 ? (
            <Flex direction="column" align="center" py="8" gap="4">
              <HardDrive size={48} className="text-[var(--gray-6)]" />
              <Flex direction="column" align="center" gap="1">
                <Text color="gray">No backups found</Text>
                <Text size="2" className="text-[var(--gray-11)]">Create your first backup to get started</Text>
              </Flex>
            </Flex>
          ) : (
            <Flex direction="column" gap="3">
              {backups.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((backup) => (
                <Card key={backup.fileName} className="[--card-background-color:var(--gray-2)]">
                  <Flex direction={{ initial: 'column', sm: 'row' }} justify="between" align={{ sm: 'center' }} gap="3">
                    <Flex align="start" gap="3" flexGrow="1" flexBasis="0%" minWidth="0">
                      <FileText size={20} className="text-[var(--gray-11)]" style={{ flexShrink: 0, marginTop: '2px' }} />
                      <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%" minWidth="0">
                        <Text weight="medium" style={{ wordBreak: 'break-all' }}>
                          {backup.fileName}
                        </Text>
                        <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} gap="1">
                          <Flex align="center" gap="1">
                            <Calendar size={16} className="text-[var(--gray-11)]" style={{ flexShrink: 0 }} />
                            <Text size="2" color="gray" style={{ wordBreak: 'break-all' }}>
                              {new Date(backup.created).toLocaleString()}
                            </Text>
                          </Flex>
                          <Text size="2" color="gray" className="hidden sm:inline">
                            •
                          </Text>
                          <Text size="2" color="gray">
                            {backup.sizeFormatted}
                          </Text>
                        </Flex>
                        {/* OneDrive Status */}
                        {onedriveStatusLoading ? (
                          <Flex align="center" gap="1" mt="1">
                            <NuggetSpinner size={12} />
                            <Text size="1" color="gray">
                              Checking OneDrive status...
                            </Text>
                          </Flex>
                        ) : uploadingFiles.has(backup.fileName) ? (
                          <Flex align="center" gap="1" mt="1">
                            <NuggetSpinner size={12} />
                            <Text size="1" className="text-[var(--accent-11)]">
                              Uploading to OneDrive...
                            </Text>
                          </Flex>
                        ) : backup.onedriveUploaded ? (
                          <Flex align="center" gap="1" mt="1">
                            <CheckCircle size={12} className="text-[var(--green-12)]" />
                            <Text size="1" className="text-[var(--green-12)]">
                              Synced to OneDrive
                            </Text>
                          </Flex>
                        ) : null}
                        <VerifiedLine run={runByFile.get(backup.fileName)} />
                      </Flex>
                    </Flex>

                    <Flex align="center" gap="2" flexShrink="0">
                      {/* OneDrive Upload Button - show only if OneDrive is connected and file not uploaded */}
                      {onedriveStatus?.configured && onedriveStatus?.connected && !backup.onedriveUploaded && (
                        <IconButton
                          onClick={() => handleUploadToOneDrive(backup.fileName)}
                          variant="soft"
                          title="Upload to OneDrive"
                          aria-label="Upload to OneDrive"
                          disabled={uploadingFiles.has(backup.fileName) || onedriveStatusLoading}
                        >
                          {uploadingFiles.has(backup.fileName) ? (
                            <NuggetSpinner size={20} />
                          ) : (
                            <Upload size={20} />
                          )}
                        </IconButton>
                      )}
                      <IconButton
                        onClick={() => void verifyFromServer(backup)}
                        variant="soft"
                        title="Verify"
                        aria-label="Verify this backup"
                        disabled={verifying || restoring}
                      >
                        <ShieldCheck size={20} />
                      </IconButton>
                      <IconButton
                        onClick={() => void restoreFromServer(backup)}
                        variant="soft"
                        color="orange"
                        title="Restore"
                        aria-label="Restore this backup"
                        disabled={restoring || verifying}
                      >
                        <RotateCcw size={20} />
                      </IconButton>
                      <IconButton
                        onClick={() => handleDownloadBackup(backup.fileName)}
                        variant="soft"
                        title="Download"
                        aria-label="Download backup"
                      >
                        <Download size={20} />
                      </IconButton>
                      <IconButton
                        onClick={() => handleDeleteBackup(backup.fileName)}
                        variant="soft"
                        color="red"
                        title="Delete"
                        aria-label="Delete backup"
                      >
                        <Trash2 size={20} />
                      </IconButton>
                    </Flex>
                  </Flex>
                </Card>
              ))}

              {/* Pagination Controls */}
              {backups.length > PAGE_SIZE && (
                <Flex justify="between" align="center" pt="3" className="border-t border-[var(--gray-4)]">
                  <Text size="2" color="gray">
                    Showing {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, backups.length)} of {backups.length} backups
                  </Text>
                  <Flex align="center" gap="2">
                    <IconButton
                      onClick={() => goToPage(currentPage - 1)}
                      variant="soft"
                      color="gray"
                      disabled={currentPage === 0}
                      title="Previous page"
                      aria-label="Previous page"
                    >
                      <ChevronLeft size={16} />
                    </IconButton>
                    <Text size="2" weight="medium" align="center" style={{ minWidth: '80px' }}>
                      Page {currentPage + 1} of {Math.ceil(backups.length / PAGE_SIZE)}
                    </Text>
                    <IconButton
                      onClick={() => goToPage(currentPage + 1)}
                      variant="soft"
                      color="gray"
                      disabled={(currentPage + 1) * PAGE_SIZE >= backups.length}
                      title="Next page"
                      aria-label="Next page"
                    >
                      <ChevronRight size={16} />
                    </IconButton>
                  </Flex>
                </Flex>
              )}
            </Flex>
          )}
        </Flex>
      </Card>

      {/* Every run, failures too, and each one's last verify */}
      <BackupRunsCard />

      {/* Confirmation Dialog */}
      <ConfirmationDialog {...dialogProps} />
      <ReauthDialog {...reauthDialogProps} />
      <BackupKeyPrompt {...promptProps} />
    </PageContainer>
  );
};

export default BackupPage;