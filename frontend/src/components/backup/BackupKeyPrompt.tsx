import React, { useCallback, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Box, Button, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import { KeyRound } from 'lucide-react';
import { AGE_KEY_IN_OLD_KEY_FIELD, isAgePrivateKeyText } from '@nuggets/shared';
import type { BackupKeyAnswer } from '../../services/api/backup';
import { useFormReset } from '../../hooks/useFormReset';
import { apiErrorMessage } from '../../utils/errors';
import { BackupKeyProblem, fileKeyFor, identitiesFromFile, identitiesFromPasted } from '../../utils/ageKeys';
import FilePickerButton from '../forms/FilePickerButton';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from '../forms/FieldError';

/** What the prompt is for: a backup's format, its name, and how to get its age header. */
export interface BackupKeyRequest {
  format: 'age' | 'legacy';
  fileName: string;
  action: 'restore' | 'verify';
  /** The backup's age header: from the chosen file, or from the server. */
  header: () => Promise<Uint8Array>;
}

interface PromptState extends BackupKeyRequest {
  resolve: (answer: BackupKeyAnswer | null) => void;
}

export interface BackupKeyPromptProps {
  state: PromptState | null;
  onClose: () => void;
}

/**
 * Asks for what opens a backup before a restore or a verify: `askForKey(request)` resolves
 * with the request's keys, or null when the prompt is closed. Render
 * `<BackupKeyPrompt {...promptProps} />`.
 *
 * - An age backup: the private key of one of its backup keys, from a key file or pasted.
 *   It stays in the browser: the prompt opens the backup's header with it and resolves with
 *   the file key only, and a wrong key is said here, before anything is uploaded.
 * - An older .enc one: the old backup key, which may be left empty for the server's own. An
 *   age private key typed there is refused, so it can't be sent as one.
 */
export function useBackupKeyPrompt() {
  const [state, setState] = useState<PromptState | null>(null);
  const pending = useRef<PromptState | null>(null);

  const askForKey = useCallback(
    (request: BackupKeyRequest) =>
      new Promise<BackupKeyAnswer | null>((resolve) => {
        pending.current?.resolve(null);
        const next = { ...request, resolve };
        pending.current = next;
        setState(next);
      }),
    []
  );

  const onClose = useCallback(() => {
    pending.current = null;
    setState(null);
  }, []);

  return { askForKey, promptProps: { state, onClose } satisfies BackupKeyPromptProps };
}

const pasteSchema = z.object({ pasted: z.string().trim().min(1, { error: 'Paste the private key, or choose the key file above' }) });
const oldKeySchema = z.object({ oldKey: z.string().refine((key) => !isAgePrivateKeyText(key), { error: AGE_KEY_IN_OLD_KEY_FIELD }) });

/**
 * Attributes that ask password managers to leave a field alone: it takes a private key for a
 * moment, not a password to save for this site.
 */
export const NOT_A_PASSWORD = { 'data-1p-ignore': '', 'data-lpignore': 'true', 'data-bwignore': 'true', autoComplete: 'off' } as const;

/** The prompt's message for a failure: a key problem's own, an API refusal's, never a library's. */
const problemOf = (error: unknown) =>
  error instanceof BackupKeyProblem ? error.message : apiErrorMessage(error, "The backup's header couldn't be fetched. Try again.");

const BackupKeyPrompt: React.FC<BackupKeyPromptProps> = ({ state, onClose }) => {
  const ids = { file: useId(), hint: useId(), pasted: useId(), oldKey: useId(), oldKeyHint: useId() };
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pasteForm = useForm<{ pasted: string }>({ defaultValues: { pasted: '' }, resolver: zodResolver(pasteSchema) });
  const oldKeyForm = useForm<{ oldKey: string }>({ defaultValues: { oldKey: '' }, resolver: zodResolver(oldKeySchema) });
  // A new prompt starts over: nothing typed for the last one shows.
  useFormReset(pasteForm.reset, { pasted: '' }, [state]);
  useFormReset(oldKeyForm.reset, { oldKey: '' }, [state]);
  const [shownFor, setShownFor] = useState<PromptState | null>(state);
  if (state !== shownFor) {
    setShownFor(state);
    setFileProblem(null);
    setBusy(false);
  }

  const finish = (answer: BackupKeyAnswer | null) => {
    pasteForm.reset({ pasted: '' });
    oldKeyForm.reset({ oldKey: '' });
    state?.resolve(answer);
    onClose();
  };

  /** Open the header with the private keys `read` gives; the keys are dropped either way. */
  const unlock = async (read: () => Promise<string[]>, onProblem: (message: string) => void) => {
    if (!state) return;
    try {
      setBusy(true);
      setFileProblem(null);
      const fileKey = await fileKeyFor(await state.header(), await read());
      finish({ fileKey });
    } catch (error) {
      onProblem(problemOf(error));
    } finally {
      setBusy(false);
    }
  };

  const pasteError = pasteForm.formState.errors.pasted?.message;
  const oldKeyError = oldKeyForm.formState.errors.oldKey?.message;
  const verb = state?.action === 'verify' ? 'Verify' : 'Restore';

  return (
    <Dialog.Root open={state !== null} onOpenChange={(next) => !next && finish(null)}>
      <Dialog.Content maxWidth="560px">
        {state?.format === 'legacy' ? (
          <form
            noValidate
            onSubmit={oldKeyForm.handleSubmit(({ oldKey }) => finish(oldKey.trim() ? { encryptionKey: oldKey.trim() } : {}))}
          >
            <Flex direction="column" gap="4">
              <Box>
                <Dialog.Title>{verb} an older backup</Dialog.Title>
                <Dialog.Description size="2">
                  {state.fileName} is an older .enc backup, encrypted with the old backup key rather than your backup keys.
                </Dialog.Description>
              </Box>
              <Flex direction="column" gap="1">
                <Text as="label" htmlFor={ids.oldKey} size="2" weight="medium">Old backup key (optional)</Text>
                <TextField.Root
                  id={ids.oldKey}
                  type="password"
                  {...NOT_A_PASSWORD}
                  {...oldKeyForm.register('oldKey')}
                  {...fieldErrorProps(ids.oldKey, oldKeyError, ids.oldKeyHint)}
                />
                <FieldError fieldId={ids.oldKey} message={oldKeyError} />
                <Text id={ids.oldKeyHint} size="1" color="gray">
                  Leave it empty for a backup made with this server’s old key; otherwise paste the key it was made with. The app
                  restores only backups this server made: another server’s goes through the restore command.
                </Text>
              </Flex>
              <Flex gap="3" justify="end">
                <Button type="button" variant="soft" color="gray" onClick={() => finish(null)}>Cancel</Button>
                <Button type="submit">Continue</Button>
              </Flex>
            </Flex>
          </form>
        ) : (
          <Flex direction="column" gap="4">
            <Box>
              <Dialog.Title>{verb}: your backup key</Dialog.Title>
              <Dialog.Description size="2">
                <span id={ids.hint}>
                  {state?.fileName} opens with the private key of one of the backup keys it was made for. Choose the key file,
                  or paste the key. It stays in this browser: the page opens the backup’s header with it and sends the server
                  only the key of this one backup.
                </span>
              </Dialog.Description>
            </Box>
            <Flex direction="column" gap="1" align="start">
              <FilePickerButton
                id={ids.file}
                accept=".txt,.key,text/plain"
                onFiles={([file]) => file && void unlock(() => identitiesFromFile(file), setFileProblem)}
                aria-describedby={fieldErrorDescribedBy(ids.file, fileProblem, ids.hint)}
                loading={busy}
                variant="solid"
              >
                <KeyRound size={16} />
                Choose key file
              </FilePickerButton>
              <FieldError fieldId={ids.file} message={fileProblem} />
            </Flex>
            <form
              noValidate
              onSubmit={pasteForm.handleSubmit(({ pasted }) =>
                unlock(async () => identitiesFromPasted(pasted), (message) => pasteForm.setError('pasted', { message }, { shouldFocus: true }))
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
                      {...pasteForm.register('pasted')}
                      {...fieldErrorProps(ids.pasted, pasteError)}
                    />
                  </Box>
                  <Button type="submit" variant="soft" loading={busy}>Open the backup</Button>
                </Flex>
                <FieldError fieldId={ids.pasted} message={pasteError} />
              </Flex>
            </form>
            <Text size="1" color="gray">
              A hardware key, or a key you’d rather not use in a browser: decrypt the backup on your own computer
              (age -d) and use the restore command’s --decrypted.
            </Text>
            <Flex justify="end">
              <Button variant="soft" color="gray" onClick={() => finish(null)}>Cancel</Button>
            </Flex>
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default BackupKeyPrompt;
