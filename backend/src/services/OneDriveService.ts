import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { globalDb } from '../db/withTenant.js';
import { Client } from '@microsoft/microsoft-graph-client';
import fetch from 'isomorphic-fetch';
import logger from '../utils/logger.js';
import { deriveKey, keyIdOf, seal, open, AAD, DOMAIN } from '../utils/crypto-envelope.js';
import { readDataEncryptionSecretSync } from '../utils/data-encryption-secret.js';
import { EncryptionService, EncryptionKeyUnavailableError } from './EncryptionService.js';
import { readSystemSettings, writeSystemSetting } from './systemSettings.js';
import { existsSync, readdirSync, statSync, promises as fsp } from 'fs';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { config } from '../config.js';
import { envSecret } from '../utils/docker-secrets.js';

const __dirname = getDirname(import.meta.url);

interface OneDriveStatus {
  connected: boolean;
  autoSyncEnabled?: boolean;
  folderPath?: string;
  // pg returns timestamp columns as Date; serialized to an ISO string in JSON responses.
  expiresAt?: Date | string;
  email?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

/**
 * OAuth `state` values handed out by getAuthorizationUrl and not yet used. Each is a
 * random nonce for one user, good once and for ten minutes. Before, the state
 * was the encrypted user id, which never expired and could be replayed. Kept in this
 * process: a connect has to finish on the server that started it.
 */
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingAuthStates = new Map<string, { userId: number; expiresAt: number }>();

/** This server's OAuth callback (DOMAIN_URL's `/api/onedrive/callback`), or '' without a DOMAIN_URL. */
function defaultRedirectUri(): string {
  const domain = config().DOMAIN_URL;
  if (!domain) return '';
  try {
    return new URL('/api/onedrive/callback', domain).href;
  } catch {
    return '';
  }
}

/**
 * OneDrive, where backups are copied: the app registration (system_settings, encrypted)
 * and each deployment admin's tokens (onedrive_tokens). Both are control-plane tables,
 * read and written on globalDb; one instance is shared by the routes and the backup
 * scheduler (routes/dependencies.ts, index.ts).
 */
export class OneDriveService {
  private readonly db: Kysely<DB>;
  /**
   * The AES-256 key the stored tokens are sealed with, derived from the data encryption
   * secret via HKDF and used with the shared authenticated-encryption envelope,
   * and the secret's key id, written into what it seals. Read when first needed,
   * not at construction: the routes build this service at startup, and a server without
   * the secret serves on without OneDrive (productionConfig.ts) rather than not start.
   */
  private tokenKeyCache: { key: Buffer; keyId: number } | null = null;

  /** @param options.db where its rows are: globalDb, or a test's stand-in. */
  constructor(options: { db?: Kysely<DB> | undefined } = {}) {
    this.db = options.db ?? globalDb;
  }

  /**
   * The token key (see tokenKeyCache): from the data encryption secret (the same secret
   * backups use), else, for development, the ENCRYPTION_KEY variable. Throws
   * EncryptionKeyUnavailableError (a 503) when there is neither, or the variable is too short.
   */
  private tokenKey(): { key: Buffer; keyId: number } {
    if (this.tokenKeyCache) return this.tokenKeyCache;
    let material: string | Buffer;
    try {
      material = readDataEncryptionSecretSync();
      logger.info('OneDrive encryption key loaded from Docker secret');
    } catch (secretError) {
      const encryptionKeyEnv = envSecret('ENCRYPTION_KEY');
      if (!encryptionKeyEnv) {
        logger.error({ err: secretError }, 'OneDrive is unavailable: there is no data encryption key to seal its tokens with');
        throw new EncryptionKeyUnavailableError({ cause: secretError });
      }
      // In development, assume it's a hex string or UTF-8 string.
      material = encryptionKeyEnv.length === 64
        ? Buffer.from(encryptionKeyEnv, 'hex')  // 64 hex chars = 32 bytes
        : Buffer.from(encryptionKeyEnv, 'utf8');  // Direct string
      if (material.length < 32) {
        const tooShort = new Error(`Encryption key must be at least 32 bytes (found ${material.length})`);
        logger.error({ err: tooShort }, 'OneDrive is unavailable: ENCRYPTION_KEY is too short to seal its tokens with');
        throw new EncryptionKeyUnavailableError({ cause: tooShort });
      }
      logger.warn('OneDrive using environment variable for encryption (development mode)');
    }
    this.tokenKeyCache = { key: deriveKey(material, DOMAIN.onedrive), keyId: keyIdOf(material) };
    return this.tokenKeyCache;
  }

