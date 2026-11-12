import crypto from 'crypto';
import net from 'net';
import tls from 'tls';

/**
 * A small SMTP server for tests, on Node's own `net` and `tls`: just enough of RFC 5321,
 * RFC 3207 (STARTTLS) and RFC 4616 (AUTH PLAIN) for a real client (nodemailer) to send it a
 * message, with a transcript of what the client said and whether the session was encrypted
 * at the time.
 *
 * With `startTls`, it is the server a careful deployment talks to: it offers STARTTLS, and
 * offers AUTH only once the session is encrypted (before that it refuses AUTH and MAIL).
 * Without it, it is what a client must never trust with a password: no STARTTLS, and AUTH
 * offered (and accepted) in the clear, as a server downgraded by someone in the middle
 * would be.
 */

/** One line the client sent, outside a message's DATA. */
export interface SmtpCommand {
  line: string;
  /** Whether the session was encrypted when it arrived. */
  tls: boolean;
}

/** A sign-in the server accepted. */
export interface SmtpAuth {
  user: string;
  pass: string;
  tls: boolean;
}

/** A message the server accepted: its envelope, and its content as the client sent it. */
export interface SmtpMessage {
  mailFrom: string;
  rcptTo: string[];
  /** The message, its header lines unfolded, keyed by lower-case name. */
  headers: Record<string, string>;
  body: string;
  tls: boolean;
  tlsProtocol: string | null;
  authUser: string | null;
}

export interface FakeSmtpServer {
  port: number;
  commands: SmtpCommand[];
  auths: SmtpAuth[];
  messages: SmtpMessage[];
  /** Every byte the client sent before its session was encrypted, as latin1 text. */
  cleartext(): string;
  close(): Promise<void>;
}

/** The address between < and > in a MAIL FROM / RCPT TO argument. */
const angleAddress = (arg: string) => /<([^>]*)>/.exec(arg)?.[1] ?? arg;

