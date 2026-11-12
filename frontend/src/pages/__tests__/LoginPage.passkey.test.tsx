import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Toaster, toast } from 'react-hot-toast';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import { membership as noLedgers, ownAccount } from '../../test/fixtures';
import { apiError, mockApi } from '../../test/apiServer';
import { AuthProvider } from '../../contexts/AuthContext';
import LoginPage from '../LoginPage';
import { logger } from '../../utils/logger';
import { browserSupportsWebAuthnAutofill } from '@simplewebauthn/browser';

/**
 * Passkey sign-in without an email, through the real AuthProvider and passkey
 * service against the API: only the browser's WebAuthn calls are stood in for. Where the
 * browser can offer passkeys in the email box's autofill, a request waits there from the
 * start; the button asks with no email, ending that request first.
 */

vi.mock('../../utils/pushNotifications', () => ({
  disablePushOnSignOut: vi.fn(async () => {}),
  syncPushSubscription: vi.fn(async () => {}),
}));

/** The browser's WebAuthn, as the library sees it: each request, until it is answered or aborted. */
const webauthn = vi.hoisted(() => ({
  autofill: true,
  requests: [] as Array<{ autofill: boolean; aborted: boolean; answer: (r: unknown) => void; fail: (e: unknown) => void }>,
  /** What a modal (button) request answers with ('wait': the test answers it); an autofill request waits for the test. */
  modal: 'answer' as 'answer' | 'decline' | 'wait',
  /** What an autofill request fails with at once, when the browser can't serve it after all. */
  autofillFails: null as null | { name: string; message: string },
}));
const ASSERTION = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: 'aGFuZGxl' },
  clientExtensionResults: {},
};
vi.mock('@simplewebauthn/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/browser')>();
  return {
    ...actual,
    browserSupportsWebAuthnAutofill: vi.fn(async () => webauthn.autofill),
    // As the library does: one request at a time (WebAuthnAbortService), a new one ending the last.
    startAuthentication: vi.fn(
      ({ useBrowserAutofill = false }: { useBrowserAutofill?: boolean }) =>
        new Promise((resolve, reject) => {
          const signal = actual.WebAuthnAbortService.createNewAbortSignal();
          const request = { autofill: useBrowserAutofill, aborted: false, answer: resolve, fail: reject };
          signal.addEventListener('abort', () => {
            request.aborted = true;
            reject(Object.assign(new Error('Cancelling existing WebAuthn API call'), { name: 'AbortError' }));
          });
          webauthn.requests.push(request);
          if (useBrowserAutofill && webauthn.autofillFails) {
            reject(Object.assign(new Error(webauthn.autofillFails.message), { name: webauthn.autofillFails.name }));
          } else if (!useBrowserAutofill && webauthn.modal !== 'wait') {
            if (webauthn.modal === 'answer') resolve(ASSERTION);
            else reject(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
          }
        })
    ),
  };
});

const ada = ownAccount({ id: 1, uuid: '0190a000-0006-7000-8000-000000000001', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
const membership = noLedgers();
const OPTIONS = { rpId: 'localhost', challenge: 'Y2hhbGxlbmdl', timeout: 300000, userVerification: 'required' };
const PASSKEY_SIGN_IN = ['POST /passkeys/auth/options', 'POST /passkeys/auth/verify'];

const routes = (overrides: Parameters<typeof mockApi>[0] = {}) => ({
  'GET /auth/me': apiError(401, 'Not signed in', 'UNAUTHENTICATED'),
  'GET /auth/setup-status': { setupComplete: true, requiresSetup: false },
  'GET /auth/tenants': membership,
  'GET /auth/password-policy': { minLength: 12 },
  'POST /passkeys/auth/options': OPTIONS,
  'POST /passkeys/auth/verify': { user: { id: ada.id, email: ada.email } },
  ...overrides,
});

const renderLogin = () =>
  renderWithProviders(
    <Theme>
      <Toaster />
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </AuthProvider>
    </Theme>,
    { route: '/login' },
  );

/** Where the page sends the browser after a sign-in (it reloads, to read the new session). */
let navigatedTo: string | undefined;
const realLocation = window.location;

beforeEach(() => {
  // react-hot-toast keeps its toasts across renders: a test sees only its own.
  toast.remove();
  webauthn.autofill = true;
  webauthn.requests.length = 0;
  webauthn.modal = 'answer';
  webauthn.autofillFails = null;
  navigatedTo = undefined;
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new Proxy(realLocation, {
      set: (_target, prop, value) => {
        if (prop === 'href') navigatedTo = String(value);
        return true;
      },
      get: (target, prop) => Reflect.get(target, prop),
    }),
  });
});
afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const autofillRequests = () => webauthn.requests.filter((r) => r.autofill);
/** The browser's answer when the person turns down the prompt of a passkey they chose. */
const declined = () => Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Past the page's pause before it offers the autofill again (AUTOFILL_RETRY_DELAY_MS). */
const RETRY = { timeout: 3000 };
const REFUSED = apiError(401, 'Authentication verification failed', 'VERIFICATION_FAILED');

