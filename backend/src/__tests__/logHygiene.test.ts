import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import request from 'supertest';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import ts from 'typescript';
import { httpLoggerOptions } from '../middleware/logger.js';
import { getRecentSecurityEvents, logEnhancedSecurityEvent } from '../middleware/security-enhanced.js';
import { LOG_SERIALIZERS, REDACT_PATHS } from '../utils/logger.js';

/**
 * What the logs, which Dozzle shows, may carry: a request
 * line has no query string (the OneDrive callback's OAuth code and state came through
 * it), no cookie, Authorization or CSRF header and no Referer, and the root logger's
 * redaction reaches secrets nested a few objects down.
 */
function capture() {
  const lines: string[] = [];
  const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' }, serializers: LOG_SERIALIZERS }, { write: (s: string) => lines.push(s) });
  return { logger, lines, all: () => lines.join('\n') };
}

describe('log hygiene', () => {
  it("logs a request's path and a few headers, never its query or credentials", async () => {
    const { logger, lines, all } = capture();
    const app = express();
    app.use(pinoHttp({ logger, ...httpLoggerOptions }));
    app.get('/api/onedrive/callback', (_req, res) => {
      res.cookie('nuggets_session', 'SESSION-SECRET');
      res.send('ok');
    });

    await request(app)
      .get('/api/onedrive/callback?code=OAUTH-CODE-SECRET&state=OAUTH-STATE-SECRET')
      .set('Cookie', 'nuggets_session=COOKIE-SECRET')
      .set('Authorization', 'Bearer BEARER-SECRET')
      .set('X-CSRF-Token', 'CSRF-SECRET')
      .set('Referer', 'https://app.example/search?q=PAYEE-SECRET')
      .set('User-Agent', 'log-hygiene-test')
      .expect(200);

    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]);
    expect(line.msg).toBe('GET /api/onedrive/callback - 200');
    expect(line.request.url).toBe('/api/onedrive/callback');
    expect(line.request.headers).toEqual(expect.objectContaining({ 'user-agent': 'log-hygiene-test' }));
    for (const secret of ['OAUTH-CODE', 'OAUTH-STATE', 'COOKIE-SECRET', 'BEARER-SECRET', 'CSRF-SECRET', 'PAYEE-SECRET', 'SESSION-SECRET']) {
      expect(all()).not.toContain(secret);
    }
  });

  it('masks an email address in a security event, which carries the user id instead', () => {
    logEnhancedSecurityEvent({
      type: 'authentication',
      level: 'info',
      message: 'Authentication success: User jane.doe+bank@example.co.uk logged in',
      userId: 42,
      ipAddress: '127.0.0.1',
      userAgent: 'log-hygiene-test',
      metadata: { event: 'success', details: 'for jane.doe+bank@example.co.uk', count: 1 },
    });
    const [event] = getRecentSecurityEvents(1);
    expect(event.message).toBe('Authentication success: User j…@example.co.uk logged in');
    expect(event.metadata).toEqual({ event: 'success', details: 'for j…@example.co.uk', count: 1 });
    expect(event.userId).toBe(42);
  });

  it('passes no email address unmasked to a log call', () => {
    // Who did something is their user id (the logger's mixin adds it to a request's lines);
    // an address, when a line needs one, goes through maskEmail. The sign-in success
    // event logged `User ${user.email} logged in successfully`.
    const LOG_CALL = /(?:^|\.)(?:logger|log)\.(?:trace|debug|info|warn|error|fatal)$|^(?:logAuthenticationEvent|logEnhancedSecurityEvent)$/;
    // Names that hold no address: a flag, a length, an error object.
    const NOT_AN_ADDRESS = new Set(['hasEmail', 'emailLength', 'emailError', 'emailEnabled', 'email_enabled']);
    const found: string[] = [];
    const srcRoot = fileURLToPath(new URL('..', import.meta.url));
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !/(^|\/)__tests__\//.test(f) && !f.startsWith('test/'));
    expect(files.length).toBeGreaterThan(100);
    for (const file of files) {
      const text = readFileSync(path.join(srcRoot, file), 'utf8');
      if (!/email/i.test(text)) continue;
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const visitArgument = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'maskEmail') return; // masked
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) return; // a flag
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'length') return; // a length
        if (ts.isPropertyAssignment(node)) return visitArgument(node.initializer); // a key holds nothing
        const name = ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : null;
        if (name && /email/i.test(name) && !NOT_AN_ADDRESS.has(name)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          found.push(`${file}:${line + 1}: ${node.getText(source)}`);
          return;
        }
        ts.forEachChild(node, visitArgument);
      };
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && LOG_CALL.test(node.expression.getText(source))) {
          node.arguments.forEach(visitArgument);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(found).toEqual([]);
  });

  it('redacts secrets nested a few objects down', () => {
    const { logger, all } = capture();
    logger.info({
      connection: { access_url: 'https://user:SIMPLEFIN-SECRET@bridge.example' }, // gitleaks:allow (made-up)
      err: { config: { headers: { authorization: 'Bearer AXIOS-SECRET', 'x-csrf-token': 'CSRF-SECRET' } } },
      a: { b: { c: { refresh_token: 'REFRESH-SECRET', password: 'PW-SECRET' } } },
      onedrive: { accessToken: 'ACCESS-SECRET', clientSecret: 'CLIENT-SECRET' },
    }, 'nested');
    for (const secret of ['SIMPLEFIN', 'AXIOS', 'CSRF-SECRET', 'REFRESH', 'PW-SECRET', 'ACCESS-SECRET', 'CLIENT-SECRET']) {
      expect(all()).not.toContain(secret);
    }
    expect(all()).toContain('[REDACTED]');
  });
  it("leaves a Postgres error's row values out of an { err } line, its causes' too", () => {
    const { logger, lines } = capture();
    const row = Object.assign(new Error('new row for relation "transactions" violates check constraint "chk"'), {
      code: '23514', constraint: 'chk', table: 'transactions',
      detail: 'Failing row contains (7, -31.37, PAYEE SECRET)', where: 'SQL statement "UPDATE …"', internalQuery: 'SELECT 42.42',
    });
    logger.error({ err: new Error('import failed', { cause: row }) }, 'failed');
    logger.error({ err: row }, 'failed');
    const text = lines.join('\n');
    for (const leak of ['-31.37', 'PAYEE SECRET', 'UPDATE', '42.42']) expect(text).not.toContain(leak);
    expect(text).toContain('"code":"23514"');
    expect(text).toContain('"constraint":"chk"');
  });
});
