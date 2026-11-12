import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  GenerateRegistrationOptionsOpts,
  GenerateAuthenticationOptionsOpts,
  VerifyRegistrationResponseOpts,
  VerifyAuthenticationResponseOpts,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { sql } from 'kysely';
import { db } from '../db.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';
import { generateKeyPairSync, randomBytes, webcrypto } from 'crypto';
import { resolveWebAuthnConfig, type WebAuthnConfig } from '../utils/webauthnConfig.js';
import { CEREMONY_TTL_MS } from './WebAuthnChallengeStore.js';
import { lockUserForNewCredential } from './userCredentialLock.js';
import { sessionService } from '../middleware/auth.js';
import { knownTransports, type KnownTransport } from './passkeyTransports.js';
import { PasskeyError } from './auth/authErrors.js';

// Polyfill for Web Crypto API in Node.js
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

const logger = createLogger({ service: 'PasskeyService' });

interface PasskeyCredential {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: number;
  device_name?: string;
  transports?: KnownTransport[];
  aaguid?: string;
  credential_device_type?: string;
  credential_backed_up?: boolean;
  last_used_at?: Date;
  /** The WebAuthn user handle it answers with; absent for one registered before v2.2.0 that hasn't signed in since. */
  user_handle?: string;
  /** Whether it can sign in without an email: absent when that isn't known. */
  discoverable?: boolean;
  created_at: Date;
  updated_at: Date | null;
}

// Columns selected for every credential read.
const CREDENTIAL_COLUMNS = [
  'id', 'user_id', 'credential_id', 'public_key', 'counter', 'device_name',
  'transports', 'aaguid', 'credential_device_type', 'credential_backed_up',
  'last_used_at', 'user_handle', 'discoverable', 'created_at', 'updated_at',
] as const;

/**
 * Map a passkey_credentials row to the domain shape. counter is a BIGINT, so
 * pg returns it as a string — coerce to number here (SimpleWebAuthn expects a
 * number; previously the untyped row leaked the string through).
 */
