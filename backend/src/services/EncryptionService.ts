import * as fs from 'fs/promises';
import { createLogger } from '../utils/logger.js';
import { deriveKey, seal, open, envelopeKeyId, keyIdOf, AAD, DOMAIN } from '../utils/crypto-envelope.js';
import { readDataEncryptionSecret, DATA_ENCRYPTION_SECRET_PATH } from '../utils/data-encryption-secret.js';
import { errorMessage } from '../utils/errors.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { backupSigningKey } from '../utils/backupCrypto.js';

const logger = createLogger({ service: 'EncryptionService' });

/**
 * The `data_encryption_key` secret is missing or unusable: the deployment's to fix, not
 * the request's, so a route that needs it answers 503 rather than 500.
 */
export class EncryptionKeyUnavailableError extends ControlPlaneError {
  constructor(options?: ErrorOptions) {
    super(
      503,
      'ENCRYPTION_KEY_UNAVAILABLE',
      'This server has no data encryption key (the data_encryption_key secret), so this is unavailable. A deployment admin needs to configure it.'
    );
    this.name = 'EncryptionKeyUnavailableError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

export class EncryptionService {
  private encryptionKey?: string;
  private credentialKey?: Buffer;
  /** The secret's key id, written into every credential this seals. */
  private keyId?: number;

  /**
   * A service on a given secret rather than the Docker secret file: the rewrap-secrets
   * script's, for the old and the new key.
   */
  static withSecret(secret: string): EncryptionService {
    const service = new EncryptionService();
    service.useSecret(secret);
    return service;
  }

  private useSecret(secret: string): void {
    this.encryptionKey = secret;
    // Derive independent per-purpose AES-256 keys via HKDF.
    this.credentialKey = deriveKey(secret, DOMAIN.credential);
    this.keyId = keyIdOf(secret);
  }

  /**
   * Load the data-encryption secret from its Docker secret file, `data_encryption_key`
   * (see readDataEncryptionSecret), and derive the per-purpose keys.
   */
  private async loadEncryptionKey(): Promise<void> {
    try {
      this.useSecret(await readDataEncryptionSecret());

      logger.info({ keyId: this.keyId }, 'Data encryption key loaded from Docker secret');
    } catch (error) {
      // The setup steps go to the log, for whoever runs the deployment; the caller gets
      // a 503 that says what is missing, without the server's paths.
      logger.error(
        { err: error },
        `❌ Data encryption key not available: ${errorMessage(error)}\n\n` +
        '🔧 To enable backups/credential storage, provide the Docker secret ' +
        `(mounted at ${DATA_ENCRYPTION_SECRET_PATH}):\n` +
        '   1. Generate a key (any value >= 32 chars): openssl rand -base64 32\n' +
        '   2. Save to file: openssl rand -base64 32 | tr -d "\\n" > data_encryption_key.txt\n' +
        '   3. Wire it as the data_encryption_key secret in your compose file\n' +
        '   4. Restart services: docker-compose up -d\n\n' +
        '⚠️  Backups and stored credentials will be DISABLED until the secret is configured.',
      );
      throw new EncryptionKeyUnavailableError({ cause: error });
    }
  }

  /**
   * Initialize encryption service (async)
   */
  async initialize(): Promise<void> {
    if (!this.encryptionKey) {
      await this.loadEncryptionKey();
    }
  }

  /**
   * The key this server signs its backups with, derived from the data encryption secret.
   * A restore through the app accepts only backups signed with it.
   */
  async getBackupSigningKey(): Promise<Buffer> {
    await this.initialize();
    return backupSigningKey(this.encryptionKey!);
  }

  /**
   * Decrypt a file using the Docker secret key
   */
  async decryptFile(inputPath: string, outputPath: string): Promise<void> {
    await this.initialize();
    return this.decryptFileWithKey(inputPath, outputPath, this.encryptionKey!);
  }

  /**
   * Encrypt a file using a custom encryption key (the generated backup key K),
   * derived from the supplied key rather than the Docker secret. The key is trimmed so stray whitespace (e.g. a trailing
   * newline from a pasted/downloaded key file) can't change the derived key.
   */
  async encryptFileWithCustomKey(inputPath: string, outputPath: string, customKey: string): Promise<void> {
    const key = (customKey ?? '').trim();
    if (!key) {
      throw new Error('Custom encryption key is required');
    }
    if (key.length < 32) {
      throw new Error(`Encryption key must be at least 32 characters (found ${key.length})`);
    }
    try {
      const data = await fs.readFile(inputPath);
      const result = seal(deriveKey(key, DOMAIN.backup), data, AAD.backup);
      await fs.writeFile(outputPath, result);
    } catch (error) {
      throw new Error(`Encryption failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Decrypt a file using a custom encryption key (for restore operations).
   * The key is trimmed so a pasted/downloaded key with a trailing newline still
   * derives the same key it was encrypted with.
   */
  async decryptFileWithCustomKey(inputPath: string, outputPath: string, customKey: string): Promise<void> {
    const key = (customKey ?? '').trim();
    if (!key) {
      throw new Error('Custom encryption key is required');
    }

    if (key.length < 32) {
      throw new Error(`Encryption key must be at least 32 characters (found ${key.length})`);
    }

    return this.decryptFileWithKey(inputPath, outputPath, key);
  }

  /**
   * Encrypt a short UTF-8 string (e.g. a credential) for storage at rest.
   * Returns a base64 envelope of IV(16) + authTag(16) + ciphertext, decryptable
   * only with the same Docker-secret key. Uses a distinct AAD from file backups
   * so the two domains can't be cross-substituted.
   */
  async encryptString(plaintext: string): Promise<string> {
    await this.initialize();
    try {
      return seal(this.credentialKey!, Buffer.from(plaintext, 'utf8'), AAD.credential, this.keyId).toString('base64');
    } catch (error) {
      throw new Error(`String encryption failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Decrypt a base64 envelope produced by {@link encryptString} back to UTF-8.
   */
  async decryptString(ciphertext: string): Promise<string> {
    await this.initialize();
    const envelope = Buffer.from(ciphertext, 'base64');
    try {
      return open(this.credentialKey!, envelope, AAD.credential).toString('utf8');
    } catch (error) {
      const message = errorMessage(error);
      const sealedWith = envelopeKeyId(envelope);
      if (sealedWith !== null && sealedWith !== this.keyId) {
        // Saved under another data_encryption_key: the key was changed without
        // rewrap-secrets.
        throw new Error(
          `Failed to decrypt credential: it was encrypted with another data_encryption_key (key id ${sealedWith}; ` +
            `this server's is ${this.keyId}). Run rewrap-secrets with the old key.`,
          { cause: error }
        );
      }
      if (message.includes('bad decrypt') || message.includes('Unsupported state')) {
        throw new Error('Failed to decrypt credential: encryption key mismatch.', { cause: error });
      }
      throw new Error(`String decryption failed: ${message}`, { cause: error });
    }
  }

  /**
   * Internal method to decrypt with any key
   */
  private async decryptFileWithKey(inputPath: string, outputPath: string, key: string): Promise<void> {
    try {
      const encryptedData = await fs.readFile(inputPath);
      const decrypted = open(deriveKey(key, DOMAIN.backup), encryptedData, AAD.backup);
      await fs.writeFile(outputPath, decrypted);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('bad decrypt') || message.includes('Unsupported state')) {
        throw new Error('Invalid encryption key. Please check that you entered the correct key used when this backup was created.', { cause: error });
      }
      throw new Error(`Decryption failed: ${message}`, { cause: error });
    }
  }
}