  /**
   * Throws EncryptionKeyUnavailableError (a 503) when there is no key to seal tokens with:
   * before connecting, so nobody is sent to Microsoft for tokens this server can't keep.
   */
  public assertTokenKeyAvailable(): void {
    this.tokenKey();
  }

  /**
   * Resolve the OneDrive app-registration config: what the Backup page saved in
   * `system_settings`, and nothing else. A secret is never read from the environment, so a
   * deployment's variables can't hold it. The client id and secret are encrypted at rest
   * (credential-domain key, like the SMTP password / SimpleFin access URL); the redirect URI
   * is non-secret plaintext, and until one is saved it is this server's own callback
   * (DOMAIN_URL's `/api/onedrive/callback`), the address the app registration needs.
   */
  private async resolveClientConfig(): Promise<{ clientId: string; clientSecret: string; redirectUri: string }> {
    let clientId = '';
    let clientSecret = '';
    let redirectUri = defaultRedirectUri();
    try {
      const stored = await readSystemSettings(['onedrive_client_id', 'onedrive_client_secret', 'onedrive_redirect_uri'] as const, this.db);
      const enc = new EncryptionService();
      if (stored.onedrive_client_id) clientId = await enc.decryptString(stored.onedrive_client_id);
      if (stored.onedrive_client_secret) clientSecret = await enc.decryptString(stored.onedrive_client_secret);
      if (stored.onedrive_redirect_uri) redirectUri = stored.onedrive_redirect_uri;
    } catch (err) {
      logger.error({ err }, 'Failed to load the saved OneDrive app registration');
    }
    return { clientId, clientSecret, redirectUri };
  }

  /**
   * Check if OneDrive is configured (a client id and secret saved on the Backup page).
   */
  public async isConfigured(): Promise<boolean> {
    const { clientId, clientSecret } = await this.resolveClientConfig();
    return !!(clientId && clientSecret);
  }

  /**
   * Non-secret view of the OneDrive app registration for the settings UI.
   * Never returns the client secret — only whether one is set.
   */
  public async getClientConfig(): Promise<{ clientId: string; redirectUri: string; clientSecretSet: boolean }> {
    const { clientId, clientSecret, redirectUri } = await this.resolveClientConfig();
    return { clientId, redirectUri, clientSecretSet: !!clientSecret };
  }

  /**
   * Persist the OneDrive app-registration settings into `system_settings`.
   * Client id + secret are encrypted (credential domain); the redirect URI is
   * non-secret. An omitted/empty `clientSecret` leaves the stored secret
   * untouched (so the UI never has to round-trip it).
   */
  public async saveClientConfig(input: { clientId: string; clientSecret?: string | null | undefined; redirectUri: string }): Promise<void> {
    const enc = new EncryptionService();
    const upsert = (key: string, value: string) => writeSystemSetting(key, value, { category: 'backup' }, this.db);
    await upsert('onedrive_client_id', await enc.encryptString(input.clientId));
    await upsert('onedrive_redirect_uri', input.redirectUri);
    if (input.clientSecret) {
      await upsert('onedrive_client_secret', await enc.encryptString(input.clientSecret));
    }
  }

  /**
   * Generate OAuth authorization URL
   */
  public async getAuthorizationUrl(userId: number): Promise<string> {
    const { clientId, clientSecret, redirectUri } = await this.resolveClientConfig();
    if (!clientId || !clientSecret) {
      throw new Error('OneDrive not configured');
    }

    const now = Date.now();
    for (const [key, entry] of pendingAuthStates) {
      if (entry.expiresAt <= now) pendingAuthStates.delete(key);
    }
    const state = randomBytes(32).toString('base64url');
    pendingAuthStates.set(state, { userId, expiresAt: now + AUTH_STATE_TTL_MS });
    const scopes = ['Files.ReadWrite', 'Files.ReadWrite.All', 'offline_access', 'User.Read'].join(' ');

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: scopes,
      state: state
    });

