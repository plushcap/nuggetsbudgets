import { describe, it, expect } from 'vitest';
import { websiteUrlProblem, safeWebsiteHref, merchantCreateSchema, merchantUpdateSchema } from '@nuggets/shared';

/** A merchant's website is an http(s) link. */
describe('websiteUrlProblem', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['http://shop.example.com/help?x=1', 'http://shop.example.com/help?x=1'],
    ['example.com', 'https://example.com'],
    ['example.com:8080/a', 'https://example.com:8080/a'],
    ['  HTTPS://Example.COM/  ', 'https://example.com/'],
  ])('keeps %s as %s', (input, stored) => {
    expect(websiteUrlProblem(input)).toEqual({ url: stored, problem: null });
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com',
    'file:///etc/passwd',
    '//evil.example/x',
    'mailto:a@b.c',
  ])('refuses the scheme of %s', (input) => {
    expect(websiteUrlProblem(input).problem).toMatch(/http:\/\/ or https:\/\//);
  });

  it('refuses a user name or password, which reads as another address', () => {
    expect(websiteUrlProblem('https://bank.example@evil.example/').problem).toMatch(/user name or password/);
    expect(websiteUrlProblem('https://user:pw@example.com').problem).toMatch(/user name or password/);
  });

  it('refuses something that is not an address, or too long', () => {
    expect(websiteUrlProblem('not a url at all').problem).toBe('This isn’t a website address.');
    expect(websiteUrlProblem(`https://example.com/${'a'.repeat(2048)}`).problem).toMatch(/up to 2048/);
  });

  it('gives a link only for a stored value that is a website', () => {
    expect(safeWebsiteHref('javascript:alert(1)')).toBeNull();
    expect(safeWebsiteHref(null)).toBeNull();
    expect(safeWebsiteHref('shop.example.com')).toBe('https://shop.example.com');
  });

  it('is what the merchant schemas store', () => {
    expect(merchantCreateSchema.parse({ name: 'A', merchant_website: 'example.com' }).merchant_website).toBe('https://example.com');
    expect(merchantCreateSchema.parse({ name: 'A', merchant_website: '' }).merchant_website).toBeNull();
    expect(merchantCreateSchema.parse({ name: 'A' }).merchant_website).toBeUndefined();
    expect(merchantUpdateSchema.safeParse({ merchant_website: 'javascript:alert(1)' }).success).toBe(false);
  });
});
