/**
 * CSV cell escaping for data exports.
 *
 * Two concerns are handled together:
 *  1. RFC-4180 quoting — values containing a comma, double-quote, CR or LF are
 *     wrapped in double-quotes and any embedded quote is doubled.
 *  2. Formula-injection defence — a cell a spreadsheet would treat as a formula
 *     (leads with `=`, `+`, `-`, `@`, a tab, or a carriage return) is prefixed
 *     with a single quote so the value renders as text instead of executing when
 *     the file is opened in Excel / Google Sheets / LibreOffice. Exported fields
 *     (descriptions, merchant names, notes, tags) are user- and import-controlled,
 *     so this is untrusted content.
 *
 * A plain decimal number such as `-42.50` is left as it is: its minus is a sign, not
 * a formula, and amounts are pre-signed, so prefixing it would turn every expense into
 * text in the spreadsheet.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const NEEDS_QUOTES = /[",\r\n]/;

export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  let str = String(value);

  // Neutralise leading formula characters before any quoting.
  if (FORMULA_LEAD.test(str) && !PLAIN_NUMBER.test(str)) {
    str = `'${str}`;
  }

  if (NEEDS_QUOTES.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Render rows to a CSV string, escaping every cell (see {@link escapeCsvValue}). */
export function rowsToCsv(rows: Array<Record<string, unknown>>, headers: string[]): string {
  const csvHeaders = headers.join(',');
  const csvRows = rows
    .map((row) => headers.map((header) => escapeCsvValue(row[header])).join(','))
    .join('\n');
  return `${csvHeaders}\n${csvRows}`;
}