function mapCredentialRow(row: {
  id: number;
  user_id: number;
  credential_id: string;
  public_key: string;
  counter: string | number | bigint;
  device_name: string | null;
  transports: string[] | null;
  aaguid: string | null;
  credential_device_type: string | null;
  credential_backed_up: boolean | null;
  last_used_at: Date | null;
  user_handle: string | null;
  discoverable: boolean | null;
  created_at: Date;
  updated_at: Date | null;
}): PasskeyCredential {
  return {
    id: row.id,
    user_id: row.user_id,
    credential_id: row.credential_id,
    public_key: row.public_key,
    counter: Number(row.counter),
    // A column that is null is left out, so it reads undefined, and SimpleWebAuthn's options
    // get no `transports` rather than an undefined one. Of the stored transports only the
    // known ones are read (passkeyTransports.ts): a row may predate the filter on save.
    ...(row.device_name !== null && { device_name: row.device_name }),
    ...(row.transports !== null && { transports: knownTransports(row.transports) }),
    ...(row.aaguid !== null && { aaguid: row.aaguid }),
    ...(row.credential_device_type !== null && { credential_device_type: row.credential_device_type }),
    ...(row.credential_backed_up !== null && { credential_backed_up: row.credential_backed_up }),
    ...(row.last_used_at !== null && { last_used_at: row.last_used_at }),
    ...(row.user_handle !== null && { user_handle: row.user_handle }),
    ...(row.discoverable !== null && { discoverable: row.discoverable }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * A WebAuthn user handle as base64url: 1 to 64 bytes, WebAuthn's limit. An account's
 * is 32 random bytes (43 characters), made when it registers its first passkey since v2.2.0.
 */
const USER_HANDLE_RE = /^[A-Za-z0-9_-]{1,86}$/;
const ACCOUNT_USER_HANDLE_BYTES = 32;

/**
 * The user handle an assertion names: undefined when it names none (a passkey that isn't
 * discoverable may not), null when it names one that can't be a user handle, else its bytes
 * re-encoded as unpadded base64url, so that two spellings of one handle compare equal.
 * The handle isn't covered by the signature: it only says which account the passkey was
 * made for, and is checked against the one the passkey is stored with.
 */
export function presentedUserHandle(response: unknown): string | null | undefined {
  const raw: unknown = (response as { response?: { userHandle?: unknown } } | null)?.response?.userHandle;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !USER_HANDLE_RE.test(raw)) return null;
  const bytes = Buffer.from(raw, 'base64url');
  return bytes.length >= 1 && bytes.length <= 64 ? bytes.toString('base64url') : null;
}

// WebAuthn's credential ids are at most 1023 bytes: 1364 characters of base64url.
const STORABLE_CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{1,1364}$/;
// The longest id a sign-in may present: that, and room for padding.
const MAX_PRESENTED_CREDENTIAL_ID_LENGTH = 1368;

/**
 * A credential id as stored: base64url without padding (a browser may send base64). One
 * longer than any credential id can be is no passkey's: it becomes '', which is refused,
 * before any work on it. The padding is trimmed in a loop, not with a regex: `/=+$/` took
 * time quadratic in a run of `=`, and the sign-in that sends it is public.
 */
const asStoredCredentialId = (id: string): string => {
  if (id.length > MAX_PRESENTED_CREDENTIAL_ID_LENGTH) return '';
  let end = id.length;
  while (end > 0 && id[end - 1] === '=') end -= 1;
  return id.slice(0, end).replace(/\+/g, '-').replace(/\//g, '_');
};

/**
 * Whether `credentialId` could be a stored passkey's: base64url, as every one is stored. One
 * that isn't (a NUL byte, which Postgres can't take in text, say) names no passkey, and is
 * answered so without a query.
 */
export const isStorableCredentialId = (credentialId: string): boolean => STORABLE_CREDENTIAL_ID_RE.test(credentialId);

/**
 * Whether a signature counter `presented` may follow `stored` (WebAuthn §7.2 step 22): it must
 * have grown, unless the authenticator keeps none (both zero, as synced passkeys do). One that
 * didn't may be a cloned authenticator.
 */
export const counterMayFollow = (stored: number, presented: number): boolean =>
  (stored === 0 && presented === 0) || presented > stored;

/**
 * The public key (COSE: EC2, ES256, P-256) of a key pair made for this process and then
 * thrown away, so nothing can sign for it. An assertion from a passkey that isn't stored
 * (unknown, or removed) is checked against it, so that it is refused after the same work, and
 * with the same answer, as a passkey that is stored but signed wrongly.
 */
const UNMATCHABLE_PUBLIC_KEY: Uint8Array<ArrayBuffer> = (() => {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y, 'base64url'),
  ]);
})();

/** A passkey as its owner's (or a deployment admin's) list shows it: never its key or counter. */
export interface PasskeySummary {
  id: string;
  deviceName: string | undefined;
  deviceType: string | undefined;
  backedUp: boolean | undefined;
  lastUsed: Date | undefined;
  createdAt: Date;
  /** Whether it can sign in without an email ({@link knownDiscoverable}); null when not known. */
  discoverable: boolean | null;
}

/**
 * Whether a passkey is known to sign in without an email: it is marked so (the
 * browser's credProps rk at registration, or a sign-in that named no account), or it was
 * registered under its account's user handle. Every passkey since v2.2.0 was: registration
 * takes residentKey 'required', so such a passkey is discoverable whatever the browser said of
 * rk. One from before has a handle the server never kept (or the random one it named at its
 * first sign-in since, which marks it discoverable). The one rule for a registration's
 * excludeCredentials and for the passkey lists, the owner's (whose banner counts the passkeys
 * not known to) and an admin's: one told to add a new passkey on that device must not be
 * refused it ("previously registered"). What is stored stays as the browser said it.
 */
