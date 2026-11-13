import React, { useId, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { Badge, Box, Button, Callout, Card, Code, Dialog, Flex, IconButton, RadioGroup, Separator, Text, TextArea, TextField } from '@radix-ui/themes';
import { AlertTriangle, CheckCircle, Download, Key, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import {
  BACKUP_KEY_KINDS,
  BACKUP_KEY_KIND_LABELS,
  backupRecipientCreateSchema,
  vocabularyLabel,
  type BackupKeyKind,
  type BackupRecipient,
} from '@nuggets/shared';
import { addBackupKey, downloadBackupKey, markBackupKeyChecked, removeBackupKey } from '../../services/api';
import { backupKeysQueryKey, useBackupKeysQuery } from '../../hooks/queries';
import { isReauthCancelledError, useReauth } from '../../hooks/useReauth';
import { useConfirmation } from '../../hooks/useConfirmation';
import { useFormReset } from '../../hooks/useFormReset';
import {
  createDefaultBackupKeyForm,
  createDefaultMakeBackupKeyForm,
  type BackupKeyFormData,
  type MakeBackupKeyFormData,
} from '../../types/forms';
import { apiErrorMessage } from '../../utils/errors';
import {
  BackupKeyProblem,
  classicKeysWork,
  identitiesFromFile,
  identitiesFromPasted,
  keyFileName,
  makeKeyPair,
  recipientsOf,
  type MadeKeyPair,
} from '../../utils/ageKeys';
import { formatInstantDate } from '../../utils/dateUtils';
import { saveBlob } from '../../utils/saveBlob';
import { logger } from '../../utils/logger';
import ConfirmationDialog from '../ConfirmationDialog';
import ReauthDialog from '../ReauthDialog';
import FilePickerButton from '../forms/FilePickerButton';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from '../forms/FieldError';
import { NOT_A_PASSWORD } from './BackupKeyPrompt';

/** A key problem's own message, or the fallback: never a library's (it can repeat a key). */
const problemText = (error: unknown, fallback: string): string => (error instanceof BackupKeyProblem ? error.message : fallback);

/** A key file the user picked: what it holds, as public keys, or why it can't be read. */
async function recipientsInFile(file: File): Promise<string[]> {
  return recipientsOf(await identitiesFromFile(file));
}

/** Which kinds of key the browser makes with its WebCrypto (which a page over plain HTTP lacks). */
const NEEDS_WEBCRYPTO: Record<BackupRecipient['kind'], boolean> = { 'post-quantum': false, classic: true };

/** What the kind radio says beside the label: which to choose. */
const KIND_HINT: Record<BackupRecipient['kind'], string> = { 'post-quantum': ' (recommended)', classic: '' };

/**
 * The backup keys: the owner's age public keys, which every backup is encrypted to. The
 * private keys never reach the server, so it can't open the backups it makes. Make a key
 * pair here (the private key is offered as a file and asked for back, so what was saved is
 * known to open what was made), add a public key made with age-keygen, check a private key
 * file against the list, or remove a key. Adding and removing take step-up. Also the old
 * backup key, while the server has one: it opens the .enc backups made before.
 */
const BackupKeysCard: React.FC = () => {
  const qc = useQueryClient();
  const keysQuery = useBackupKeysQuery();
  const keys = keysQuery.data;
  const { withReauth, dialogProps: reauthDialogProps } = useReauth();
  const { confirmAsync, dialogProps: confirmDialogProps } = useConfirmation();
  const [dialog, setDialog] = useState<'make' | 'add' | 'check' | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: backupKeysQueryKey }), qc.invalidateQueries({ queryKey: ['backups', 'scheduler'] })]);

  const recipients = keys?.recipients ?? [];
  const full = keys ? recipients.length >= keys.maxRecipients : true;

  const handleRemove = async (recipient: BackupRecipient) => {
    const last = recipients.length === 1;
    const whenLast = keys?.legacyKey.exists
      ? 'It is the only backup key: until another is added, backups go back to the old backup key, which this server holds.'
      : 'It is the only backup key: no backup can be made until another is added.';
    const confirmed = await confirmAsync({
      title: `Remove the backup key “${recipient.label}”?`,
      message: last
        ? `${whenLast} Backups made to it still open with its private key.`
        : 'Backups from now on aren’t encrypted to it. Backups made to it before still open with its private key.',
      variant: 'warning',
      confirmText: 'Remove key',
      cancelText: 'Keep key',
    });
    if (!confirmed) return;
    try {
      setBusy(true);
      await withReauth(() => removeBackupKey(recipient.uuid));
      toast.success(`Removed the backup key “${recipient.label}”`);
      await refresh();
    } catch (error) {
      if (!isReauthCancelledError(error)) toast.error(apiErrorMessage(error, 'Couldn’t remove the backup key'));
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadOldKey = async () => {
    try {
      setBusy(true);
      saveBlob(await withReauth(() => downloadBackupKey()), 'nuggets-backup-key.txt');
      toast.success('Old backup key downloaded: keep it while you keep any .enc backup.');
      await refresh();
    } catch (error) {
      if (!isReauthCancelledError(error)) {
        logger.error({ err: error }, 'Failed to download the old backup key');
        toast.error(apiErrorMessage(error, 'Couldn’t download the old backup key'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card mb="6">
      <Flex direction="column" gap="4">
        <Flex align="center" gap="2">
          <Key size={24} className="text-[var(--accent-11)]" />
          <Text size="5" weight="bold">Backup keys</Text>
        </Flex>

        <Text size="2" color="gray">
          Every backup is encrypted to these public keys. Only their private keys open a backup, and those never reach the
          server: it can’t read the backups it makes. Keep each private key file somewhere safe and apart from the backups,
          such as a password manager, and keep a second key offline: losing one key then loses nothing, losing every one loses
          the backups.
        </Text>

        {keysQuery.isError && (
          <Callout.Root color="red">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>
              The backup keys couldn’t be loaded, so keys can’t be added and no backup can be made from this page. Reload the
              page to try again.
            </Callout.Text>
          </Callout.Root>
        )}
        {keys?.mode === 'none' && (
          <Callout.Root highContrast color="amber">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>No backup key yet: no backup can be made until you make one here or add your public key.</Callout.Text>
          </Callout.Root>
        )}
        {keys?.mode === 'legacy' && (
          <Callout.Root highContrast color="amber">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>
              Backups still use the old backup key, which this server holds. Set up a backup key: backups from then on open only
              with your private key.
            </Callout.Text>
          </Callout.Root>
        )}
        {keys && recipients.length === 1 && (
          <Text size="2" color="gray">Add a second key, kept offline, so that losing one key loses nothing.</Text>
        )}

        {recipients.length > 0 && (
          <Flex direction="column" gap="2" role="list" aria-label="Backup keys">
            {recipients.map((recipient) => (
              <Card key={recipient.uuid} role="listitem" className="[--card-background-color:var(--gray-2)]">
                <Flex direction={{ initial: 'column', sm: 'row' }} justify="between" align={{ sm: 'center' }} gap="3">
                  <Flex direction="column" gap="1" minWidth="0">
                    <Flex align="center" gap="2" wrap="wrap">
                      <Text weight="medium">{recipient.label}</Text>
                      <Badge color="gray">{vocabularyLabel(BACKUP_KEY_KIND_LABELS, recipient.kind)}</Badge>
                      {recipient.hardware && <Badge color="gray">hardware</Badge>}
                      {recipient.checkedAt ? (
                        <Badge color="green" highContrast>checked</Badge>
                      ) : (
                        <Badge color="amber" highContrast>not checked</Badge>
                      )}
                    </Flex>
                    <Text size="1" color="gray">
                      Fingerprint <Code variant="ghost">{recipient.fingerprint}</Code>
                      {' · '}added {formatInstantDate(recipient.createdAt)}
                      {recipient.createdBy ? ` by ${recipient.createdBy}` : ''}
                    </Text>
                  </Flex>
                  <IconButton
                    variant="soft"
                    color="red"
                    aria-label={`Remove the backup key ${recipient.label}`}
                    title="Remove"
                    disabled={busy}
                    onClick={() => void handleRemove(recipient)}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </Flex>
              </Card>
            ))}
          </Flex>
        )}

        <Flex gap="3" wrap="wrap">
          <Button onClick={() => setDialog('make')} disabled={full || busy} variant={recipients.length ? 'soft' : 'solid'}>
            <KeyRound size={16} />
            Make a key here
          </Button>
          <Button onClick={() => setDialog('add')} disabled={full || busy} variant="soft">
            <Plus size={16} />
            Add a public key
          </Button>
          <Button onClick={() => setDialog('check')} disabled={recipients.length === 0 || busy} variant="soft">
            <ShieldCheck size={16} />
            Check a key
          </Button>
        </Flex>
        {keys && full && <Text size="1" color="gray">A backup is encrypted to at most {keys.maxRecipients} keys: remove one to add another.</Text>}

        {keys?.signer && (
          <Text size="1" color="gray">
            This server signs its backups as <Code variant="ghost" className="break-all">{keys.signer}</Code>. A restore here takes
            only backups it signed; the restore command’s --signer trusts another signer.
          </Text>
        )}

        {keys?.legacyKey.exists && (
          <>
            <Separator size="4" />
            <Flex direction="column" gap="2">
              <Text weight="medium">Old backup key</Text>
              <Text size="2" color="gray">
                It opens the .enc backups made before backups were encrypted to your keys
                {keys.mode === 'legacy' ? ', and the ones made with it until you set up a backup key' : ''}. Download it and keep it
                for as long as you keep any of those, on OneDrive or elsewhere.
              </Text>
              {!keys.legacyKey.downloaded && (
                <Callout.Root color="red">
                  <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
                  <Callout.Text>You haven’t downloaded the old backup key. Without it, its backups can’t be restored elsewhere.</Callout.Text>
                </Callout.Root>
              )}
              <Flex>
                <Button variant="soft" onClick={() => void handleDownloadOldKey()} disabled={busy}>
                  <Download size={16} />
                  Download old key
                </Button>
              </Flex>
            </Flex>
          </>
        )}
      </Flex>

      <MakeKeyDialog
        open={dialog === 'make'}
        onClose={() => setDialog(null)}
        withReauth={withReauth}
        onSaved={refresh}
        lockedKind={recipients[0]?.kind ?? null}
      />
      <AddKeyDialog open={dialog === 'add'} onClose={() => setDialog(null)} withReauth={withReauth} onSaved={refresh} />
      <CheckKeyDialog open={dialog === 'check'} onClose={() => setDialog(null)} recipients={recipients} onChecked={refresh} />
      <ReauthDialog {...reauthDialogProps} />
      <ConfirmationDialog {...confirmDialogProps} />
    </Card>
  );
};

interface KeyDialogProps {
  open: boolean;
  onClose: () => void;
  withReauth: <T>(action: () => Promise<T>) => Promise<T>;
  onSaved: () => Promise<unknown>;
}

const makeKeySchema = z.object({
  label: backupRecipientCreateSchema.shape.label,
  kind: z.enum(BACKUP_KEY_KINDS),
});

/**
 * Make a key pair in the browser: the private key is offered as a file in age-keygen's
 * format, then asked for back, so the public key is sent only once what was saved is known
 * to open what was made. The private key stays in this dialog's memory until it closes.
 */
const MakeKeyDialog: React.FC<KeyDialogProps & { lockedKind: BackupKeyKind | null }> = ({ open, onClose, withReauth, onSaved, lockedKind }) => {
  const ids = { label: useId(), kind: useId(), kindHint: useId(), saved: useId(), savedFile: useId() };
  const [made, setMade] = useState<(MadeKeyPair & { label: string }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const classicWorks = classicKeysWork();
  // A server's keys are all of one kind: a new one must be the kind already there.
  const kindOpen = (kind: BackupKeyKind) => (lockedKind ? kind === lockedKind : !NEEDS_WEBCRYPTO[kind] || classicWorks);
  const defaults = (): MakeBackupKeyFormData => ({ ...createDefaultMakeBackupKeyForm(), ...(lockedKind ? { kind: lockedKind } : {}) });
  const { control, register, handleSubmit, reset, formState: { errors } } = useForm<MakeBackupKeyFormData>({
    defaultValues: defaults(),
    resolver: zodResolver(makeKeySchema) as never,
  });
  useFormReset(reset, defaults(), [open, lockedKind]);

  const close = () => {
    setMade(null);
    setProblem(null);
    onClose();
  };

  const offer = (pair: MadeKeyPair, label: string) =>
    saveBlob(new Blob([pair.fileText], { type: 'text/plain' }), keyFileName(label));

  const onMake = async (values: MakeBackupKeyFormData) => {
    try {
      setBusy(true);
      setProblem(null);
      const pair = await makeKeyPair(values.kind);
      setMade({ ...pair, label: values.label.trim() });
      offer(pair, values.label);
    } catch (error) {
      toast.error(problemText(error, 'The key pair couldn’t be made in this browser.'));
    } finally {
      setBusy(false);
    }
  };

  const onSavedFile = async (file: File) => {
    if (!made) return;
    try {
      setBusy(true);
      setProblem(null);
      const inFile = await recipientsInFile(file);
      if (!inFile.includes(made.recipient)) {
        setProblem('That file doesn’t hold the key just made. Choose the file you saved it to, or download it again.');
        return;
      }
      await withReauth(() => addBackupKey({ recipient: made.recipient, label: made.label, checked: true }));
      toast.success(`Backup key “${made.label}” added: backups from now on are encrypted to it.`);
      await onSaved();
      close();
    } catch (error) {
      if (isReauthCancelledError(error)) return;
      setProblem(error instanceof BackupKeyProblem ? error.message : apiErrorMessage(error, 'Couldn’t add the backup key'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Content maxWidth="560px">
        <Dialog.Title>Make a backup key</Dialog.Title>
        {!made ? (
          <form onSubmit={handleSubmit(onMake)} noValidate>
            <Flex direction="column" gap="4">
              <Dialog.Description size="2">
                The key pair is made in this browser. Its private key is offered as a file to save, and never sent anywhere; only
                the public key goes to the server, once you have shown the page the saved file.
              </Dialog.Description>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor={ids.label} size="2" weight="medium">Name</Text>
                <TextField.Root id={ids.label} {...register('label')} placeholder="Where you keep it, such as Password manager" {...fieldErrorProps(ids.label, errors.label)} />
                <FieldError fieldId={ids.label} message={errors.label?.message} />
              </Flex>
              <Flex direction="column" gap="2">
                <Text as="div" id={ids.kind} size="2" weight="medium">Kind</Text>
                <Controller
                  control={control}
                  name="kind"
                  render={({ field }) => (
                    <RadioGroup.Root value={field.value} onValueChange={field.onChange} aria-labelledby={ids.kind} aria-describedby={ids.kindHint}>
                      {BACKUP_KEY_KINDS.map((kind) => (
                        <RadioGroup.Item key={kind} value={kind} disabled={!kindOpen(kind)}>
                          {BACKUP_KEY_KIND_LABELS[kind]}
                          {KIND_HINT[kind]}
                        </RadioGroup.Item>
                      ))}
                    </RadioGroup.Root>
                  )}
                />
                <Text id={ids.kindHint} size="1" color="gray">
                  {lockedKind
                    ? `This server’s backup keys are ${vocabularyLabel(BACKUP_KEY_KIND_LABELS, lockedKind).toLowerCase()}, so a new one must be too: age won’t mix the kinds. `
                    : ''}
                  A post-quantum key keeps backups safe from a future quantum computer, which matters for files kept for years.
                  Opening one with the age command needs age 1.3 or later; a classic key opens with older age too (Ubuntu 24.04’s
                  1.1).
                  {!classicWorks && (lockedKind ? NEEDS_WEBCRYPTO[lockedKind] : true)
                    ? lockedKind
                      ? ' This page isn’t served over HTTPS, so it can’t make a classic key: open Nuggets over HTTPS, or make the key with age-keygen and add its public key.'
                      : ' A classic key can’t be made here: this page isn’t served over HTTPS.'
                    : ''}
                </Text>
              </Flex>
              <Flex gap="3" justify="end">
                <Button type="button" variant="soft" color="gray" onClick={close}>Cancel</Button>
                <Button type="submit" loading={busy} disabled={!BACKUP_KEY_KINDS.some(kindOpen)}>
                  <KeyRound size={16} />
                  Make the key
                </Button>
              </Flex>
            </Flex>
          </form>
        ) : (
          <Flex direction="column" gap="4">
            <Dialog.Description size="2">
              Your browser has offered the private key as a file ({keyFileName(made.label)}). Save it where you keep secrets: a
              password manager, or an encrypted drive. Anyone with it can open your backups, and without it (or another backup
              key) they can’t be restored.
            </Dialog.Description>
            <Text id={ids.saved} size="2">
              Now choose the file you saved, so the page can check that it opens what was made. Only then is the public key sent.
            </Text>
            <Flex gap="3" wrap="wrap" justify="end">
              <Button variant="soft" color="gray" onClick={close}>Cancel</Button>
              <Button variant="soft" onClick={() => offer(made, made.label)}>
                <Download size={16} />
                Download again
              </Button>
              <FilePickerButton
                id={ids.savedFile}
                accept=".txt,.key,text/plain"
                onFiles={([file]) => file && void onSavedFile(file)}
                aria-describedby={fieldErrorDescribedBy(ids.savedFile, problem, ids.saved)}
                loading={busy}
                variant="solid"
              >
                <CheckCircle size={16} />
                Choose the saved file
              </FilePickerButton>
            </Flex>
            <FieldError fieldId={ids.savedFile} message={problem} />
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

/** Add a public key made elsewhere (age-keygen -pq, then age-keygen -y for the public key). Shown as not checked until checked. */
const AddKeyDialog: React.FC<KeyDialogProps> = ({ open, onClose, withReauth, onSaved }) => {
  const ids = { label: useId(), recipient: useId(), hint: useId() };
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<BackupKeyFormData>({
    defaultValues: createDefaultBackupKeyForm(),
    resolver: zodResolver(backupRecipientCreateSchema.pick({ label: true, recipient: true })) as never,
  });
  useFormReset(reset, createDefaultBackupKeyForm(), [open]);

  const onSubmit = async (values: BackupKeyFormData) => {
    try {
      setBusy(true);
      const recipient = values.recipient.trim();
      await withReauth(() => addBackupKey({ recipient, label: values.label.trim(), checked: false }));
      toast.success(`Backup key “${values.label.trim()}” added. Check it with its private key file when you can.`);
      await onSaved();
      onClose();
    } catch (error) {
      if (!isReauthCancelledError(error)) setError('recipient', { message: apiErrorMessage(error, 'Couldn’t add the backup key') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="560px">
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <Flex direction="column" gap="4">
            <Box>
              <Dialog.Title>Add a public key</Dialog.Title>
              <Dialog.Description size="2">
                Paste the public key of a key pair you made with age (age-keygen -pq -o key.txt makes one; age-keygen -y key.txt
                prints its public key). Never paste a private key here.
              </Dialog.Description>
            </Box>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={ids.label} size="2" weight="medium">Name</Text>
              <TextField.Root id={ids.label} {...register('label')} placeholder="Where you keep it, such as Offline spare" {...fieldErrorProps(ids.label, errors.label)} />
              <FieldError fieldId={ids.label} message={errors.label?.message} />
            </Flex>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={ids.recipient} size="2" weight="medium">Public key</Text>
              <TextArea
                id={ids.recipient}
                rows={5}
                spellCheck={false}
                autoComplete="off"
                placeholder="age1pq1…"
                className="font-mono break-all"
                {...register('recipient')}
                {...fieldErrorProps(ids.recipient, errors.recipient, ids.hint)}
              />
              <FieldError fieldId={ids.recipient} message={errors.recipient?.message} />
              <Text id={ids.hint} size="1" color="gray">
                It shows as not checked until Check a key has matched its private key file. A hardware key needs age 1.3’s
                age1tag1… or age1tagpq1… form.
              </Text>
            </Flex>
            <Flex gap="3" justify="end">
              <Button type="button" variant="soft" color="gray" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={busy}>
                <Plus size={16} />
                Add key
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

const checkPasteSchema = z.object({ pasted: z.string().trim().min(1, { error: 'Paste the private key, or choose a key file above' }) });

/**
 * Check a private key file against the backup keys, entirely in the browser: the public key
 * it gives is matched with the list. A match is marked checked; the private key goes nowhere.
 */
const CheckKeyDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  recipients: readonly BackupRecipient[];
  onChecked: () => Promise<unknown>;
}> = ({ open, onClose, recipients, onChecked }) => {
  const ids = { file: useId(), pasted: useId(), hint: useId() };
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<{ pasted: string }>({
    defaultValues: { pasted: '' },
    resolver: zodResolver(checkPasteSchema),
  });
  useFormReset(reset, { pasted: '' }, [open]);

  const close = () => {
    reset({ pasted: '' });
    setResult(null);
    setFileProblem(null);
    onClose();
  };

  /** Match the keys `read` gives with the list; a problem reading them goes to `onProblem`. */
  const check = async (read: () => Promise<string[]>, onProblem: (message: string) => void) => {
    try {
      setBusy(true);
      setResult(null);
      setFileProblem(null);
      const publicKeys = await read();
      const matched = recipients.filter((r) => publicKeys.includes(r.recipient));
      if (matched.length === 0) {
        setResult({ ok: false, text: 'That key matches none of the backup keys: backups made from now on won’t open with it.' });
        return;
      }
      for (const recipient of matched) if (!recipient.checkedAt) await markBackupKeyChecked(recipient.uuid);
      await onChecked();
      reset({ pasted: '' });
      setResult({ ok: true, text: `That key matches the backup key ${matched.map((r) => `“${r.label}”`).join(' and ')}: it opens the backups made to it.` });
    } catch (error) {
      onProblem(problemText(error, apiErrorMessage(error, 'The key couldn’t be checked')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && close()}>
      <Dialog.Content maxWidth="560px">
        <Flex direction="column" gap="4">
          <Box>
            <Dialog.Title>Check a key</Dialog.Title>
            <Dialog.Description size="2">
              <span id={ids.hint}>
                Choose a private key file, or paste the key, to see which backup key it is. It is checked in this browser and
                never sent anywhere. A hardware key can’t be checked here: to know it works, decrypt a recent backup with it
                using age and its plugin on your own computer. The page shows it as checked once the restore command’s
                --decrypted verify has opened a backup made to it alone.
              </span>
            </Dialog.Description>
          </Box>
          <Flex direction="column" gap="1" align="start">
            <FilePickerButton
              id={ids.file}
              accept=".txt,.key,text/plain"
              onFiles={([file]) => file && void check(() => recipientsInFile(file), setFileProblem)}
              aria-describedby={fieldErrorDescribedBy(ids.file, fileProblem, ids.hint)}
              loading={busy}
            >
              <KeyRound size={16} />
              Choose a key file
            </FilePickerButton>
            <FieldError fieldId={ids.file} message={fileProblem} />
          </Flex>
          <form
            noValidate
            onSubmit={handleSubmit(({ pasted }) =>
              check(async () => recipientsOf(identitiesFromPasted(pasted)), (message) => setError('pasted', { message }, { shouldFocus: true }))
            )}
          >
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={ids.pasted} size="2" weight="medium">Or paste the private key</Text>
              <Flex gap="2" direction={{ initial: 'column', sm: 'row' }}>
                <Box flexGrow="1">
                  <TextField.Root
                    id={ids.pasted}
                    type="password"
                    placeholder="AGE-SECRET-KEY-…"
                    {...NOT_A_PASSWORD}
                    {...register('pasted')}
                    {...fieldErrorProps(ids.pasted, errors.pasted, ids.hint)}
                  />
                </Box>
                <Button type="submit" variant="soft" loading={busy}>Check</Button>
              </Flex>
              <FieldError fieldId={ids.pasted} message={errors.pasted?.message} />
            </Flex>
          </form>
          {result && (
            <Text size="2" role="status" {...(result.ok ? { color: 'green' as const, highContrast: true } : { color: 'red' as const })}>
              {result.text}
            </Text>
          )}
          <Flex justify="end">
            <Button variant="soft" color="gray" onClick={close}>Done</Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default BackupKeysCard;
