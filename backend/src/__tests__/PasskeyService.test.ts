import { describe, it, expect, vi } from 'vitest';

// PasskeyService imports db.js, which loads Docker secrets at module init and
// would throw in tests; mock it so importing the service is side-effect-free.
// The helper under test does not touch the database.
vi.mock('../db.js', () => ({ default: {}, db: {} }));

import { presentedUserHandle } from '../services/PasskeyService.js';

const withHandle = (userHandle: unknown) => ({ id: 'x', rawId: 'x', type: 'public-key', response: { userHandle } });

// The user handle a passkey sign-in names: what the check against the stored one reads.
describe('presentedUserHandle', () => {
  it('is undefined when the assertion names none', () => {
    for (const none of [undefined, null, '']) expect(presentedUserHandle(withHandle(none))).toBeUndefined();
    expect(presentedUserHandle({ response: {} })).toBeUndefined();
    expect(presentedUserHandle(null)).toBeUndefined();
  });

  it('is the handle, as unpadded base64url, when it is one', () => {
    const handle = Buffer.alloc(32, 7).toString('base64url');
    expect(presentedUserHandle(withHandle(handle))).toBe(handle);
    // The largest WebAuthn allows: 64 bytes.
    const largest = Buffer.alloc(64, 1).toString('base64url');
    expect(presentedUserHandle(withHandle(largest))).toBe(largest);
  });

  it('reads two spellings of one handle as the same', () => {
    // A trailing character whose spare bits are set decodes to the same bytes.
    const canonical = Buffer.from([0xfb]).toString('base64url'); // "-w"
    expect(presentedUserHandle(withHandle('-x'))).toBe(canonical);
  });

  it('is null (refused) when what it names can\'t be a user handle', () => {
    for (const bad of [
      42,
      { id: 'x' },
      ['AAAA'],
      'not base64url!',
      'AAAA=', // padding
      'A', // no whole byte
      Buffer.alloc(65, 1).toString('base64url'), // over 64 bytes
      'A'.repeat(5000),
    ]) {
      expect(presentedUserHandle(withHandle(bad)), JSON.stringify(bad).slice(0, 40)).toBeNull();
    }
  });
});