function knownDiscoverable(cred: Pick<PasskeyCredential, 'discoverable' | 'user_handle'>, accountHandle: string | null): boolean {
  return cred.discoverable === true || (accountHandle !== null && cred.user_handle === accountHandle);
}

/** The account a passkey sign-in signed in to. */
export interface PasskeySignInAccount {
  id: number;
  email: string;
  /** As read with the passkey, for createSession to check that it hasn't changed since. */
  passwordChangedAt: Date | null;
}

/**
 * Why a ceremony was refused, when the person can be told: 'user_verification' when the
 * passkey proved only presence, not the user (no PIN or biometric), which
 * WEBAUTHN_USER_VERIFICATION=required refuses; for a registration, `credential_ended`
 * when the account or the session it came from ended (a lock, a password change or reset)
 * while it ran; for a sign-in, `account_locked` when the passkey is the account's own and its
 * assertion verified, but the account is locked. Any other refusal has none.
 */
export type PasskeyFailure = 'user_verification' | 'credential_ended' | 'account_locked';
const failureReason = (err: unknown): PasskeyFailure | undefined =>
  /user verification (was )?required/i.test(errorMessage(err)) ? 'user_verification' : undefined;
/** A ceremony that didn't verify, with its reason when it has one. */
const refusedFor = (err: unknown): { verified: false; reason?: PasskeyFailure } => {
  const reason = failureReason(err);
  return { verified: false, ...(reason && { reason }) };
};

/** What checking a sign-in's or a re-authentication's passkey found. */
export type PasskeyAssertionResult =
  | { verified: true; account: PasskeySignInAccount }
  | { verified: false; reason?: PasskeyFailure };
const REFUSED = { verified: false } as const;
const ACCOUNT_LOCKED = { verified: false, reason: 'account_locked' } as const;

/**
 * Who the assertion must come from: `{ signIn: true }` for a sign-in, where nobody is
 * identified first and the passkey says whose it is; `{ userId }` for a
 * re-authentication, where the signed-in user is.
 */
type AssertionFor = { signIn: true } | { signIn?: false; userId: number };

export class PasskeyService {
  private resolvedConfig?: WebAuthnConfig;

  /** Resolved on first use, so importing this module never needs the settings; index.ts checks them at startup. */
  private get config(): WebAuthnConfig {
    if (!this.resolvedConfig) {
      this.resolvedConfig = resolveWebAuthnConfig();
      logger.info(this.resolvedConfig, 'PasskeyService initialized with config');
    }
    return this.resolvedConfig;
  }

  /**
   * Generate registration options for a new passkey: a discoverable one, made for the
   * account's WebAuthn user handle, so that it can sign in without an email and says whose it is.
   */
  async generateRegistrationOptions(
    userId: number,
    userEmail: string
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    try {
      // Get existing credentials for this user
      const existingCredentials = await this.getUserCredentials(userId);
      const userHandle = await this.accountUserHandle(userId);

      const opts: GenerateRegistrationOptionsOpts = {
        rpName: this.config.rpName,
        rpID: this.config.rpID,
        userName: userEmail,
        userDisplayName: userEmail,
        // The same for every passkey of the account, so that an authenticator replaces its
        // passkey for the account rather than adding a second, and a sign-in can check it.
        userID: new Uint8Array(Buffer.from(userHandle, 'base64url')),
        timeout: CEREMONY_TTL_MS, // 5 minutes, for mobile; the challenge lasts as long
        attestationType: 'none',
        // The account's passkeys, so an authenticator that holds one doesn't make a second,
        // except those not known to sign in without an email (knownDiscoverable): the
        // profile page says to add a new one beside such a passkey and then delete it, which an
        // authenticator holding it would refuse ("previously registered") if it were listed
        // here (a browser that misreported rk left one made since out, and the
        // authenticator holding it made another for the account, in its place).
        excludeCredentials: existingCredentials
          .filter((cred) => knownDiscoverable(cred, userHandle))
          .map((cred) => ({
            id: cred.credential_id,
            type: 'public-key' as const,
            ...(cred.transports && { transports: cred.transports }),
          })),
        authenticatorSelection: {
          // Sign-in asks for no email: only a passkey the authenticator stores with its
          // account (a discoverable credential) can answer it. An authenticator that can't
          // store one fails the registration rather than make one that couldn't sign in.
          residentKey: 'required',
          // 'required' unless WEBAUTHN_USER_VERIFICATION=preferred: a passkey that
          // can't verify its user couldn't sign in either, so say so at enrolment.
          userVerification: this.config.userVerification,
          // Removed authenticatorAttachment to allow both platform and cross-platform authenticators
          // This enables Android credential manager and other mobile passkey implementations
        },
        // Whether the browser made it discoverable (rk), stored with it.
        extensions: { credProps: true },
        supportedAlgorithmIDs: [-7, -257], // ES256, RS256
      };

      const options = await generateRegistrationOptions(opts);

      logger.info({ userId }, 'Generated registration options');

      return options;
    } catch (error) {
      logger.error({
        userId,
        err: error,
      }, 'Failed to generate registration options');
      throw error; // Re-throw the original error instead of wrapping it
    }
  }

