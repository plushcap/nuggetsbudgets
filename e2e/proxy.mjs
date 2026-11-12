// The reverse proxy a deployment puts in front of Nuggets, for the end-to-end tests: one
// origin, /api and /uploads to the backend, everything else to the frontend's static server
// (frontend/static-server, `serve` with the build's serve.json, as the production image runs
// it), so the browser gets the app with its own security headers. No dependencies.
//
//   E2E_PORT     where it listens (default 4173), on 127.0.0.1
//   BACKEND_URL  the backend (default http://127.0.0.1:5055)
//   STATIC_URL   the static server (default http://127.0.0.1:5056)
import http from 'node:http';

const port = Number(process.env.E2E_PORT ?? 4173);
const backend = new URL(process.env.BACKEND_URL ?? 'http://127.0.0.1:5055');
const statics = new URL(process.env.STATIC_URL ?? 'http://127.0.0.1:5056');

const toBackend = (path) => path === '/api' || path.startsWith('/api/') || path.startsWith('/uploads/');

const server = http.createServer((req, res) => {
  const target = toBackend(new URL(req.url, 'http://x').pathname) ? backend : statics;
  const upstream = http.request(
    {
      host: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      // The Host the browser used, as a reverse proxy passes it; and where the request came from.
      headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http' },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(res);
    }
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`proxy: ${target.origin} did not answer (${err.code ?? err.message})`);
  });
  req.pipe(upstream);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`e2e proxy on http://127.0.0.1:${port}: /api, /uploads -> ${backend.origin}; else -> ${statics.origin}\n`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