describe('LoginPage passkey sign-in', () => {
  it('offers passkeys in the email box’s autofill from the start, asking the API for options with no email', async () => {
    localStorage.setItem('nuggets_remembered_email', 'ada@example.com');
    const api = mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();

    const email = await screen.findByLabelText('Email address');
    expect(email).toHaveAttribute('autocomplete', 'username webauthn');
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    // Even with an email in the box, none is sent.
    expect(api.calls('POST /passkeys/auth/options').map((r) => r.body)).toEqual([{}]);
    expect(await screen.findByText(/your saved passkeys are also offered when you select the email box/i)).toBeInTheDocument();

    // A passkey chosen there signs in.
    autofillRequests()[0].answer(ASSERTION);
    await waitFor(() => expect(navigatedTo).toBe('/'));
    expect(api.calls('POST /passkeys/auth/verify').map((r) => r.body)).toEqual([{ response: ASSERTION }]);
    expect(api.unhandled).toEqual([]);
  });

  it('starts no autofill request, and shows no tip, where the browser can’t offer passkeys there', async () => {
    webauthn.autofill = false;
    const api = mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();

    expect(await screen.findByLabelText('Email address')).toHaveAttribute('autocomplete', 'username webauthn');
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeInTheDocument();
    // Settle the autofill check before saying nothing was asked.
    await waitFor(() => expect(api.calls('GET /auth/setup-status').length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(webauthn.requests).toEqual([]);
    expect(api.calls('POST /passkeys/auth/options')).toEqual([]);
    expect(screen.queryByText(/saved passkeys are also offered/i)).toBeNull();
  });

  it('signs in with the button and no email, ending the waiting autofill request first', async () => {
    const api = mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    expect(screen.getByLabelText('Email address')).toHaveValue('');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in with a passkey' }));

    await waitFor(() => expect(navigatedTo).toBe('/'));
    const [waiting, asked] = webauthn.requests;
    expect(waiting).toMatchObject({ autofill: true, aborted: true });
    expect(asked).toMatchObject({ autofill: false, aborted: false });
    expect(api.calls('POST /passkeys/auth/options').map((r) => r.body)).toEqual([{}, {}]);
    expect(api.calls('POST /passkeys/auth/verify').map((r) => r.body)).toEqual([{ response: ASSERTION }]);
    // No "enter your email first", and nothing about the cancelled autofill request.
    expect(screen.queryByText(/email address first/i)).toBeNull();
    expect(screen.queryByText(/cancel/i)).toBeNull();
  });

  // With no explicit end to it, an autofill request whose options came after the
  // click would start its ceremony and end the button's (the browser holds one at a time).
  it('keeps the button’s request when the autofill’s options come after the click', async () => {
    webauthn.modal = 'wait';
    let releaseAutofillOptions = () => {};
    const autofillOptions = new Promise<void>((resolve) => {
      releaseAutofillOptions = resolve;
    });
    let optionsAsked = 0;
    const api = mockApi(
      routes({
        'POST /passkeys/auth/options': async () => {
          optionsAsked += 1;
          if (optionsAsked === 1) await autofillOptions;
          return OPTIONS;
        },
      }),
      { csrfExempt: PASSKEY_SIGN_IN }
    );
    renderLogin();
    await waitFor(() => expect(optionsAsked).toBe(1));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in with a passkey' }));
    await waitFor(() => expect(webauthn.requests).toHaveLength(1));
    const [asked] = webauthn.requests;
    expect(asked.autofill).toBe(false);

    // The autofill's options come now: it starts no ceremony, and the button's goes on.
    releaseAutofillOptions();
    await sleep(20);
    expect(autofillRequests()).toEqual([]);
    expect(asked.aborted).toBe(false);
    asked.answer(ASSERTION);
    await waitFor(() => expect(navigatedTo).toBe('/'));
    expect(api.calls('POST /passkeys/auth/verify')).toHaveLength(1);
  });

  it('shows the server’s refusal of the button’s passkey, and offers the autofill again', async () => {
    mockApi(routes({ 'POST /passkeys/auth/verify': REFUSED }), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    const button = screen.getByRole('button', { name: 'Sign in with a passkey' });

    await userEvent.setup().click(button);

    expect(await screen.findByText('Authentication verification failed')).toBeInTheDocument();
    expect(navigatedTo).toBeUndefined();
    await waitFor(() => expect(autofillRequests()).toHaveLength(2));
    expect(autofillRequests()[1].aborted).toBe(false);
    expect(button).toBeEnabled();
  });

  // A locked account's own passkey is told the account is locked, as its password is.
  it('says the account is locked when the server says so of the passkey', async () => {
    mockApi(
      routes({ 'POST /passkeys/auth/verify': apiError(401, 'Account is locked. Please contact an administrator.', 'ACCOUNT_LOCKED') }),
      { csrfExempt: PASSKEY_SIGN_IN }
    );
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in with a passkey' }));

    expect(await screen.findByText('Account is locked. Please contact an administrator.')).toBeInTheDocument();
    expect(navigatedTo).toBeUndefined();
  });

  // The button is disabled while its request runs, and a browser moves focus off a
  // disabled button (to the page), which jsdom doesn't: done here by hand.
  it('puts focus back on the button after its request failed', async () => {
    webauthn.modal = 'wait';
    mockApi(routes({ 'POST /passkeys/auth/verify': REFUSED }), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    const button = screen.getByRole('button', { name: 'Sign in with a passkey' });

    await userEvent.setup().click(button);
    await waitFor(() => expect(button).toBeDisabled());
    // (jsdom won't blur a disabled element: focus moves to something else instead.)
    const elsewhere = document.createElement('div');
    elsewhere.tabIndex = -1;
    document.body.append(elsewhere);
    elsewhere.focus();
    expect(button).not.toHaveFocus();
    await waitFor(() => expect(webauthn.requests.filter((r) => !r.autofill)).toHaveLength(1));
    webauthn.requests.find((r) => !r.autofill)!.answer(ASSERTION);

    expect(await screen.findByText('Authentication verification failed')).toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
    elsewhere.remove();
  });

  it('shows the server’s refusal of a passkey chosen in the autofill, and offers it again once', async () => {
    const api = mockApi(routes({ 'POST /passkeys/auth/verify': REFUSED }), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));

    autofillRequests()[0].answer(ASSERTION);

    expect(await screen.findByText('Authentication verification failed')).toBeInTheDocument();
    await waitFor(() => expect(autofillRequests()).toHaveLength(2), RETRY);
    expect(navigatedTo).toBeUndefined();

    // Refused again: the button is left, with no more requests of the page's own.
    autofillRequests()[1].answer(ASSERTION);
    await waitFor(() => expect(api.calls('POST /passkeys/auth/verify')).toHaveLength(2));
    await sleep(1500);
    expect(autofillRequests()).toHaveLength(2);
    expect(api.calls('POST /passkeys/auth/options')).toHaveLength(2);
  });

  // Each request spends one from the address's sign-in options budget.
  it('doesn’t offer the autofill again when the browser declines it at once (no passkey for this site)', async () => {
    webauthn.autofillFails = { name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' };
    const api = mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    await sleep(1500);
    expect(autofillRequests()).toHaveLength(1);
    expect(api.calls('POST /passkeys/auth/options')).toHaveLength(1);
    expect(screen.queryByText(/not allowed|cancel/i)).toBeNull();
  });

  it('offers the autofill again once after a passkey chosen there is declined at its prompt, and no more', async () => {
    const api = mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    // The person chose a passkey after a while, then cancelled its prompt.
    await sleep(1100);
    autofillRequests()[0].fail(declined());
    await waitFor(() => expect(autofillRequests()).toHaveLength(2), RETRY);

    await sleep(1100);
    autofillRequests()[1].fail(declined());
    await sleep(1500);
    expect(autofillRequests()).toHaveLength(2);
    expect(api.calls('POST /passkeys/auth/options')).toHaveLength(2);
    // Nothing to say: they cancelled it themselves.
    expect(screen.queryByText(/cancel/i)).toBeNull();
  });

  // A passkey chosen after its challenge ran out (5 minutes, or 3 newer sign-ins
  // in this browser) used to show "Challenge not found or expired".
  it('asks to choose the passkey again, in plain words, when the autofill’s challenge ran out', async () => {
    mockApi(
      routes({ 'POST /passkeys/auth/verify': apiError(400, 'Challenge not found or expired', 'INVALID_CHALLENGE') }),
      { csrfExempt: PASSKEY_SIGN_IN }
    );
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));

    autofillRequests()[0].answer(ASSERTION);

    expect(await screen.findByText('That took too long. Choose your passkey again.')).toBeInTheDocument();
    expect(screen.queryByText(/Challenge not found/)).toBeNull();
    await waitFor(() => expect(autofillRequests()).toHaveLength(2), RETRY);
    expect(autofillRequests()[1].aborted).toBe(false);
  });

  it('keeps a button press made while the autofill waits to be offered again', async () => {
    mockApi(routes({ 'POST /passkeys/auth/verify': REFUSED }), { csrfExempt: PASSKEY_SIGN_IN });
    webauthn.modal = 'wait';
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    autofillRequests()[0].answer(ASSERTION);
    expect(await screen.findByText('Authentication verification failed')).toBeInTheDocument();

    // Within the retry's pause, the person presses the button.
    await userEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));
    await waitFor(() => expect(webauthn.requests.filter((r) => !r.autofill)).toHaveLength(1));
    await sleep(1500);
    const modal = webauthn.requests.find((r) => !r.autofill)!;
    expect(modal.aborted).toBe(false);
    expect(autofillRequests()).toHaveLength(1);
  });

  // The button's cancel ends the autofill's browser request, not a verify it already sent:
  // that verify's refusal, coming after, offers nothing again.
  it.each([
    ['refused', REFUSED],
    ['ran out', apiError(400, 'Challenge not found or expired', 'INVALID_CHALLENGE')],
  ])('keeps a button press made while the autofill’s passkey is being checked, and it is %s', async (_, answer) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    mockApi(routes({ 'POST /passkeys/auth/verify': async () => (await held, answer) }), { csrfExempt: PASSKEY_SIGN_IN });
    webauthn.modal = 'wait';
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    autofillRequests()[0].answer(ASSERTION);

    // While its verify is on its way, the person presses the button; then the verify answers.
    await userEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));
    await waitFor(() => expect(webauthn.requests.filter((r) => !r.autofill)).toHaveLength(1));
    release();
    await sleep(1500);
    expect(webauthn.requests.find((r) => !r.autofill)!.aborted).toBe(false);
    expect(autofillRequests()).toHaveLength(1);
    // No toast at all (react-hot-toast shows each as a status).
    expect(screen.queryAllByRole('status')).toEqual([]);
  });

  it('keeps a button press made after the retry began, while it asks whether the browser can autofill', async () => {
    mockApi(routes({ 'POST /passkeys/auth/verify': REFUSED }), { csrfExempt: PASSKEY_SIGN_IN });
    webauthn.modal = 'wait';
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    // The retry's support check waits until the test answers it.
    let supported!: (yes: boolean) => void;
    const supportCheck = vi.mocked(browserSupportsWebAuthnAutofill);
    const checksBefore = supportCheck.mock.calls.length;
    supportCheck.mockImplementationOnce(() => new Promise<boolean>((resolve) => (supported = resolve)));
    autofillRequests()[0].answer(ASSERTION);
    expect(await screen.findByText('Authentication verification failed')).toBeInTheDocument();
    await waitFor(() => expect(supportCheck.mock.calls.length).toBe(checksBefore + 1), RETRY);

    await userEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));
    await waitFor(() => expect(webauthn.requests.filter((r) => !r.autofill)).toHaveLength(1));
    supported(true);
    await sleep(100);
    expect(webauthn.requests.find((r) => !r.autofill)!.aborted).toBe(false);
    expect(autofillRequests()).toHaveLength(1);
  });

  it('offers the autofill again after every challenge that ran out, not only the first', async () => {
    mockApi(
      routes({ 'POST /passkeys/auth/verify': apiError(400, 'Challenge not found or expired', 'INVALID_CHALLENGE') }),
      { csrfExempt: PASSKEY_SIGN_IN }
    );
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    autofillRequests()[0].answer(ASSERTION);
    await waitFor(() => expect(autofillRequests()).toHaveLength(2), RETRY);
    autofillRequests()[1].answer(ASSERTION);
    await waitFor(() => expect(autofillRequests()).toHaveLength(3), RETRY);
    expect(autofillRequests()[2].aborted).toBe(false);
  });

  // Headless Chrome with no authenticator says it can, then refuses the request (as in the e2e tests).
  it('says nothing, and shows no tip, when the browser can’t serve the autofill request after all', async () => {
    webauthn.autofillFails = {
      name: 'NotSupportedError',
      message: "Resident credentials or empty 'allowCredentials' lists are not supported at this time.",
    };
    const errors = vi.spyOn(logger, 'error');
    mockApi(routes(), { csrfExempt: PASSKEY_SIGN_IN });
    renderLogin();
    await waitFor(() => expect(autofillRequests()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Not offered again, nothing shown, and nothing logged as an error (the page's console).
    expect(autofillRequests()).toHaveLength(1);
    expect(screen.queryByText(/saved passkeys are also offered/i)).toBeNull();
    expect(screen.queryByText(/not supported/i)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  });

  it('says nothing when the autofill’s options don’t come, and leaves the button', async () => {
    mockApi(
      routes({ 'POST /passkeys/auth/options': apiError(429, 'Too many passkey sign-in attempts', 'RATE_LIMITED') }),
      { csrfExempt: PASSKEY_SIGN_IN }
    );
    renderLogin();
    await screen.findByLabelText('Email address');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(webauthn.requests).toEqual([]);
    expect(screen.queryByText('Too many passkey sign-in attempts')).toBeNull();
    expect(screen.queryByText(/saved passkeys are also offered/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  });
});