  /**
   * The account's WebAuthn user handle: made, once, the first time it registers a passkey
   * since v2.2.0, and the same from then on. A concurrent first registration gets the same one.
   */
  private async accountUserHandle(userId: number): Promise<string> {
    const read = () =>
      db.selectFrom('users').select('webauthn_user_id').where('id', '=', userId).executeTakeFirst();
    const current = await read();
    if (!current) throw new Error('No such account');
    if (current.webauthn_user_id) return current.webauthn_user_id;
    await db
      .updateTable('users')
      .set({ webauthn_user_id: randomBytes(ACCOUNT_USER_HANDLE_BYTES).toString('base64url') })
      .where('id', '=', userId)
      .where('webauthn_user_id', 'is', null)
      .execute();
    const made = (await read())?.webauthn_user_id;
    if (!made) throw new Error('No such account');
    return made;
  }

  /**
   * Verify registration response and save credential
   */
  async verifyRegistrationResponse(
    userId: number,
    response: RegistrationResponseJSON,
    expectedChallenge: string,
    deviceName?: string,
    /** The browser session the registration came from: it must still stand when the passkey is saved. */
    sessionId?: number
  ): Promise<{ verified: boolean; credentialId?: string; reason?: PasskeyFailure }> {
    try {
      const opts: VerifyRegistrationResponseOpts = {
        response,
        expectedChallenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpID,
        requireUserVerification: this.config.userVerification === 'required',
      };

      // The library throws on a response that doesn't verify (wrong challenge, origin,
      // no user verification, ...): that is the client's failure, not the server's.
      let verification: VerifiedRegistrationResponse;
      try {
        verification = await verifyRegistrationResponse(opts);
      } catch (err) {
        logger.warn({ userId, err }, 'Passkey registration response did not verify');
        return refusedFor(err);
      }

      if (!verification.verified || !verification.registrationInfo) {
        logger.warn({ userId }, 'Registration verification failed');
        return { verified: false };
      }

      const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
        verification.registrationInfo;

      // credential.id is ALREADY a base64url-encoded STRING from SimpleWebAuthn library
      // credential.publicKey is a Uint8Array that needs encoding
      const credentialIdBase64url = credential.id;
      const publicKeyBase64url = Buffer.from(credential.publicKey).toString('base64url');

      // Whether the browser says it made the passkey discoverable (credProps; unsigned, so
      // only a boolean counts). Without an answer it is: the options required one.
      const rk: unknown = (response as { clientExtensionResults?: { credProps?: { rk?: unknown } } })
        .clientExtensionResults?.credProps?.rk;
      const discoverable = typeof rk === 'boolean' ? rk : true;

      // Save credential to database
      const savedCredentialId = await this.saveCredential(
        userId,
        sessionId,
        {
          credentialId: credentialIdBase64url,
          publicKey: publicKeyBase64url,
          counter: credential.counter,
          // Unsigned, and whatever the browser sent: only the known ones are kept, and
          // anything but a list is no list (it used to reach the insert, a 500).
          transports: Array.isArray(credential.transports) ? knownTransports(credential.transports) : undefined,
          aaguid: Buffer.from(aaguid).toString('hex'),
          credentialDeviceType,
          credentialBackedUp,
          discoverable,
        },
        deviceName
      );
      if (savedCredentialId === null) {
        logger.warn({ userId }, 'Passkey not saved: the account or its session ended while it was registered');
        return { verified: false, reason: 'credential_ended' };
      }

      // What the browser said (rk, none when it gave no answer), stored as it said it.
      logger.info(
        { userId, credentialId: savedCredentialId, deviceType: credentialDeviceType, backedUp: credentialBackedUp, rk: typeof rk === 'boolean' ? rk : null, discoverable },
        'Successfully registered passkey'
      );

      return { verified: true, credentialId: savedCredentialId };
    } catch (error) {
      logger.error({ userId, err: error }, 'Failed to verify registration response');
      throw new Error('Failed to verify registration', { cause: error });
    }
  }

