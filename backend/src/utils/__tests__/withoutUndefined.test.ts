import { describe, it, expect, expectTypeOf } from 'vitest';
import { withoutUndefined } from '../withoutUndefined.js';

describe('withoutUndefined', () => {
  it('leaves out the undefined properties and keeps every other value, null, 0 and "" included', () => {
    const out = withoutUndefined({ a: 'x', b: undefined, c: null, d: 0, e: '', f: false });
    expect(out).toStrictEqual({ a: 'x', c: null, d: 0, e: '', f: false });
    expect(Object.keys(out)).not.toContain('b');
  });

  it('types a maybe-undefined property as optional without undefined, and keeps the others required', () => {
    const out = withoutUndefined({ required: 'x', maybe: undefined as string | undefined });
    expectTypeOf(out).toEqualTypeOf<{ required: string } & { maybe?: string }>();
    // What exactOptionalPropertyTypes refuses with the undefined left in.
    const takesOptions = (options: { required: string; maybe?: string }) => options;
    expect(takesOptions(out)).toStrictEqual({ required: 'x' });
  });
});
