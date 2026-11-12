import { describe, it, expect } from 'vitest';
import { KNOWN_TRANSPORTS, isKnownTransport, knownTransports } from '../../services/passkeyTransports.js';

// A passkey's transports, as a browser reports them or as a row holds them,
// are read as the known values only.
describe('passkey transports', () => {
  it("knows WebAuthn Level 3's transports and Chrome's older name for hybrid", () => {
    expect([...KNOWN_TRANSPORTS].sort()).toEqual(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);
    for (const transport of KNOWN_TRANSPORTS) expect(isKnownTransport(transport)).toBe(true);
  });

  it('keeps the known ones, once each, in the order they came', () => {
    expect(knownTransports(['hybrid', 'internal'])).toEqual(['hybrid', 'internal']);
    expect(knownTransports(['usb', 'warp-drive', 'nfc', 'usb', 'smart-card'])).toEqual(['usb', 'nfc', 'smart-card']);
    expect(knownTransports([])).toEqual([]);
  });

  it('drops anything else: unknown names, other spellings, and values that are not strings', () => {
    expect(knownTransports(['USB', ' internal', 'internal ', 'blue-tooth', '', 'x'.repeat(10_000)])).toEqual([]);
    expect(knownTransports([1, null, undefined, { usb: true }, ['usb'], true, 'ble'])).toEqual(['ble']);
    expect(isKnownTransport('constructor')).toBe(false);
    expect(isKnownTransport(undefined)).toBe(false);
  });
});