function parseMessage(lines: string[]): { headers: Record<string, string>; body: string } {
  const blank = lines.indexOf('');
  const headerLines = blank === -1 ? lines : lines.slice(0, blank);
  const headers: Record<string, string> = {};
  let last: string | null = null;
  for (const line of headerLines) {
    if (/^[ \t]/.test(line) && last) {
      headers[last] += ' ' + line.trim();
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    headers[last] = line.slice(colon + 1).trim();
  }
  return { headers, body: blank === -1 ? '' : lines.slice(blank + 1).join('\r\n') };
}

export async function startFakeSmtpServer(opts: { startTls: boolean; key?: string; cert?: string }): Promise<FakeSmtpServer> {
  if (opts.startTls && !(opts.key && opts.cert)) throw new Error('A STARTTLS server needs a key and a certificate');
  const secureContext = opts.startTls ? tls.createSecureContext({ key: opts.key, cert: opts.cert }) : null;
  const commands: SmtpCommand[] = [];
  const auths: SmtpAuth[] = [];
  const messages: SmtpMessage[] = [];
  const cleartext: Buffer[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((raw) => {
    sockets.add(raw);
    raw.on('close', () => sockets.delete(raw));
    raw.on('error', () => undefined); // a client that hangs up mid-session

    let socket: net.Socket = raw;
    let secure = false;
    let tlsProtocol: string | null = null;
    let pending = '';
    let authUser: string | null = null;
    let awaitingAuthPlain = false;
    let mailFrom: string | null = null;
    let rcptTo: string[] = [];
    let data: string[] | null = null;

    const reply = (text: string) => {
      if (!socket.destroyed) socket.write(`${text}\r\n`);
    };
    const resetTransaction = () => {
      mailFrom = null;
      rcptTo = [];
      data = null;
    };
    const ehlo = () => {
      const extensions = secure ? ['AUTH PLAIN'] : opts.startTls ? ['STARTTLS'] : ['AUTH PLAIN'];
      const lines = ['fake-smtp.test greets you', ...extensions];
      lines.forEach((line, i) => reply(`250${i === lines.length - 1 ? ' ' : '-'}${line}`));
    };
    const signIn = (encoded: string) => {
      const [, user = '', pass = ''] = Buffer.from(encoded, 'base64').toString('utf8').split('\u0000');
      auths.push({ user, pass, tls: secure });
      authUser = user;
      reply('235 2.7.0 Authentication successful');
    };

    const handle = (line: string) => {
      if (data) {
        if (line === '.') {
          const { headers, body } = parseMessage(data);
          messages.push({ mailFrom: mailFrom ?? '', rcptTo, headers, body, tls: secure, tlsProtocol, authUser });
          resetTransaction();
          return reply('250 2.0.0 Ok: queued');
        }
        data.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }
      commands.push({ line, tls: secure });
      if (awaitingAuthPlain) {
        awaitingAuthPlain = false;
        return signIn(line);
      }
      const space = line.indexOf(' ');
      const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
      const arg = space === -1 ? '' : line.slice(space + 1);
      switch (verb) {
        case 'EHLO':
          resetTransaction();
          return ehlo();
        case 'HELO':
          return reply('250 fake-smtp.test');
        case 'STARTTLS': {
          if (!secureContext || secure) return reply('502 5.5.1 STARTTLS not available');
          reply('220 2.0.0 Ready to start TLS');
          // RFC 3207: the session starts over, encrypted. Bytes after this point are TLS.
          raw.removeListener('data', onData);
          const secured = new tls.TLSSocket(raw, { isServer: true, secureContext });
          secured.on('error', () => undefined); // e.g. a client that refuses the certificate
          secured.on('secure', () => {
            secure = true;
            tlsProtocol = secured.getProtocol();
          });
          secured.on('data', onData);
          socket = secured;
          pending = '';
          authUser = null;
          resetTransaction();
          return;
        }
        case 'AUTH': {
          if (opts.startTls && !secure) return reply('530 5.7.0 Must issue a STARTTLS command first');
          const [mechanism, initial] = arg.split(' ');
          if (mechanism?.toUpperCase() !== 'PLAIN') return reply('504 5.5.4 Unrecognized authentication type');
          if (initial) return signIn(initial);
          awaitingAuthPlain = true;
          return reply('334 ');
        }
        case 'MAIL':
          if (!authUser) return reply('530 5.7.0 Authentication required');
          mailFrom = angleAddress(arg);
          return reply('250 2.1.0 Ok');
        case 'RCPT':
          if (!mailFrom) return reply('503 5.5.1 Need MAIL first');
          rcptTo.push(angleAddress(arg));
          return reply('250 2.1.5 Ok');
        case 'DATA':
          if (rcptTo.length === 0) return reply('503 5.5.1 Need RCPT first');
          data = [];
          return reply('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          resetTransaction();
          return reply('250 2.0.0 Ok');
        case 'NOOP':
          return reply('250 2.0.0 Ok');
        case 'QUIT':
          reply('221 2.0.0 Bye');
          socket.end();
          return;
        default:
          return reply('502 5.5.2 Command not recognized');
      }
    };

    function onData(chunk: Buffer) {
      if (!secure) cleartext.push(chunk);
      pending += chunk.toString('latin1');
      let end: number;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        handle(line);
      }
    }

    raw.on('data', onData);
    reply('220 fake-smtp.test ESMTP');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    commands,
    auths,
    messages,
    cleartext: () => Buffer.concat(cleartext).toString('latin1'),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// --- A throwaway self-signed certificate, built with node:crypto alone -----------------

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const sequence = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);
function objectId(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}
function utcTime(at: Date): Buffer {
  const two = (n: number) => String(n).padStart(2, '0');
  const text =
    two(at.getUTCFullYear() % 100) + two(at.getUTCMonth() + 1) + two(at.getUTCDate()) +
    two(at.getUTCHours()) + two(at.getUTCMinutes()) + two(at.getUTCSeconds()) + 'Z';
  return der(0x17, Buffer.from(text, 'ascii'));
}

/**
 * A self-signed X.509 v3 certificate for `localhost` and 127.0.0.1, valid for an hour, and
 * its P-256 key, both PEM. No openssl or package needed: the DER is assembled here and
 * signed with node:crypto.
 */
export function selfSignedLocalhostCertificate(): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = sequence(objectId('1.2.840.10045.4.3.2'));
  const name = sequence(set(sequence(objectId('2.5.4.3'), der(0x0c, Buffer.from('localhost')))));
  const subjectAltName = sequence(
    objectId('2.5.29.17'),
    der(0x04, sequence(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1]))))
  );
  const now = Date.now();
  const tbsCertificate = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(8)])), // a positive serial
    ecdsaWithSha256,
    name,
    sequence(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 3_600_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, sequence(subjectAltName))
  );
  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certificate = sequence(tbsCertificate, ecdsaWithSha256, der(0x03, Buffer.from([0]), signature));
  const base64 = certificate.toString('base64').match(/.{1,64}/g)!.join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}
