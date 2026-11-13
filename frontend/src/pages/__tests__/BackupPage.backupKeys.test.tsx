import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Encrypter, generateHybridIdentity, identityToRecipient } from 'age-encryption';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiError, mockApi, type ApiRequest } from '../../test/apiServer';
import {
  backupKeys,
  backupList,
  backupRecipient,
  backupStarted,
  backupStatus,
  oneDriveNotConfigured,
  type BackupRecipientWire,
} from '../../test/fixtures';
import type { BackupCreateStatus } from '../../services/api/backup';
import { logger } from '../../utils/logger';
import BackupPage from '../BackupPage';

/**
 * The Backup page's backup keys, through the network edge (only `fetch` is stubbed) and
 * the real age library: making a key pair in the browser, adding a public key, checking a
 * private key, and restoring an age backup with the private key, which never leaves the
 * page: no request body, rendered text, toast or log line ever holds a private key.
 */

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ default: toast, toast }));
// The OneDrive panel has its own requests and isn't what these tests are about.
vi.mock('../../components/OneDriveSync', () => ({ default: () => null }));

/** A private key itself (the page's help text says "AGE-SECRET-KEY-…", which isn't one). */
const PRIVATE_KEY = /AGE-SECRET-KEY-(PQ-)?1[0-9A-Z]{20,}/;

const routes = (keys: ReturnType<typeof backupKeys>, extra: Record<string, unknown> = {}) => ({
  'GET /backup/recipients': keys,
  'GET /backup/list': backupList(),
  'GET /backup/settings': { settings: {} },
  'GET /backup/status': backupStatus(),
  'GET /onedrive/status': oneDriveNotConfigured(),
  'GET /admin/deployment-settings': { settings: { application_timezone: 'UTC' } },
  'GET /settings/timezones': [{ value: 'UTC', label: 'UTC', offset: 'UTC+0' }],
  'POST /backup/check-onedrive-status': { success: true, status: {} },
  'POST /backup/create': { status: 202, body: backupStarted() },
  'GET /backup/create-status': { status: 'completed', fileName: 'nuggets-backup.tar.age' } satisfies BackupCreateStatus,
  ...extra,
});

const renderPage = () => renderWithProviders(<Theme><BackupPage /></Theme>, { route: '/settings/backup' });

/** Blobs the page hands the browser to save, by file name. */
let saved: Map<string, Blob>;
let api: ReturnType<typeof mockApi>;
const logged: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  saved = new Map();
  logged.length = 0;
  let next: Blob | null = null;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    next = blob;
    return 'blob:saved';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (next) saved.set(this.download, next);
  });
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => void logged.push(args));
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const textOf = (blob: Blob) =>
  new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });

/** What leaves the page or shows on it: request bodies (form fields too), the page's text, toasts and log lines. */
function everythingSeen(requests: ApiRequest[]): string {
  const bodies = requests.map((r) => (r.body instanceof FormData ? JSON.stringify([...r.body.entries()].map(([k, v]) => [k, String(v)])) : JSON.stringify(r.body ?? null)));
  return [
    ...bodies,
    // The HTML, attributes included: a controlled field would put a pasted key in `value`.
    document.body.outerHTML,
    JSON.stringify(toast.mock.calls),
    JSON.stringify(toast.success.mock.calls),
    JSON.stringify(toast.error.mock.calls),
    JSON.stringify(logged, (_key, value: unknown) => (value instanceof Error ? value.message : value)),
  ].join('\n');
}

/** Every aria-describedby id in the document names an element that is there. */
function danglingDescriptions(): string[] {
  return [...document.querySelectorAll('[aria-describedby]')].flatMap((el) =>
    (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((id) => id && !document.getElementById(id))
  );
}

/** The file input inside an element (FilePickerButton's hidden one). */
const fileInputIn = (element: HTMLElement) => element.querySelector<HTMLInputElement>('input[type="file"]')!;

describe('the Backup page without a backup key', () => {
  it('says so, and starts no backup', async () => {
    api = mockApi(routes(backupKeys()));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/No backup key yet/)).toBeInTheDocument();
    expect(await screen.findByText('Make or add a backup key above before creating a backup.')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create Backup' });
    expect(create).toBeDisabled();
    await user.click(create);
    expect(api.calls('POST /backup/create')).toHaveLength(0);
  });

  it('says when backups still use the old key, and offers the old key with step-up', async () => {
    api = mockApi(
      routes(backupKeys({ mode: 'legacy', legacyKey: { exists: true, downloaded: false } }), {
        'GET /backup/key/download': apiError(403, 'Confirm your password or passkey to continue', 'REAUTH_REQUIRED'),
      })
    );
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/Backups still use the old backup key, which this server holds/)).toBeInTheDocument();
    expect(screen.getByText(/You haven’t downloaded the old backup key/)).toBeInTheDocument();
    // Backups can still be made, with the old key, until a backup key is set up.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create Backup' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Download old key' }));
    // The server asks for step-up first: the confirmation opens.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(saved.size).toBe(0);
  });
});