  /**
   * Options for a passkey sign-in: the same for everyone, whoever asks and whatever
   * email they typed, since none is asked for. No allowCredentials: the browser offers the
   * passkeys it has for this site, and the one that answers says whose it is.
   */
  async generateSignInOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    try {
      const options = await generateAuthenticationOptions({
        rpID: this.config.rpID,
        timeout: CEREMONY_TTL_MS, // 5 minutes, for mobile; the challenge lasts as long
        // 'required' unless WEBAUTHN_USER_VERIFICATION=preferred: a passkey replaces
        // the password, so it must prove the user, not only the device.
        userVerification: this.config.userVerification,
      });
      logger.info('Generated authentication options');
      return options;
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate authentication options');
      throw new Error('Failed to generate authentication options', { cause: error });
    }
  }

  /**
   * Options for a signed-in user to confirm it's them with a passkey (step-up): their own
   * passkeys, each with the transports it is known by. Listing them leaks nothing: they are
   * signed in. Null when they have none.
   */
  async generateReauthenticationOptions(userId: number): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
    const credentials = await this.getUserCredentials(userId);
    if (credentials.length === 0) return null;
    const opts: GenerateAuthenticationOptionsOpts = {
      rpID: this.config.rpID,
      timeout: CEREMONY_TTL_MS,
      userVerification: this.config.userVerification,
      allowCredentials: credentials.map((cred) => ({
        id: cred.credential_id, // base64url string, don't convert to Buffer
        // Only the ones it is known by: given none, the browser tries every way it has.
        ...(cred.transports && { transports: cred.transports }),
      })),
    };
    return generateAuthenticationOptions(opts);
  }

  /**
   * Check a sign-in's passkey: nobody is identified beforehand, so the passkey must
   * be a stored one that signed the challenge, name the user handle it is stored with, and
   * belong to an account that may sign in. Every refusal (an unknown or removed passkey, a
   * wrong signature, counter or handle, a sign-in-disabled account) answers the same, after
   * the same work: one read, then the signature check. A locked account's own passkey, once
   * all of that has verified, is `account_locked`, as its correct password is
   * told; after the same work, and nothing is written.
   */
  verifySignIn(response: AuthenticationResponseJSON, expectedChallenge: string): Promise<PasskeyAssertionResult> {
    return this.verifyAssertion(response, expectedChallenge, { signIn: true });
  }

  /**
   * Check a re-authentication's passkey: one of `userId`'s own, that signed the challenge,
   * and, if it names a user handle (a passkey that isn't discoverable may not), the one it
   * is stored with.
   */
  async verifyReauthentication(
    userId: number,
    response: AuthenticationResponseJSON,
    expectedChallenge: string
  ): Promise<{ verified: boolean; reason?: PasskeyFailure }> {
    const result = await this.verifyAssertion(response, expectedChallenge, { userId });
    return result.verified ? { verified: true } : result;
  }

  private async verifyAssertion(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    expected: AssertionFor
  ): Promise<PasskeyAssertionResult> {
    try {
      const credentialId = typeof response.id === 'string' ? asStoredCredentialId(response.id) : '';
      const handle = presentedUserHandle(response);

      // One read: the passkey and its account. Not found, the assertion is checked against a
      // key nothing can sign for, so it is refused as a wrong signature is (or, failing an
      // earlier check, such as user verification, as a stored passkey would be). An id that
      // isn't base64url (a NUL byte, say, which Postgres can't take) is no stored passkey's.
      const found = isStorableCredentialId(credentialId)
        ? await this.findCredentialForAssertion(credentialId)
        : undefined;

      const opts: VerifyAuthenticationResponseOpts = {
        response,
        expectedChallenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpID,
        credential: found
          ? {
              id: found.credential.credential_id,
              publicKey: Buffer.from(found.credential.public_key, 'base64url'),
              // 0: the library would refuse a counter that didn't grow before it checks the
              // signature, a quicker refusal than the others. The counter is checked below,
              // after the signature, as every refusal is.
              counter: 0,
              ...(found.credential.transports && { transports: found.credential.transports }),
            }
          : { id: credentialId, publicKey: UNMATCHABLE_PUBLIC_KEY, counter: 0 },
        requireUserVerification: this.config.userVerification === 'required',
      };

      // The library throws on an assertion that doesn't verify (wrong challenge, origin,
      // signature or counter, no user verification): a failed sign-in, not a server error.
      let verification: VerifiedAuthenticationResponse;
      try {
        verification = await verifyAuthenticationResponse(opts);
      } catch (err) {
        logger.warn({ err, credentialId }, 'Passkey assertion did not verify');
        return refusedFor(err);
      }

      if (!verification.verified || !found) {
        logger.warn({ credentialId, stored: !!found }, 'Authentication verification failed');
        return REFUSED;
      }
      const { credential, account } = found;
      const newCounter = verification.authenticationInfo.newCounter;
      if (!counterMayFollow(credential.counter, newCounter)) {
        logger.warn({ userId: credential.user_id, credentialId }, 'Passkey assertion counter did not grow');
        return REFUSED;
      }

      // The user handle (WebAuthn §7.2 step 6). A sign-in must name one: a passkey that
      // answers a request listing none is discoverable, and those do. Named, it must be the
      // one the passkey is stored with. A passkey registered before v2.2.0 has none stored
      // until it is first used since, and keeps the one it names then (recordUse).
      if (handle === null || (expected.signIn && handle === undefined)) {
        logger.warn({ userId: credential.user_id, credentialId }, 'Passkey assertion named no usable user handle');
        return REFUSED;
      }
      if (handle !== undefined && credential.user_handle !== undefined && handle !== credential.user_handle) {
        logger.warn({ userId: credential.user_id, credentialId }, 'Passkey assertion named another user handle');
        return REFUSED;
      }
      if (expected.signIn) {
        // The account's own passkey, verified to here (signature, counter, user handle): a
        // locked account is told so, as its correct password is, and locked
        // comes first, as for the password. Set up for automation only, it is refused as a
        // wrong passkey is. Neither records the use.
        if (account.isLocked || account.loginDisabled) {
          logger.warn(
            { userId: credential.user_id, locked: account.isLocked, loginDisabled: account.loginDisabled },
            'Passkey sign-in refused: the account may not sign in'
          );
          return account.isLocked ? ACCOUNT_LOCKED : REFUSED;
        }
      } else if (credential.user_id !== expected.userId) {
        logger.warn({ userId: expected.userId }, 'Passkey assertion is another user’s passkey');
        return REFUSED;
      }

      if (!(await this.recordUse(credential.id, newCounter, handle, expected.signIn === true))) {
        // Removed meanwhile, a concurrent use counted past this one, or a concurrent first
        // use stored another handle for it.
        logger.warn({ userId: credential.user_id, credentialId }, 'Passkey changed while it was checked');
        return REFUSED;
      }

      logger.info({ userId: credential.user_id, credentialId }, 'Successfully authenticated with passkey');

      return {
        verified: true,
        account: { id: credential.user_id, email: account.email, passwordChangedAt: account.passwordChangedAt },
      };
    } catch (error) {
      logger.error({ err: error }, 'Failed to verify authentication response');
      throw new Error('Failed to verify authentication', { cause: error });
    }
  }

  /**
   * Get all credentials for a user
   */
  async getUserCredentials(userId: number): Promise<PasskeyCredential[]> {
    const rows = await db
      .selectFrom('passkey_credentials')
      .select(CREDENTIAL_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();

    return rows.map(mapCredentialRow);
  }

  /** A stored passkey, by its (base64url) credential id, with what a sign-in needs of its account. */
  private async findCredentialForAssertion(credentialId: string): Promise<
    | {
        credential: PasskeyCredential;
        account: { email: string; isLocked: boolean; loginDisabled: boolean; passwordChangedAt: Date | null };
      }
    | undefined
  > {
    const row = await db
      .selectFrom('passkey_credentials')
      .innerJoin('users', 'users.id', 'passkey_credentials.user_id')
      .select(CREDENTIAL_COLUMNS.map((column) => `passkey_credentials.${column}` as const))
      .select(['users.email', 'users.is_locked', 'users.login_disabled', 'users.password_changed_at'])
      .where('passkey_credentials.credential_id', '=', credentialId)
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      credential: mapCredentialRow(row),
      account: {
        email: row.email,
        isLocked: row.is_locked,
        loginDisabled: row.login_disabled,
        passwordChangedAt: row.password_changed_at ?? null,
      },
    };
  }

  /**
   * Save a registered passkey, under the user's row lock and only if the account and the
   * session the registration came from still stand: a password change or
   * reset (which ends the sessions, and a reset the passkeys) or a lock that committed
   * while the ceremony ran is seen here, and one that hasn't run yet waits for this
   * insert, then removes or outlives it as it does any passkey. Null when refused.
   */
  private async saveCredential(
    userId: number,
    sessionId: number | undefined,
    credential: {
      credentialId: string;
      publicKey: string;
      counter: number;
      // The known ones the authenticator reported (simplewebauthn 14 passes on any string).
      // Each is stored as null when absent or undefined.
      transports?: KnownTransport[] | undefined;
      aaguid?: string;
      credentialDeviceType?: string;
      credentialBackedUp?: boolean;
      discoverable: boolean;
    },
    deviceName?: string
  ): Promise<string | null> {
    return db.transaction().execute(async (trx) => {
      const user = await lockUserForNewCredential(trx, userId);
      if (!user || user.is_locked) return null;
      if (sessionId !== undefined && !(await sessionService.sessionStillStands(trx, sessionId))) return null;
      // The handle the registration's options gave the passkey: the account's, which
      // never changes once made.
      const account = await trx.selectFrom('users').select('webauthn_user_id').where('id', '=', userId).executeTakeFirst();
      const inserted = await trx
        .insertInto('passkey_credentials')
        .values({
          user_id: userId,
          credential_id: credential.credentialId,
          public_key: credential.publicKey,
          counter: credential.counter,
          device_name: deviceName ?? null,
          transports: credential.transports ?? null,
          aaguid: credential.aaguid ?? null,
          credential_device_type: credential.credentialDeviceType ?? null,
          credential_backed_up: credential.credentialBackedUp ?? null,
          user_handle: account?.webauthn_user_id ?? null,
          discoverable: credential.discoverable,
        })
        .returning('credential_id')
        .executeTakeFirstOrThrow();

      return inserted.credential_id;
    });
  }

  /**
   * After a passkey has signed in or re-authenticated: its new counter and last use, and,
   * for one registered before v2.2.0, the user handle it named, kept from now on. A sign-in
   * also shows it is discoverable (it answered a request that listed no passkeys). False
   * when the passkey is gone, a concurrent use already stored a counter this one doesn't
   * follow, or it already holds another handle (a concurrent first use).
   */
  private async recordUse(
    credentialDbId: number,
    newCounter: number,
    handle: string | undefined,
    signedIn: boolean
  ): Promise<boolean> {
    let update = db
      .updateTable('passkey_credentials')
      .set({
        counter: newCounter,
        last_used_at: sql<Date>`NOW()`,
        ...(handle !== undefined && { user_handle: sql<string>`COALESCE(user_handle, ${handle})` }),
        ...(signedIn && { discoverable: true }),
      })
      .where('id', '=', credentialDbId)
      // As counterMayFollow, against the stored counter as it is now.
      // (counter is a bigint, which pg reads and writes as a string).
      .where('counter', newCounter === 0 ? '=' : '<', String(newCounter));
    if (handle !== undefined) {
      update = update.where((eb) => eb.or([eb('user_handle', 'is', null), eb('user_handle', '=', handle)]));
    }
    return (await update.returning('id').executeTakeFirst()) !== undefined;
  }

  /**
   * A user's passkeys, newest first, as their list shows them (the owner's, or an admin's
   * view): `discoverable` true for one {@link knownDiscoverable}, else as stored.
   */
  async listPasskeys(userId: number): Promise<PasskeySummary[]> {
    const [credentials, account] = await Promise.all([
      this.getUserCredentials(userId),
      db.selectFrom('users').select('webauthn_user_id').where('id', '=', userId).executeTakeFirst(),
    ]);
    const accountHandle = account?.webauthn_user_id ?? null;
    return credentials.map((cred) => ({
      id: cred.credential_id,
      deviceName: cred.device_name,
      deviceType: cred.credential_device_type,
      backedUp: cred.credential_backed_up,
      lastUsed: cred.last_used_at,
      createdAt: cred.created_at,
      discoverable: knownDiscoverable(cred, accountHandle) ? true : (cred.discoverable ?? null),
    }));
  }

  /**
   * The relying party (WEBAUTHN_RP_ID), which a page needs to tell the browser a passkey is gone
   * (`PublicKeyCredential.signalUnknownCredential`).
   */
  get relyingPartyId(): string {
    return this.config.rpID;
  }

  /**
   * Remove one of `userId`'s passkeys: 404 PASSKEY_NOT_FOUND unless they have one with this
   * credential id (another user's included, and an id no passkey can have, before any query).
   */
  async removePasskey(userId: number, credentialId: string): Promise<void> {
    if (!isStorableCredentialId(credentialId) || !(await this.deleteCredential(userId, credentialId))) {
      throw PasskeyError.notFound();
    }
  }

  /** Rename one of `userId`'s passkeys: 404 PASSKEY_NOT_FOUND as {@link removePasskey}. */
  async renamePasskey(userId: number, credentialId: string, deviceName: string): Promise<void> {
    if (!isStorableCredentialId(credentialId) || !(await this.updateCredentialName(userId, credentialId, deviceName))) {
      throw PasskeyError.notFound();
    }
  }

  /**
   * Delete a credential
   */
  private async deleteCredential(
    userId: number,
    credentialId: string
  ): Promise<boolean> {
    const rows = await db
      .deleteFrom('passkey_credentials')
      .where('user_id', '=', userId)
      .where('credential_id', '=', credentialId)
      .returning('id')
      .execute();

    const deleted = rows.length > 0;

    if (deleted) {
      logger.info({ userId, credentialId }, 'Deleted passkey credential');
    }

    return deleted;
  }

  /**
   * Update credential device name
   */
  private async updateCredentialName(
    userId: number,
    credentialId: string,
    deviceName: string
  ): Promise<boolean> {
    const rows = await db
      .updateTable('passkey_credentials')
      .set({ device_name: deviceName })
      .where('user_id', '=', userId)
      .where('credential_id', '=', credentialId)
      .returning('id')
      .execute();

    return rows.length > 0;
  }
}

export const passkeyService = new PasskeyService();
