// Static server for Slingstar. `node tools/serve.mjs` → http://127.0.0.1:8791
// Env: PORT (default 8791), HOST (default 127.0.0.1), ROOT (default the repo / deploy folder).
// Also importable: `startServer({ port, root })` resolves to the bound port (port 0 = ephemeral).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
};
const NO_CACHE = new Set(['/index.html', '/sw.js', '/manifest.webmanifest']);
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @param {{ port?: number, host?: string, root?: string }} [opts] */
export function startServer(opts = {}) {
  const root = path.resolve(opts.root ?? process.env.ROOT ?? DEFAULT_ROOT);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const port = opts.port ?? Number(process.env.PORT ?? 8791);
  const server = http.createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); }
    catch { res.writeHead(400).end('Bad request'); return; }
    if (urlPath.endsWith('/')) urlPath += 'index.html';
    const file = path.join(root, path.normalize(urlPath));
    if (!file.startsWith(root + path.sep) || /(^|[/\\])\.|node_modules/.test(path.relative(root, file))) {
      res.writeHead(404).end('Not found'); return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      const ext = path.extname(file).toLowerCase();
      /** @type {Record<string, string|number>} */
      const headers = {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': NO_CACHE.has(urlPath) ? 'no-cache' : 'public, max-age=0, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
      };
      if (urlPath === '/sw.js') headers['Service-Worker-Allowed'] = '/';
      res.writeHead(200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : port, root });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, root } = await startServer();
  console.log(`Slingstar serving ${root} at http://127.0.0.1:${port}/`);
}
