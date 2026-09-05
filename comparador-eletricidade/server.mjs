// Tiny static web server (no dependencies). Serves ./public with gzip for text
// assets and lets the browser do all the work (PDF parsing + comparison).
//
//   node server.mjs            -> http://0.0.0.0:3000
//   PORT=8080 node server.mjs
//
// Optional: POST /api/refresh-data downloads the latest ERSE dataset (needs
// outbound internet on the server).

import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);

let refreshing = null;

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'POST' && url.pathname === '/api/refresh-data') return refreshData(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = normalize(resolve(PUBLIC, '.' + pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }

  let st;
  try { st = statSync(file); } catch { res.writeHead(404); return res.end('Not found'); }
  if (st.isDirectory()) { res.writeHead(404); return res.end('Not found'); }

  const ext = extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': /^\/vendor\/pdfjs-[^/]+\//.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // pdf.js worker + fonts need these to be relaxed enough; keep it simple.
    'Access-Control-Allow-Origin': '*',
  };
  const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && COMPRESSIBLE.has(ext) && st.size > 1024;
  if (wantsGzip) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(createGzip({ level: 6 })).pipe(res);
  } else {
    headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }
});

function refreshData(res) {
  if (!refreshing) {
    refreshing = new Promise((resolveP) => {
      const child = spawn(process.execPath, [resolve(__dirname, 'scripts/update-erse.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', (d) => (log += d));
      child.stderr.on('data', (d) => (log += d));
      child.on('close', (code) => { refreshing = null; resolveP({ ok: code === 0, log }); });
    });
  }
  refreshing.then((r) => {
    res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(r));
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Comparador de eletricidade a correr em http://${HOST}:${PORT}`);
  if (!existsSync(resolve(PUBLIC, 'data/ofertas.json'))) {
    console.warn('AVISO: public/data/ofertas.json não existe. Corra `npm run data:build` ou `npm run data:update`.');
  }
});
