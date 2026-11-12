import { describe, it, expect } from 'vitest';
import { escapeCsvValue, rowsToCsv } from '@nuggets/shared';

/**
 * CSV export must neutralise spreadsheet formula injection.
 * User/import-controlled fields (descriptions, merchant names, notes) that lead
 * with = + - @ tab or CR would otherwise execute when the file is opened in a
 * spreadsheet.
 */
describe('escapeCsvValue', () => {
  it('returns empty string for null/undefined', () => {
    expect(escapeCsvValue(null)).toBe('');
    expect(escapeCsvValue(undefined)).toBe('');
  });

  it('passes through plain values unchanged', () => {
    expect(escapeCsvValue('Coffee shop')).toBe('Coffee shop');
    expect(escapeCsvValue(42)).toBe('42');
  });

  it('quotes values containing commas, quotes, or newlines (RFC-4180)', () => {
    expect(escapeCsvValue('a,b')).toBe('"a,b"');
    expect(escapeCsvValue('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvValue('line1\nline2')).toBe('"line1\nline2"');
  });

  it('prefixes a formula-leading value with a single quote', () => {
    expect(escapeCsvValue('=1+2')).toBe("'=1+2");
    expect(escapeCsvValue('+1')).toBe("'+1");
    expect(escapeCsvValue('-1+2')).toBe("'-1+2");
    expect(escapeCsvValue('-')).toBe("'-");
    expect(escapeCsvValue('-1e5')).toBe("'-1e5");
    expect(escapeCsvValue("-2+3+cmd|' /C calc'!A0")).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(escapeCsvValue('@SUM')).toBe("'@SUM");
  });

  it('leaves a negative amount a number', () => {
    // pg returns NUMERIC as text, and amounts are pre-signed, so expenses lead with a minus.
    expect(escapeCsvValue('-42.50')).toBe('-42.50');
    expect(escapeCsvValue('-1')).toBe('-1');
    expect(escapeCsvValue(-7)).toBe('-7');
  });

  it('prefixes AND quotes a formula value that contains double-quotes', () => {
    // '=HYPERLINK("x")' -> prefix quote, then RFC-4180 wrap with doubled quotes.
    expect(escapeCsvValue('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
  });

  it('neutralises AND still quotes a dangerous value that also has a comma', () => {
    // Leading = gets the quote prefix, then the comma triggers RFC-4180 wrapping.
    expect(escapeCsvValue('=cmd|calc,x')).toBe("\"'=cmd|calc,x\"");
  });

  it('neutralises tab/CR-leading values', () => {
    expect(escapeCsvValue('\t=1')).toBe("'\t=1");
    // A CR also needs quoting, or a reader would end the row there.
    expect(escapeCsvValue('\r=1')).toBe("\"'\r=1\"");
  });

  it('quotes a value with a bare carriage return', () => {
    expect(escapeCsvValue('line1\rline2')).toBe('"line1\rline2"');
  });
});

describe('rowsToCsv', () => {
  it('renders a header row and escapes every cell', () => {
    const csv = rowsToCsv(
      [{ name: '=evil', amount: '10,00' }],
      ['name', 'amount']
    );
    expect(csv).toBe("name,amount\n'=evil,\"10,00\"");
  });
});
