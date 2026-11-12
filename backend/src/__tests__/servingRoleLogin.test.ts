import { describe, it, expect } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { scramSha256Verifier, syncServingRoleLogin } from '../db/servingRoleLogin.js';

/**
 * Migrate gives the serving role its password from the app_db_password secret. It
 * sent `ALTER ROLE … PASSWORD '<the password>'`, and Postgres logs a statement slower than
 * log_min_duration_statement in full, literal included. It now sends a SCRAM-SHA-256
 * verifier made here, which no one can sign in with, and turns statement logging off
 * for that transaction where it may. That the verifier signs in: servingRoleLogin.db.test.ts.
 */

const b64 = (text: string) => Buffer.from(text, 'base64');

describe('scramSha256Verifier', () => {
  // RFC 7677 §3: the example exchange for password "pencil". A verifier made from its salt
  // and iteration count must check the client's proof and give the server's signature.
  it('makes the stored and server keys of RFC 7677 §3', () => {
    const salt = 'W22ZaJ0SNY7soEsUEjb6gQ==';
    const verifier = scramSha256Verifier('pencil', { salt: b64(salt), iterations: 4096 });
    const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    expect(match?.[1]).toBe(salt);
    const storedKey = b64(match![2]);
    const serverKey = b64(match![3]);

    const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=${salt},i=4096,c=biws,r=${nonce}`;
    const proof = b64('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((byte, i) => byte ^ clientSignature[i]));
    expect(createHash('sha256').update(clientKey).digest()).toEqual(storedKey);
    expect(createHmac('sha256', serverKey).update(authMessage).digest('base64')).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  });

  it('takes a new random salt each time, at 4096 iterations', () => {
    const one = scramSha256Verifier('same password');
    const two = scramSha256Verifier('same password');
    expect(one).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(one).not.toBe(two);
  });

  // As node-postgres's client (and Postgres, for a password it allows) prepares one, so
  // the app can sign in with a password that isn't plain ASCII: a no-break space is a space.
  it('prepares the password as the client does (SASLprep)', () => {
    const salt = Buffer.alloc(16, 7);
    expect(scramSha256Verifier('a\u00a0b\u00adc', { salt })).toBe(scramSha256Verifier('a bc', { salt }));
    expect(scramSha256Verifier('\u2163', { salt })).toBe(scramSha256Verifier('IV', { salt }));
  });
});

/** A pool whose one client records what it is sent, and answers the parameter privileges asked. */
function recordingPool(maySet: boolean) {
  const sent: { text: string; values?: unknown[] | undefined }[] = [];
  let released = 0;
  const client = {
    query: async (text: string, values?: unknown[]) => {
      sent.push({ text, values });
      if (/has_parameter_privilege/.test(text)) {
        return { rows: (values?.[0] as string[]).map((name) => ({ name, may_set: maySet })) };
      }
      return { rows: [] };
    },
    escapeIdentifier: (name: string) => `"${name.replace(/"/g, '""')}"`,
    escapeLiteral: (text: string) => `'${text.replace(/'/g, "''")}'`,
    release: () => {
      released++;
    },
  };
  return { pool: { connect: async () => client } as unknown as Pool, sent, released: () => released };
}

describe('syncServingRoleLogin', () => {
  const password = "s3cret-app-db-password-with-a-'quote";

  it('sends a verifier, never the password, with statement logging off first', async () => {
    const { pool, sent, released } = recordingPool(true);
    await syncServingRoleLogin(pool, password);

    // Nor as an SQL literal spells it.
    for (const secret of [password, password.replace(/'/g, "''"), 's3cret-app-db-password']) {
      for (const { text, values } of sent) {
        expect(text).not.toContain(secret);
        expect(JSON.stringify(values ?? [])).not.toContain(secret);
      }
    }
    const alter = sent.findIndex(({ text }) => /^ALTER ROLE/.test(text));
    expect(sent[alter].text).toMatch(/^ALTER ROLE "nuggets_app" WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:[^']+'$/);
    expect(sent.map(({ text }) => text)).toEqual([
      'BEGIN',
      expect.stringMatching(/has_parameter_privilege/),
      "SET LOCAL log_statement = 'none'",
      'SET LOCAL log_min_duration_statement = -1',
      sent[alter].text,
      'COMMIT',
    ]);
    expect(released()).toBe(1);
  });

  it('still sets the verifier where the role may not change statement logging', async () => {
    const { pool, sent } = recordingPool(false);
    await syncServingRoleLogin(pool, password);
    expect(sent.map(({ text }) => text.split(' WITH ')[0])).toEqual([
      'BEGIN',
      expect.stringMatching(/has_parameter_privilege/),
      'ALTER ROLE "nuggets_app"',
      'COMMIT',
    ]);
  });
});
