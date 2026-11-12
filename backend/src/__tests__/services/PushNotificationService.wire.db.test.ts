import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, globalAgent, type Server } from 'node:https';
import { createECDH, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { globalDb } from '../../db/withTenant.js';
import { PushNotificationService } from '../../services/PushNotificationService.js';
import type { EncryptionService } from '../../services/EncryptionService.js';

// http_ece is web-push's own RFC 8188 implementation; here it plays the
// browser, decrypting what the real web-push send put on the wire.
const ece = createRequire(import.meta.url)('http_ece') as {
  decrypt(buffer: Buffer, params: { version: string; privateKey: unknown; authSecret: string }): Buffer;
};

const fakeEncryption = {
  encryptString: async (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`,
  decryptString: async (cipher: string) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString(),
} as unknown as EncryptionService;

/**
 * End to end through the real web-push library: no stubbing of the send. A
 * local HTTPS server with a throwaway self-signed certificate stands in for the
 * push service (web-push only speaks https; the endpoint allow-list is enforced
 * at the route, not here), and a P-256 key pair stands in for the browser's
 * subscription keys.
 */
describe('PushNotificationService on the wire', () => {
  let server: Server;
  let endpoint: string;
  const received: { headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
  let userId: number;
  let certDir: string;
  const trustedCas = globalAgent.options.ca;

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'push-wire-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
    ], { stdio: 'ignore' });
    // web-push sends through https' global agent: it trusts the stand-in's certificate, and
    // only that one, for this file (restored in afterAll). Certificates are still checked.
    globalAgent.options.ca = readFileSync(join(certDir, 'cert.pem'));

    server = createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    endpoint = `https://127.0.0.1:${port}/push/${Date.now()}`;

    const user = await globalDb.insertInto('users')
      .values({ email: `push-wire-${Date.now()}@test.local`, password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();
    userId = user.id;
  });

  afterAll(async () => {
    await globalDb.deleteFrom('push_subscriptions').where('user_id', '=', userId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
    await new Promise((resolve) => server.close(resolve));
    rmSync(certDir, { recursive: true, force: true });
    if (trustedCas === undefined) delete globalAgent.options.ca;
    else globalAgent.options.ca = trustedCas;
  });

  it('delivers an aes128gcm payload the subscriber can decrypt, signed with the stored VAPID key', async () => {
    const browserKeys = createECDH('prime256v1');
    browserKeys.generateKeys();
    const authSecret = randomBytes(16).toString('base64url');

    const service = new PushNotificationService(fakeEncryption);
    await service.subscribe(userId, {
      endpoint,
      keys: { p256dh: browserKeys.getPublicKey().toString('base64url'), auth: authSecret },
    }, null);

    const message = { title: 'Groceries is over budget', body: 'Spent $650.00 of $500.00.', url: '/budgets', tag: 't' };
    const result = await service.sendToUser(userId, message);
    expect(result).toEqual({ sent: 1, failed: 0, removed: 0 });

    const [request] = received;
    expect(request.headers['content-encoding']).toBe('aes128gcm');
    expect(request.headers.ttl).toBe(String(24 * 60 * 60));

    const plaintext = ece.decrypt(request.body, { version: 'aes128gcm', privateKey: browserKeys, authSecret });
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual(message);

    // Authorization: vapid t=<JWT>, k=<public key>. The push service checks the
    // JWT signature against k, and k must be the key the browser subscribed with.
    const auth = String(request.headers.authorization);
    const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/) ?? [];
    expect(k).toBe(await service.getPublicKey());

    const [header, claims, signature] = jwt.split('.');
    const publicKey = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: Buffer.from(k, 'base64url').subarray(1, 33).toString('base64url'), y: Buffer.from(k, 'base64url').subarray(33).toString('base64url') },
      format: 'jwk',
    });
    const verified = createVerify('SHA256')
      .update(`${header}.${claims}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString()).aud).toBe(new URL(endpoint).origin);
  });
});