    return `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /**
   * The user an OAuth `state` was issued to, or null if it is unknown, expired or
   * already used. Each state works once.
   */
  public static consumeAuthState(state: string): number | null {
    const entry = pendingAuthStates.get(state);
    if (!entry) return null;
    pendingAuthStates.delete(state);
    return entry.expiresAt > Date.now() ? entry.userId : null;
  }

  /**
   * Exchange authorization code for access token
   */
  public async exchangeCodeForTokens(code: string, userId: number): Promise<void> {
    // Before Microsoft hands over tokens this server couldn't keep.
    this.assertTokenKeyAvailable();
    const { clientId, clientSecret, redirectUri } = await this.resolveClientConfig();
    if (!clientId || !clientSecret) {
      throw new Error('OneDrive not configured');
    }

    try {
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      const response = await this.fetchWithRetry('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      }, 'onedrive-token-exchange');

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ statusCode: response.status, error: errorText }, 'Failed to exchange code for tokens');
        throw new Error(`OAuth token exchange failed: ${response.statusText}`);
      }

      const tokens = await response.json() as TokenResponse;
      
      // Calculate expiration timestamp
      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));
      
      // Encrypt tokens before storage
      const encryptedAccessToken = this.encrypt(tokens.access_token);
      const encryptedRefreshToken = this.encrypt(tokens.refresh_token);
      
      // Store in database (upsert)
      await this.db
        .insertInto('onedrive_tokens')
        .values({
          user_id: userId,
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          expires_at: expiresAt,
          folder_path: '/Backups/Nuggets',
          auto_sync_enabled: true,
        })
        .onConflict((oc) => oc.column('user_id').doUpdateSet((eb) => ({
          access_token: eb.ref('excluded.access_token'),
          refresh_token: eb.ref('excluded.refresh_token'),
          expires_at: eb.ref('excluded.expires_at'),
          updated_at: sql<Date>`CURRENT_TIMESTAMP`,
        })))
        .execute();

      logger.info({ userId }, 'OneDrive tokens stored successfully');

      // Create OneDrive folder structure
      await this.ensureFolderStructure(userId);

      // Backfill existing local backups to OneDrive in the BACKGROUND. This can
      // be dozens of files (minutes of uploads); awaiting it here would block
      // the OAuth callback and leave the user's browser on a blank "waiting for
      // nuggets…" page the whole time. The connection is already complete once
      // the tokens are stored, so kick the backfill off fire-and-forget.
      void this.uploadAllExistingBackups(userId).catch((err) => {
        logger.error({ err, userId }, 'Background OneDrive backfill of existing backups failed');
      });
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to exchange code for tokens');
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   */
  private async refreshAccessToken(userId: number): Promise<string> {
    try {
      const tokenRow = await this.db
        .selectFrom('onedrive_tokens')
        .select('refresh_token')
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (!tokenRow) {
        throw new Error('No OneDrive tokens found for user');
      }

      const encryptedRefreshTokenFromDb = tokenRow.refresh_token;
      const refreshToken = this.decrypt(encryptedRefreshTokenFromDb);

      const { clientId, clientSecret } = await this.resolveClientConfig();
      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      const response = await this.fetchWithRetry('https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      }, 'onedrive-token-refresh');

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.statusText}`);
      }

      const tokens = await response.json() as TokenResponse;
      const expiresAt = new Date(Date.now() + (tokens.expires_in * 1000));
      
      const encryptedAccessToken = this.encrypt(tokens.access_token);
      const encryptedRefreshTokenNew = tokens.refresh_token ? this.encrypt(tokens.refresh_token) : encryptedRefreshTokenFromDb;

      await this.db
        .updateTable('onedrive_tokens')
        .set({
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshTokenNew,
          expires_at: expiresAt,
          updated_at: sql<Date>`CURRENT_TIMESTAMP`,
        })
        .where('user_id', '=', userId)
        .execute();

      logger.info({ userId }, 'OneDrive tokens refreshed successfully');

      return tokens.access_token;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to refresh OneDrive tokens');
      throw error;
    }
  }

  /**
   * Get valid access token (refresh if expired)
   */
  private async getValidAccessToken(userId: number): Promise<string> {
    const row = await this.db
      .selectFrom('onedrive_tokens')
      .select(['access_token', 'expires_at'])
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (!row) {
      throw new Error('No OneDrive connection found');
    }

    const { access_token: encryptedAccessToken, expires_at: expiresAt } = row;
    const expirationDate = new Date(expiresAt);
    const now = new Date();

    // Refresh if token expires in next 5 minutes
    if (expirationDate.getTime() - now.getTime() < 5 * 60 * 1000) {
      logger.info({ userId }, 'Access token expiring soon, refreshing...');
      return await this.refreshAccessToken(userId);
    }

    return this.decrypt(encryptedAccessToken);
  }

  /**
   * Get Microsoft Graph client with authentication
   */
  private async getGraphClient(userId: number): Promise<Client> {
    const accessToken = await this.getValidAccessToken(userId);
    
    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });
  }

  /**
   * Ensure /Backups/Nuggets folder structure exists
   */
  private async ensureFolderStructure(userId: number): Promise<void> {
    try {
      const client = await this.getGraphClient(userId);
      
      // Create /Backups folder
      try {
        await client.api('/me/drive/root:/Backups').get();
        logger.info({ userId }, 'Backups folder already exists');
      } catch {
        await client.api('/me/drive/root/children').post({
          name: 'Backups',
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        });
        logger.info({ userId }, 'Created Backups folder');
      }

      // Create /Backups/Nuggets folder
      try {
        await client.api('/me/drive/root:/Backups/Nuggets').get();
        logger.info({ userId }, 'Nuggets folder already exists');
      } catch {
        await client.api('/me/drive/root:/Backups:/children').post({
          name: 'Nuggets',
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        });
        logger.info({ userId }, 'Created Nuggets folder');
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to ensure folder structure');
      throw error;
    }
  }

  /**
   * Upload a file to OneDrive (Backups/Nuggets/{fileName}).
   *
   * Files up to ~200MB use Graph's simple `:/content` upload (streamed, not
   * buffered). Larger files use a resumable upload SESSION with chunked PUTs,
   * since the simple upload caps out around 250MB. Either way the whole file is
   * never held in memory at once.
   */
  public async uploadFile(userId: number, filePath: string, fileName: string): Promise<void> {
    const { size } = statSync(filePath);
    const SIMPLE_UPLOAD_MAX_BYTES = 200 * 1024 * 1024; // margin under Graph's ~250MB simple limit

    if (size <= SIMPLE_UPLOAD_MAX_BYTES) {
      await this.uploadSimple(userId, filePath, fileName);
    } else {
      await this.uploadLargeFile(userId, filePath, fileName, size);
    }
  }

  /**
   * Simple single-request upload for files within Graph's size limit (≤200MB,
   * gated by the caller). The file is read with async readFile into a Buffer —
   * deliberately NOT a stream: the Graph SDK's putStream sends the body via
   * Node's undici fetch, which throws "duplex option is required when sending a
   * body" for ReadableStream bodies, whereas a Buffer body works. Async readFile
   * also keeps the event loop unblocked (vs the old readFileSync); the buffer is
   * bounded because larger files use the chunked upload session instead.
   */
  private async uploadSimple(userId: number, filePath: string, fileName: string): Promise<void> {
    const client = await this.getGraphClient(userId);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const content = await fsp.readFile(filePath);
        await client.api(`/me/drive/root:/Backups/Nuggets/${fileName}:/content`)
          .putStream(content);

        logger.info({ userId, fileName, attempt }, 'File uploaded to OneDrive successfully');
        return;
      } catch (error) {
        if (attempt === maxAttempts) {
          logger.error({ err: error, userId, fileName, attempts: maxAttempts }, 'Failed to upload file to OneDrive after retries');
          throw error;
        }
        const backoffMs = 1000 * 2 ** (attempt - 1); // 1s, 2s
        logger.warn({ err: error, userId, fileName, attempt, backoffMs }, 'OneDrive upload failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Resumable chunked upload for large files via a Graph upload session.
   * Reads and PUTs the file one bounded chunk at a time (never the whole file in
   * memory); chunk size is a multiple of 320 KiB, as Graph requires.
   */
  private async uploadLargeFile(userId: number, filePath: string, fileName: string, totalSize: number): Promise<void> {
    const client = await this.getGraphClient(userId);

    const session = await client
      .api(`/me/drive/root:/Backups/Nuggets/${fileName}:/createUploadSession`)
      .post({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } });
    const uploadUrl: string | undefined = session?.uploadUrl;
    if (!uploadUrl) {
      throw new Error('OneDrive did not return an upload session URL');
    }

    const chunkSize = 5 * 1024 * 1024; // 5 MiB = 16 × 320 KiB
    const fh = await fsp.open(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(chunkSize);
      let offset = 0;
      while (offset < totalSize) {
        const toRead = Math.min(chunkSize, totalSize - offset);
        const { bytesRead } = await fh.read(buffer, 0, toRead, offset);
        if (bytesRead <= 0) break;

        const start = offset;
        const end = offset + bytesRead - 1;

        // The session uploadUrl is pre-authenticated — no Authorization header.
        const res = await this.fetchWithRetry(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(bytesRead),
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          },
          body: buffer.subarray(0, bytesRead),
        }, `onedrive-chunk ${start}-${end}/${totalSize}`);

        // 202 = accepted (more chunks expected); 200/201 = upload complete.
        if (res.status !== 202 && res.status !== 200 && res.status !== 201) {
          const text = await res.text().catch(() => '');
          throw new Error(`OneDrive chunk upload failed (${res.status}): ${text}`);
        }
        offset += bytesRead;
      }
    } finally {
      await fh.close();
    }

    logger.info({ userId, fileName, totalSize }, 'Large file uploaded to OneDrive via upload session');
  }

  /**
   * fetch with bounded retry for transient failures (network errors, HTTP 429
   * and 5xx), honoring the Retry-After header on throttled responses.
   */
  private async fetchWithRetry(
    url: string,
    init: Parameters<typeof fetch>[1],
    label: string,
    maxAttempts = 4,
  ): Promise<Awaited<ReturnType<typeof fetch>>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, init);
        if ((response.status === 429 || response.status >= 500) && attempt < maxAttempts) {
          const waitMs = this.parseRetryAfterMs(response.headers.get('retry-after')) ?? 1000 * 2 ** (attempt - 1);
          logger.warn({ label, status: response.status, attempt, waitMs }, 'Transient OneDrive response, retrying');
          await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30000)));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        const waitMs = 1000 * 2 ** (attempt - 1);
        logger.warn({ label, err: error, attempt, waitMs }, 'OneDrive request failed, retrying');
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError ?? new Error(`${label}: request failed after ${maxAttempts} attempts`);
  }

  /** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
  private parseRetryAfterMs(header: string | null): number | null {
    if (!header) return null;
    const seconds = Number(header);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
  }

  /**
   * Upload all existing backups (called during initial connection)
   */
  private async uploadAllExistingBackups(userId: number): Promise<void> {
    try {
      const backupsPath = config().BACKUPS_PATH || path.join(__dirname, '../../backups');

      if (!existsSync(backupsPath)) {
        logger.info({ userId }, 'No backups directory found, skipping initial upload');
        return;
      }

      // Backups are written as encrypted .enc archives (see BackupService).
      const files = readdirSync(backupsPath).filter(f => f.endsWith('.enc'));
      
      if (files.length === 0) {
        logger.info({ userId }, 'No backup files found to upload');
        return;
      }

      logger.info({ userId, count: files.length }, 'Uploading existing backups to OneDrive...');

      let uploaded = 0;
      let skipped = 0;
      for (const fileName of files) {
        try {
          // Skip files already in OneDrive so a reconnect doesn't re-upload the
          // entire backup history every time.
          if (await this.fileExists(userId, fileName)) {
            skipped++;
            continue;
          }
          const filePath = path.join(backupsPath, fileName);
          await this.uploadFile(userId, filePath, fileName);
          uploaded++;
        } catch (error) {
          logger.error({ err: error, fileName }, 'Failed to upload backup file, continuing...');
        }
      }

      logger.info({ userId, total: files.length, uploaded, skipped }, 'Completed uploading existing backups');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed during initial backup upload');
      // Don't throw - this is non-critical
    }
  }

  /**
   * Get OneDrive connection status
   */
  public async getStatus(userId: number): Promise<OneDriveStatus> {
    try {
      const row = await this.db
        .selectFrom('onedrive_tokens')
        .select(['auto_sync_enabled', 'folder_path', 'expires_at'])
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (!row) {
        return { connected: false };
      }

      const { auto_sync_enabled, folder_path, expires_at } = row;

      // Get user's email from Microsoft Graph
      let email: string | undefined;
      try {
        const client = await this.getGraphClient(userId);
        const user = await client.api('/me').select('mail,userPrincipalName').get();
        email = user.mail || user.userPrincipalName;
      } catch (error) {
        logger.warn({ err: error, userId }, 'Failed to fetch user email from Microsoft Graph');
      }

      return {
        connected: true,
        ...(auto_sync_enabled != null && { autoSyncEnabled: auto_sync_enabled }),
        ...(folder_path != null && { folderPath: folder_path }),
        expiresAt: expires_at,
        ...(email !== undefined && { email }),
      };
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to get OneDrive status');
      throw error;
    }
  }

  /**
   * Update OneDrive settings
   */
  public async updateSettings(userId: number, autoSyncEnabled: boolean): Promise<void> {
    try {
      await this.db
        .updateTable('onedrive_tokens')
        .set({
          auto_sync_enabled: autoSyncEnabled,
          updated_at: sql<Date>`CURRENT_TIMESTAMP`,
        })
        .where('user_id', '=', userId)
        .execute();

      logger.info({ userId, autoSyncEnabled }, 'OneDrive settings updated');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to update OneDrive settings');
      throw error;
    }
  }

  /**
   * Disconnect OneDrive (delete tokens)
   */
  public async disconnect(userId: number): Promise<void> {
    try {
      await this.db
        .deleteFrom('onedrive_tokens')
        .where('user_id', '=', userId)
        .execute();
      logger.info({ userId }, 'OneDrive disconnected successfully');
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to disconnect OneDrive');
      throw error;
    }
  }

  /**
   * Get all user IDs that have auto-sync enabled
   */
  public async getUserIdsWithAutoSync(): Promise<number[]> {
    try {
      // Backups hold every organization's data, so they go only to deployment admins'
      // OneDrive, whatever was connected before that rule.
      const rows = await this.db
        .selectFrom('onedrive_tokens as t')
        .innerJoin('deployment_users as du', 'du.user_id', 't.user_id')
        .select('t.user_id')
        .where('t.auto_sync_enabled', '=', true)
        .where('du.role', '=', 'admin')
        .execute();
      return rows.map(row => row.user_id);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get users with auto-sync enabled');
      return [];
    }
  }

  /**
   * Check if auto-sync is enabled for user
   */
  public async isAutoSyncEnabled(userId: number): Promise<boolean> {
    try {
      const row = await this.db
        .selectFrom('onedrive_tokens')
        .select('auto_sync_enabled')
        .where('user_id', '=', userId)
        .executeTakeFirst();

      return row?.auto_sync_enabled === true;
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check auto-sync status');
      return false;
    }
  }

  /**
   * Encrypt a string into the shared authenticated-encryption envelope (v3, with the
   * key id), returned base64-encoded for storage.
   */
  private encrypt(text: string): string {
    const { key, keyId } = this.tokenKey();
    return seal(key, Buffer.from(text, 'utf8'), AAD.onedrive, keyId).toString('base64');
  }

  /**
   * Decrypt a value produced by {@link encrypt}. Values written by the previous
   * scheme (GCM `gcm:<hex>` or legacy CBC) lack the v2 version byte and throw a
   * clear "unsupported version" error — reconnect OneDrive to re-issue tokens.
   */
  private decrypt(text: string): string {
    return open(this.tokenKey().key, Buffer.from(text, 'base64'), AAD.onedrive).toString('utf8');
  }

  /**
   * Check if a file exists in OneDrive
   */
  public async fileExists(userId: number, fileName: string): Promise<boolean> {
    try {
      const client = await this.getGraphClient(userId);
      const folderPath = '/Backups/Nuggets';
      
      // Try to get the file metadata
      await client
        .api(`/me/drive/root:${folderPath}/${fileName}`)
        .get();
      
      return true;
    } catch (error) {
      // The Graph client's GraphError carries the HTTP status.
      if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404) {
        return false;
      }
      // Log other errors but don't throw
      logger.warn({ err: error, userId, fileName }, 'Error checking OneDrive file existence');
      return false;
    }
  }

  /**
   * Check multiple files existence in OneDrive (batch check)
   */
  public async checkFilesExistence(userId: number, fileNames: string[]): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    
    try {
      // Check if user has OneDrive connected
      const status = await this.getStatus(userId);
      if (!status.connected) {
        // Not connected, all files are not uploaded
        fileNames.forEach(name => result[name] = false);
        return result;
      }

      // Check each file (could be optimized with batch requests in future)
      for (const fileName of fileNames) {
        result[fileName] = await this.fileExists(userId, fileName);
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Failed to check OneDrive files existence');
      // Return all false if check fails
      fileNames.forEach(name => result[name] = false);
    }
    
    return result;
  }
}