describe('making a backup key in the browser', () => {
  it('offers the private key as a file, asks for it back, and sends only the public key', async () => {
    let added: BackupRecipientWire | null = null;
    api = mockApi(
      routes(backupKeys(), {
        'POST /backup/recipients': (req: ApiRequest) => {
          const body = req.body as { recipient: string; label: string; checked: boolean };
          added = backupRecipient({ recipient: body.recipient, label: body.label, checkedAt: '2026-11-13T12:00:00.000Z' });
          return { status: 201, body: { success: true, recipient: added } };
        },
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Make a key here' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Post-quantum (recommended)' })).toBeChecked();
    expect(danglingDescriptions()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Make the key' }));

    await waitFor(() => expect(saved.has('nuggets-backup-key-password-manager.txt')).toBe(true));
    const fileText = await textOf(saved.get('nuggets-backup-key-password-manager.txt')!);
    const lines = fileText.trim().split('\n');
    // age-keygen's format: two comments, then the key.
    expect(lines[0]).toMatch(/^# created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(lines[1]).toMatch(/^# public key: age1pq1[0-9a-z]{1952}$/);
    expect(lines[2]).toMatch(/^AGE-SECRET-KEY-PQ-1[0-9A-Z]+$/);
    // What the checks below look for, so they can fail.
    expect(lines[2]).toMatch(PRIVATE_KEY);
    expect(await identityToRecipient(lines[2])).toBe(lines[1].slice('# public key: '.length));
    expect(api.calls('POST /backup/recipients')).toHaveLength(0);

    // Another key's file is refused: nothing is sent.
    const other = await generateHybridIdentity();
    await user.upload(fileInputIn(await screen.findByRole('dialog')), new File([`${other}\n`], 'other.txt', { type: 'text/plain' }));
    expect(await screen.findByText(/doesn’t hold the key just made/)).toBeInTheDocument();
    expect(api.calls('POST /backup/recipients')).toHaveLength(0);

    // The file saved: the public key goes, checked.
    await user.upload(fileInputIn(await screen.findByRole('dialog')), new File([fileText], 'saved.txt', { type: 'text/plain' }));
    await waitFor(() => expect(api.calls('POST /backup/recipients')).toHaveLength(1));
    expect(api.calls('POST /backup/recipients')[0].body).toEqual({
      recipient: lines[1].slice('# public key: '.length),
      label: 'Password manager',
      checked: true,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Backup key “Password manager” added/)));
    expect(added).not.toBeNull();
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  }, 30_000);
});

describe('making a key on a server whose keys are classic', () => {
  it('makes a classic one: the post-quantum kind is not offered', async () => {
    api = mockApi(routes(backupKeys({ recipients: [backupRecipient({ kind: 'classic', recipient: `age1${'q'.repeat(58)}` })] })));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Make a key here' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'Classic' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Post-quantum (recommended)' })).toBeDisabled();
    expect(within(dialog).getByText(/This server’s backup keys are classic, so a new one must be too/)).toBeInTheDocument();
  });
});

describe('adding a public key', () => {
  it('sends it unchecked, and refuses a private key before anything is sent', async () => {
    const identity = await generateHybridIdentity();
    const recipient = await identityToRecipient(identity);
    api = mockApi(
      routes(backupKeys({ recipients: [backupRecipient()] }), {
        'POST /backup/recipients': { status: 201, body: { success: true, recipient: backupRecipient({ uuid: '019a6f00-0000-7000-8000-000000000002', recipient, checkedAt: null, label: 'Offline spare' }) } },
      })
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a public key' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Offline spare');
    const field = within(dialog).getByLabelText('Public key');
    await user.click(field);
    await user.paste(identity);
    await user.click(within(dialog).getByRole('button', { name: 'Add key' }));
    expect(await within(dialog).findByText(/That is a private key/)).toBeInTheDocument();
    expect(api.calls('POST /backup/recipients')).toHaveLength(0);

    await user.clear(field);
    await user.click(field);
    await user.paste(recipient);
    await user.click(within(dialog).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(api.calls('POST /backup/recipients')).toHaveLength(1));
    expect(api.calls('POST /backup/recipients')[0].body).toEqual({ recipient, label: 'Offline spare', checked: false });
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  }, 30_000);
});

