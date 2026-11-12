/**
 * Split a SQL script into its statements, for a migration that runs each statement on
 * its own (`-- nuggets:no-transaction`, MigrationService). Postgres runs a query string
 * of several statements as one implicit transaction, where `CREATE INDEX CONCURRENTLY`
 * and the like are refused, so such a migration's statements are sent one at a time.
 *
 * A `;` ends a statement unless it is inside a `--` or (nested) block comment, a '…'
 * or E'…' string, a "…" identifier or a $tag$…$tag$ dollar-quoted body. Comments stay
 * with the statement they precede; a piece that is only comments and whitespace is
 * dropped. A SQL-standard function body (`BEGIN ATOMIC … END`) has semicolons of its
 * own that this can't tell apart, so it is refused: put such a function in an ordinary
 * migration.
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let start = 0;
  for (const token of tokens(script)) {
    if (token.kind === 'semicolon') {
      addStatement(statements, script.slice(start, token.start));
      start = token.end;
    }
  }
  addStatement(statements, script.slice(start));
  return statements;
}

function addStatement(statements: string[], piece: string): void {
  const text = piece.trim();
  const code = tokens(text)
    .filter((t) => t.kind !== 'comment')
    .map((t) => (t.kind === 'code' ? text.slice(t.start, t.end) : ' '))
    .join('');
  if (code.trim() === '' && !tokens(text).some((t) => t.kind === 'literal')) return;
  if (/\bBEGIN\s+ATOMIC\b/i.test(code)) {
    throw new Error(
      'A no-transaction migration cannot hold a BEGIN ATOMIC function body; put that function in an ordinary migration'
    );
  }
  statements.push(text);
}

type Token = { kind: 'code' | 'comment' | 'literal' | 'semicolon'; start: number; end: number };

/** The script as runs of code, comments, literals (strings, quoted names, dollar bodies) and semicolons. */
function tokens(s: string): Token[] {
  const out: Token[] = [];
  let codeStart = 0;
  let i = 0;
  const flush = (end: number) => {
    if (end > codeStart) out.push({ kind: 'code', start: codeStart, end });
  };
  const emit = (kind: Token['kind'], start: number, end: number) => {
    flush(start);
    out.push({ kind, start, end });
    codeStart = end;
    i = end;
  };
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === '-' && next === '-') {
      const nl = s.indexOf('\n', i);
      emit('comment', i, nl === -1 ? s.length : nl + 1);
    } else if (c === '/' && next === '*') {
      emit('comment', i, blockCommentEnd(s, i));
    } else if (c === "'") {
      emit('literal', i, quotedEnd(s, i, "'", isEscapeString(s, i)));
    } else if (c === '"') {
      emit('literal', i, quotedEnd(s, i, '"', false));
    } else if (c === '$' && dollarTagAt(s, i)) {
      const tag = dollarTagAt(s, i)!;
      const close = s.indexOf(tag, i + tag.length);
      if (close === -1) throw new Error(`Unterminated dollar-quoted string ${tag}`);
      emit('literal', i, close + tag.length);
    } else if (c === ';') {
      emit('semicolon', i, i + 1);
    } else {
      i++;
    }
  }
  flush(s.length);
  return out;
}

function blockCommentEnd(s: string, i: number): number {
  // Postgres block comments nest.
  let depth = 0;
  while (i < s.length) {
    if (s[i] === '/' && s[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (s[i] === '*' && s[i + 1] === '/') {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  throw new Error('Unterminated block comment');
}

/** An E'…' string (backslash escapes), not a quote after an identifier that ends in e. */
function isEscapeString(s: string, quote: number): boolean {
  const prev = s[quote - 1];
  return (prev === 'e' || prev === 'E') && !/[A-Za-z0-9_$]/.test(s[quote - 2] ?? '');
}

function quotedEnd(s: string, i: number, quote: string, backslashEscapes: boolean): number {
  i++;
  while (i < s.length) {
    const c = s[i];
    if (backslashEscapes && c === '\\') {
      i += 2;
    } else if (c === quote) {
      if (s[i + 1] !== quote) return i + 1;
      i += 2; // '' or "" inside the literal
    } else {
      i++;
    }
  }
  throw new Error(`Unterminated ${quote === "'" ? 'string' : 'quoted identifier'}`);
}

/** The $tag$ that opens a dollar-quoted string at i, or null ($1 is a parameter, a$b part of a name). */
function dollarTagAt(s: string, i: number): string | null {
  if (/[A-Za-z0-9_$]/.test(s[i - 1] ?? '')) return null;
  const m = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(s.slice(i, i + 64));
  return m ? m[0] : null;
}
