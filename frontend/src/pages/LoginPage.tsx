import React, { useState, useEffect, useRef } from 'react';
import { logger } from '../utils/logger';
import { errorCode, errorMessage, errorStatus } from '../utils/errors';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Card, Flex, Box, Heading, Text, TextField, Button, IconButton, Separator, Checkbox } from '@radix-ui/themes';
import { Eye, EyeOff, Fingerprint } from 'lucide-react';
import toast from 'react-hot-toast';
import NuggetsLogo from '../components/NuggetsLogo';
import PageLoader from '../components/PageLoader';
import { SetupStatusError } from '../components/SetupStatusError';
import {
  isPasskeySupported,
  isConditionalUISupported,
  isPasskeyRequestAborted,
  isPasskeyRequestDeclined,
} from '../services/api';
import { useSetupStatusQuery } from '../hooks/queries';
import { writeStored } from '../utils/storage';
import { sameOriginPath } from '../utils/safeUrls';
import PageContainer from '../components/PageContainer';

const REMEMBERED_EMAIL_KEY = 'nuggets_remembered_email';
/**
 * Automatic retries of the autofill request per page view: each spends a sign-in options
 * request from the address's budget (RATE_LIMIT_PASSKEY_OPTIONS_MAX, shared by everyone behind
 * it), so only one; pressing the button allows another.
 */
const AUTOFILL_RETRIES = 1;
/**
 * A declined autofill request is offered again only if it had waited this long (the person
 * chose a passkey, then cancelled its prompt). One declined at once (an authenticator with no
 * passkey for this site, say) would only be declined again.
 */
const AUTOFILL_MIN_WAIT_MS = 1000;
/** How long to wait before offering it again. */
const AUTOFILL_RETRY_DELAY_MS = 1000;

/**
 * What to tell someone whose passkey sign-in failed. A challenge that ran out (the page sat
 * open past its 5 minutes, or newer sign-ins in this browser replaced it) isn't their fault.
 */
const passkeyFailureMessage = (error: unknown) =>
  errorCode(error) === 'INVALID_CHALLENGE'
    ? 'That took too long. Choose your passkey again.'
    : errorMessage(error, 'Failed to sign in with passkey');

/** The email saved by "Remember me", if any. */
const readRememberedEmail = (): string | null => {
  try {
    return localStorage.getItem(REMEMBERED_EMAIL_KEY);
  } catch {
    return null;
  }
};

