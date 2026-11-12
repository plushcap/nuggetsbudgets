import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { attachmentFileName } from '../../services/api/admin';
import UtilitiesPage from '../UtilitiesPage';

/**
 * Settings → Utilities: two downloads for a deployment admin's bug report, the
 * database schema and the applied migrations. Only `fetch` is stubbed; the page saves
 * what it gets under the name the server gave it.
 */

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

const SCHEMA_NAME = 'nuggets-schema-1.0.0-2026-11-03.sql';
const MIGRATIONS_NAME = 'nuggets-migrations-1.0.0-2026-11-03.sql';

const attachment = (name: string, body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/sql; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });

const failure = (status: number, error: string, code: string) =>
  new Response(JSON.stringify({ error, code, requestId: `req-${status}` }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let saved: Array<{ name: string; href: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  // jsdom has no object URLs; the page only hands one to a link.
  URL.createObjectURL = vi.fn(() => 'blob:utilities');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, href: this.getAttribute('href') ?? '' });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderPage = () => renderWithProviders(<Theme><UtilitiesPage /></Theme>, { route: '/settings/utilities' });

describe('UtilitiesPage', () => {
  it('names the page and says what each file holds, and that neither holds financial data', () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Utilities' })).toBeInTheDocument();
    const schema = screen.getByRole('region', { name: 'Database schema' });
    expect(within(schema).getByText(/pg_dump --schema-only/)).toBeInTheDocument();
    expect(within(schema).getByText(/no accounts, transactions or other financial data/)).toBeInTheDocument();
    const migrations = screen.getByRole('region', { name: 'Applied migrations' });
    expect(within(migrations).getByText(/schema_migrations/)).toBeInTheDocument();
    expect(screen.getByText(/Neither file holds any of your financial data/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download applied migrations' })).toBeEnabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('downloads the schema from its endpoint, busy until it arrives, and saves it under the name the server gave', async () => {
    let answer: (response: Response) => void = () => {};
    fetchMock = vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download database schema' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/admin/database/schema');
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('include');
    // Busy: the button can't start a second one, and the page says what it's doing.
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeDisabled();
    const schema = screen.getByRole('region', { name: 'Database schema' });
    expect(within(schema).getByRole('status')).toHaveTextContent('Preparing the database schema…');
    expect(within(screen.getByRole('region', { name: 'Applied migrations' })).getByRole('status')).toHaveTextContent('');

    answer(attachment(SCHEMA_NAME, '-- Nuggets database schema\nCREATE TABLE public.t (id integer);\n'));
    await waitFor(() => expect(saved).toEqual([{ name: SCHEMA_NAME, href: 'blob:utilities' }]));
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeEnabled();
    const { default: toast } = await import('react-hot-toast');
    expect(toast.success).toHaveBeenCalledWith(`Downloaded ${SCHEMA_NAME}`);
  });

  it('downloads the applied migrations from theirs', async () => {
    fetchMock = vi.fn(async () => attachment(MIGRATIONS_NAME, "INSERT INTO public.schema_migrations VALUES ('x');\n"));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download applied migrations' }));
    await waitFor(() => expect(saved).toEqual([{ name: MIGRATIONS_NAME, href: 'blob:utilities' }]));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/database/migrations');
  });

  it('keeps each download busy on its own while both run', async () => {
    let answerSchema: (response: Response) => void = () => {};
    fetchMock = vi.fn((url: string) =>
      url.endsWith('/schema')
        ? new Promise<Response>((resolve) => (answerSchema = resolve))
        : Promise.resolve(attachment(MIGRATIONS_NAME, '-- migrations\n'))
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download database schema' }));
    await user.click(screen.getByRole('button', { name: 'Download applied migrations' }));
    await waitFor(() => expect(saved.map((f) => f.name)).toEqual([MIGRATIONS_NAME]));
    // The migrations finished; the schema is still on its way.
    expect(screen.getByRole('button', { name: 'Download applied migrations' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeDisabled();
    expect(within(screen.getByRole('region', { name: 'Database schema' })).getByRole('status')).toHaveTextContent('Preparing the database schema…');

    answerSchema(attachment(SCHEMA_NAME, '-- schema\n'));
    await waitFor(() => expect(saved.map((f) => f.name)).toEqual([MIGRATIONS_NAME, SCHEMA_NAME]));
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeEnabled();
  });

  it("shows the server's reason in place, with the request's reference, and saves nothing", async () => {
    fetchMock = vi.fn(async () => failure(500, "The database schema couldn't be exported. The server log has the details.", 'SCHEMA_EXPORT_FAILED'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download database schema' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      "Couldn't download the database schema: The database schema couldn't be exported. The server log has the details. (reference req-500)"
    );
    expect(within(screen.getByRole('region', { name: 'Database schema' })).getByRole('alert')).toBe(alert);
    expect(saved).toEqual([]);
    expect(screen.getByRole('button', { name: 'Download database schema' })).toBeEnabled();
  });

  it('says the download did not finish when the connection was cut', async () => {
    fetchMock = vi.fn(async () => {
      throw new TypeError('network error');
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Download applied migrations' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't download the applied migrations: The download didn't finish."
    );
    expect(saved).toEqual([]);
  });
});

describe('attachmentFileName', () => {
  const named = (header: string | null) => new Response('', { headers: header ? { 'Content-Disposition': header } : {} });

  it('takes filename* first, then filename, else the fallback', () => {
    expect(attachmentFileName(named(`attachment; filename="a.sql"; filename*=UTF-8''b%20c.sql`), 'x.sql')).toBe('b c.sql');
    expect(attachmentFileName(named('attachment; filename="a.sql"'), 'x.sql')).toBe('a.sql');
    expect(attachmentFileName(named(null), 'x.sql')).toBe('x.sql');
    expect(attachmentFileName(named(`attachment; filename*=UTF-8''%E0%A4%A`), 'x.sql')).toBe('x.sql');
  });

  it('keeps only the name, never a path', () => {
    expect(attachmentFileName(named(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`), 'x.sql')).toBe('passwd');
    expect(attachmentFileName(named('attachment; filename="..\\\\evil.sql"'), 'x.sql')).toBe('evil.sql');
    expect(attachmentFileName(named(`attachment; filename*=UTF-8''..`), 'x.sql')).toBe('x.sql');
  });
});