describe('checking a key', () => {
  it('matches a private key file with the list in the browser, and marks the key checked', async () => {
    const identity = await generateHybridIdentity();
    const listed = backupRecipient({ recipient: await identityToRecipient(identity), checkedAt: null, label: 'Pasted key' });
    api = mockApi(
      routes(backupKeys({ recipients: [listed, backupRecipient({ uuid: '019a6f00-0000-7000-8000-000000000009', label: 'Spare' })] }), {
        'POST /backup/recipients/:uuid/checked': { success: true, recipient: { ...listed, checkedAt: '2026-11-13T13:00:00.000Z' } },
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    expect(await screen.findByText('not checked')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check a key' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(fileInputIn(dialog), new File([`# a comment\n${identity}\n`], 'key.txt', { type: 'text/plain' }));
    expect(await within(dialog).findByText(/matches the backup key “Pasted key”/)).toBeInTheDocument();
    expect(api.calls('POST /backup/recipients/:uuid/checked').map((r) => r.params.uuid)).toEqual([listed.uuid]);

    // A key of none of them, and a mistyped one: said so, never repeated.
    await user.upload(fileInputIn(dialog), new File([`${await generateHybridIdentity()}\n`], 'other.txt', { type: 'text/plain' }));
    expect(await within(dialog).findByText(/matches none of the backup keys/)).toBeInTheDocument();
    const typo = `${identity.slice(0, 30)}${identity[30] === 'Q' ? 'P' : 'Q'}${identity.slice(31)}`;
    await user.upload(fileInputIn(dialog), new File([`${typo}\n`], 'typo.txt', { type: 'text/plain' }));
    expect(await within(dialog).findByText(/isn't an age private key/)).toBeInTheDocument();
    expect(api.calls('POST /backup/recipients/:uuid/checked')).toHaveLength(1);
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  }, 30_000);
});

describe('restoring an older .enc backup', () => {
  it('refuses an age private key typed as the old key, and sends nothing', async () => {
    const identity = await generateHybridIdentity();
    api = mockApi(
      routes(backupKeys({ recipients: [backupRecipient()] }), {
        'POST /backup/verify': { status: 202, body: backupStarted('Verify started') },
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const restoreCard = (await screen.findByRole('button', { name: 'Choose backup file' })).closest<HTMLElement>('.rt-Card')!;
    await user.upload(fileInputIn(restoreCard), new File([new Uint8Array([0x02, 1, 2, 3])], 'nuggets_backup_20250101_000000.enc'));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    const prompt = await screen.findByRole('dialog');
    const field = within(prompt).getByLabelText('Old backup key (optional)');
    await user.click(field);
    await user.paste(identity);
    await user.click(within(prompt).getByRole('button', { name: 'Continue' }));
    expect(await within(prompt).findByText(/That is an age private key, which stays in your browser/)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls('POST /backup/verify')).toHaveLength(0);
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  });
});

describe('restoring an age backup', () => {
  async function ageBackup(identity: string) {
    const encrypter = new Encrypter();
    encrypter.addRecipient(await identityToRecipient(identity));
    const file = await encrypter.encrypt('a bundle, as far as this test is concerned');
    const text = new TextDecoder('latin1').decode(file);
    const end = text.indexOf('\n', text.indexOf('\n--- ') + 1) + 1;
    return { file, header: file.slice(0, end) };
  }

  const listed = {
    fileName: 'nuggets_backup_20261101_030000_000.tar.age',
    size: 1,
    sizeFormatted: '1 B',
    created: '2026-11-01T03:00:00.000Z',
    onedriveUploaded: false,
    format: 'age' as const,
  };

  it('opens the header with the private key in the browser, and sends the server only the file key', async () => {
    const identity = await generateHybridIdentity();
    const { header } = await ageBackup(identity);
    api = mockApi(
      routes(backupKeys({ recipients: [backupRecipient()] }), {
        'GET /backup/list': backupList([listed]),
        'GET /backup/:fileName/header': header,
        'POST /backup/restore/:fileName': { status: 202, body: backupStarted('Restore started') },
        'GET /backup/restore-status': {
          status: 'failed',
          databaseChanged: false,
          error: 'This backup was stopped for the test',
        },
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Restore this backup' }));
    let prompt = await screen.findByRole('dialog');
    expect(within(prompt).getByText(/opens with the private key of one of the backup keys/)).toBeInTheDocument();

    // A wrong key is said here, and nothing is sent.
    await user.upload(fileInputIn(prompt), new File([`${await generateHybridIdentity()}\n`], 'wrong.txt', { type: 'text/plain' }));
    expect(await within(prompt).findByText(/doesn't open this backup/)).toBeInTheDocument();
    expect(api.calls('POST /backup/restore/:fileName')).toHaveLength(0);

    prompt = await screen.findByRole('dialog');
    await user.upload(fileInputIn(prompt), new File([`# key\n${identity}\n`], 'key.txt', { type: 'text/plain' }));
    // Then the confirmation, then the restore, with the file key.
    await user.click(await screen.findByRole('button', { name: 'Restore Database' }));
    await waitFor(() => expect(api.calls('POST /backup/restore/:fileName')).toHaveLength(1));
    const body = api.calls('POST /backup/restore/:fileName')[0].body as Record<string, string>;
    expect(Object.keys(body)).toEqual(['fileKey']);
    expect(body.fileKey).toMatch(/^[A-Za-z0-9+/]{21}[AQgw]==$/);
    expect(api.calls('GET /backup/:fileName/header').map((r) => r.params.fileName)).toEqual([listed.fileName, listed.fileName]);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/stopped for the test/)), { timeout: 6000 });
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  }, 30_000);

  it('verifies an uploaded backup with its file key, from the header read in the browser', async () => {
    const identity = await generateHybridIdentity();
    const { file } = await ageBackup(identity);
    api = mockApi(
      routes(backupKeys({ recipients: [backupRecipient()] }), {
        'POST /backup/verify': { status: 202, body: backupStarted('Verify started') },
        'GET /backup/verify-status': {
          status: 'completed',
          backupId: 'nuggets_backup_20261101_030000_000',
          backupCreatedAt: '2026-11-01T03:00:00.000Z',
          rowCounts: { tenants: 1 },
        },
      })
    );
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    const restoreCard = (await screen.findByRole('button', { name: 'Choose backup file' })).closest<HTMLElement>('.rt-Card')!;
    await user.upload(fileInputIn(restoreCard), new File([new Uint8Array(file)], 'nuggets_backup_20261101_030000_000.tar.age'));
    await user.click(screen.getByRole('button', { name: 'Verify' }));
    const prompt = await screen.findByRole('dialog');
    expect(danglingDescriptions()).toEqual([]);
    const field = within(prompt).getByLabelText('Or paste the private key');
    // Empty: refused, with the button still there to press, and the error tied to the field.
    await user.click(within(prompt).getByRole('button', { name: 'Open the backup' }));
    expect(await within(prompt).findByText(/Paste the private key, or choose the key file/)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toBeTruthy();
    // A whole key file pasted into the one-line field loses its line breaks: the key is still found.
    await user.click(field);
    await user.paste(`# created: 2026-11-13T12:00:00Z # public key: ${await identityToRecipient(identity)} ${identity}`);
    await user.click(within(prompt).getByRole('button', { name: 'Open the backup' }));

    await waitFor(() => expect(api.calls('POST /backup/verify')).toHaveLength(1));
    const form = api.calls('POST /backup/verify')[0].body as FormData;
    expect(form.get('fileKey')).toMatch(/^[A-Za-z0-9+/]{21}[AQgw]==$/);
    expect(form.get('encryptionKey')).toBeNull();
    expect((form.get('backup') as File).name).toBe('nuggets_backup_20261101_030000_000.tar.age');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/nuggets_backup_20261101_030000_000.*verified/), expect.anything()), {
      timeout: 6000,
    });
    expect(everythingSeen(api.requests)).not.toMatch(PRIVATE_KEY);
  }, 30_000);
});