const LoginPage: React.FC = () => {
  // A remembered email fills the field, with "Remember me" ticked.
  const [email, setEmail] = useState(() => readRememberedEmail() ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => !!readRememberedEmail());
  const [isLoading, setIsLoading] = useState(false);
  const [isPasskeyLoading, setIsPasskeyLoading] = useState(false);
  // Whether this browser has passkeys at all doesn't change while the page is open.
  const [passkeySupported] = useState(isPasskeySupported);
  // A passkey request is waiting in the email box's autofill: only then does the tip show.
  const [autofillWaiting, setAutofillWaiting] = useState(false);
  // Ends the waiting autofill request (the button, or leaving the page).
  const autofillRequest = useRef<AbortController | null>(null);
  // The autofill's offer again, while it waits out its pause: the button cancels it, or the
  // retry would start a request that ends the button's.
  const autofillRetry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Bumped by the button: an autofill offer begun before it stops at its next step, so it
  // can't start a request that ends the button's.
  const autofillGeneration = useRef(0);
  // Bumped to offer the autofill again after the button's request failed.
  const [autofillRound, setAutofillRound] = useState(0);
  // Focus goes back to the button after its request failed: while it ran, the button was
  // disabled, which sent focus to the page.
  const passkeyButton = useRef<HTMLButtonElement>(null);
  const [passkeyButtonFailures, setPasskeyButtonFailures] = useState(0);
  useEffect(() => {
    if (passkeyButtonFailures > 0) passkeyButton.current?.focus();
  }, [passkeyButtonFailures]);

  const { login, loginWithPasskey, user } = useAuth();
  const location = useLocation();
  // Where to go after signing in: the page that sent here, with its query and
  // hash (an invitation link carries its token after the #), if it is a path on this app:
  // https://app//evil.example arrives as the pathname //evil.example.
  const fromLocation = location.state?.from as { pathname?: string; search?: string; hash?: string } | undefined;
  const from =
    sameOriginPath(fromLocation?.pathname ? `${fromLocation.pathname}${fromLocation.search ?? ''}${fromLocation.hash ?? ''}` : null) ?? '/';

  // Null while loading (the loading screen) and when the probe failed (a retry screen,
  // below): a server that didn't answer is not a new install.
  const setupStatusQuery = useSetupStatusQuery();
  const setupComplete = setupStatusQuery.data?.setupComplete ?? null;

  // Passkeys in the email box's autofill: where the browser can offer them there
  // (conditional mediation), a request waits from the moment the form shows, with no email.
  // Choosing a passkey there signs in. The form is on the page only once setup is known
  // to be done and nobody is signed in.
  const formShown = setupComplete === true && !user;
  useEffect(() => {
    if (!passkeySupported || !formShown) return;
    let live = true;
    let retries = 0;
    const offer = async (): Promise<void> => {
      const generation = autofillGeneration.current;
      // Still wanted: the page is open, and the button hasn't been pressed since this began.
      const wanted = () => live && generation === autofillGeneration.current;
      if (!(await isConditionalUISupported()) || !wanted()) return;
      const request = new AbortController();
      autofillRequest.current = request;
      let waitingSince: number | undefined;
      const onWaiting = () => {
        waitingSince = Date.now();
        if (live) setAutofillWaiting(true);
      };
      try {
        await loginWithPasskey({ autofill: true, signal: request.signal, onWaiting });
        window.location.href = from;
      } catch (error) {
        if (autofillRequest.current === request) autofillRequest.current = null;
        // Cancelled by the button or by leaving the page: nothing to say, and nothing offered
        // again. The cancel doesn't stop a verify already sent, so its refusal can come after.
        if (!wanted() || isPasskeyRequestAborted(error)) return;
        setAutofillWaiting(false);
        // Offered again, once, after a passkey chosen there was refused by the server (or
        // its challenge ran out), or chosen and then declined at its prompt. Anything else
        // (no passkey for this site, the options didn't come) leaves the button.
        const status = errorStatus(error);
        const refused = status === 400 || status === 401;
        const declined = isPasskeyRequestDeclined(error);
        const declinedAfterWaiting =
          declined && waitingSince !== undefined && Date.now() - waitingSince >= AUTOFILL_MIN_WAIT_MS;
        if (refused) toast.error(passkeyFailureMessage(error));
        else if (!declined) logger.warn({ err: error }, 'Passkey autofill unavailable');
        // A challenge that ran out was the person's own choice of passkey, so it is always
        // offered again, as its message says; the other retries are counted.
        const expired = errorCode(error) === 'INVALID_CHALLENGE';
        if (expired || ((refused || declinedAfterWaiting) && retries < AUTOFILL_RETRIES)) {
          if (!expired) retries += 1;
          autofillRetry.current = setTimeout(() => void offer(), AUTOFILL_RETRY_DELAY_MS);
        }
      }
    };
    void offer();
    return () => {
      live = false;
      clearTimeout(autofillRetry.current);
      autofillRetry.current = undefined;
      autofillRequest.current?.abort();
      autofillRequest.current = null;
    };
  }, [passkeySupported, formShown, loginWithPasskey, from, autofillRound]);

  // If user is already logged in, redirect to where they came from
  if (user) {
    return <Navigate to={from} replace />;
  }

  // If setup is not complete, redirect to admin setup
  if (setupComplete === false) {
    return <Navigate to="/admin-setup" replace />;
  }

  if (setupComplete === null && setupStatusQuery.isError) {
    return (
      <SetupStatusError
        error={setupStatusQuery.error}
        onRetry={() => void setupStatusQuery.refetch()}
        retrying={setupStatusQuery.isFetching}
      />
    );
  }

  // Still loading setup status
  if (setupComplete === null) {
    return (
      <Flex align="center" justify="center" minHeight="100vh">
        <PageContainer width="auth">
          <PageLoader label="Loading..." size={48} />
        </PageContainer>
      </Flex>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    // Save or remove email based on remember me checkbox
    writeStored('local', REMEMBERED_EMAIL_KEY, rememberMe ? email : null);

    // On failure, login() shows the server's reason: a wrong password, or a sign-in
    // throttled after too many failures.
    await login(email, password);

    setIsLoading(false);
  };

  // No email needed: the browser asks which passkey, and that passkey says whose
  // account it is. The request waiting in the autofill ends first.
  const handlePasskeyLogin = async () => {
    autofillGeneration.current += 1;
    clearTimeout(autofillRetry.current);
    autofillRetry.current = undefined;
    autofillRequest.current?.abort();
    autofillRequest.current = null;
    setAutofillWaiting(false);
    setIsPasskeyLoading(true);
    try {
      await loginWithPasskey();

      // Session cookie is set by the server
      // Reload to update auth state (session will be verified from cookie)
      window.location.href = from;
    } catch (error) {
      if (!isPasskeyRequestAborted(error)) {
        logger.error({ err: error }, 'Passkey login failed');
        toast.error(passkeyFailureMessage(error));
      }
      setIsPasskeyLoading(false);
      setPasskeyButtonFailures((failures) => failures + 1);
      // Offer the passkeys in the autofill again.
      setAutofillRound((round) => round + 1);
    }
  };

  return (
    <Flex
      align="center"
      justify="center"
      className="bg-[var(--gray-2)]"
      minHeight="100vh"
      py="9"
    >
      <PageContainer width="auth">
        <Card size="4">
          <Flex direction="column" gap="6">
            {/* Logo and Header */}
            <Flex direction="column" align="center" gap="4">
              <NuggetsLogo size={80} />
              <Flex direction="column" gap="2" align="center">
                <Heading size="6" align="center">
                  Sign in to your account
                </Heading>
                <Text size="2" color="gray" align="center">
                  Enter your credentials to access Nuggets
                </Text>
              </Flex>
            </Flex>

            {/* Login Form */}
            <form onSubmit={handleSubmit}>
              <Flex direction="column" gap="4">
                {/* Email Field */}
                <Flex direction="column" gap="2">
                  <Text as="label" size="2" weight="medium" htmlFor="email-address">
                    Email address
                  </Text>
                  <TextField.Root
                    id="email-address"
                    name="email"
                    type="email"
                    // Saved passkeys show in its autofill beside saved passwords.
                    autoComplete="username webauthn"
                    required
                    size="3"
                    variant="surface"
                    placeholder="Enter your email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Flex>

                {/* Password Field */}
                <Flex direction="column" gap="2">
                  <Text as="label" size="2" weight="medium" htmlFor="password">
                    Password
                  </Text>
                  <Box position="relative">
                    <TextField.Root
                      id="password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      required
                      size="3"
                      variant="surface"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      style={{ paddingRight: '3rem' }}
                    />
                    <Flex
                      align="center"
                      justify="center"
                      position="absolute"
                      right="0"
                      top="0"
                      bottom="0"
                      width="3rem"
                      style={{ pointerEvents: 'none' }}
                    >
                      <IconButton
                        type="button"
                        variant="ghost"
                        color="gray"
                        size="1"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        style={{ pointerEvents: 'auto' }}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? (
                          <EyeOff size={16} />
                        ) : (
                          <Eye size={16} />
                        )}
                      </IconButton>
                    </Flex>
                  </Box>
                </Flex>

                {/* Remember Me Checkbox */}
                <Flex align="center" gap="2" mt="2">
                  <Checkbox
                    id="remember-me"
                    checked={rememberMe}
                    onCheckedChange={(checked) => setRememberMe(checked === true)}
                  />
                  <Text as="label" size="2" htmlFor="remember-me" style={{ cursor: 'pointer' }}>
                    Remember my email
                  </Text>
                </Flex>

                {/* Submit Button */}
                <Button
                  type="submit"
                  disabled={isLoading || isPasskeyLoading}
                  loading={isLoading}
                  size="3"
                  mt="2"
                  style={{ width: '100%' }}
                >
                  Sign in
                </Button>
              </Flex>
            </form>

            {/* Passkey Login Option */}
            {passkeySupported && (
              <>
                <Flex align="center" gap="3">
                  <Separator style={{ flex: 1 }} />
                  <Text size="2" color="gray">
                    or
                  </Text>
                  <Separator style={{ flex: 1 }} />
                </Flex>

                <Button
                  ref={passkeyButton}
                  type="button"
                  variant="outline"
                  size="3"
                  style={{ width: '100%' }}
                  onClick={handlePasskeyLogin}
                  disabled={isLoading || isPasskeyLoading}
                  loading={isPasskeyLoading}
                >
                  <Fingerprint size={20} />
                  Sign in with a passkey
                </Button>

                {autofillWaiting && (
                  <Text size="1" color="gray" align="center">
                    Tip: your saved passkeys are also offered when you select the email box
                  </Text>
                )}
              </>
            )}
          </Flex>
        </Card>
      </PageContainer>
    </Flex>
  );
};

export default LoginPage;
