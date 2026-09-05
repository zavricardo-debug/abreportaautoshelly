#!/usr/bin/env node
// Assembles a self-contained static bundle for Cloudflare Pages (or any static
// host) in ./cloudflare-upload and zips it to ./comparador-eletricidade-cloudflare.zip.
//
//   npm run build            -> cloudflare-upload/ + zip
//
// The bundle contains exactly what the browser needs (index.html, app.js, css,
// lib/, vendor/pdfjs, data/ofertas.json, samples/) plus Cloudflare's _headers
// and _redirects files. No server code is included – the site is 100 % static.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(ROOT, 'public');
const DIST = resolve(ROOT, process.env.OUT_DIR || 'cloudflare-upload');
const ZIP = resolve(ROOT, 'comparador-eletricidade-cloudflare.zip');

// --- preconditions -----------------------------------------------------------
const required = [
  ['public/vendor/pdfjs/pdf.min.js', 'npm run vendor'],
  ['public/vendor/pdfjs/pdf.worker.min.js', 'npm run vendor'],
  ['public/data/ofertas.json', 'npm run data:build'],
];
for (const [f, fix] of required) {
  if (!existsSync(resolve(ROOT, f))) { console.error(`missing ${f} – run "${fix}" first`); process.exit(1); }
}

// --- copy --------------------------------------------------------------------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
cpSync(PUBLIC, DIST, { recursive: true, filter: (src) => !/\.(map|DS_Store)$/.test(src) });

// --- Cloudflare Pages config -------------------------------------------------
writeFileSync(resolve(DIST, '_headers'), `# Cloudflare Pages headers (https://developers.cloudflare.com/pages/configuration/headers/)
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: SAMEORIGIN
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

# pdf.js is versioned by re-deploy; cache aggressively
/vendor/*
  Cache-Control: public, max-age=31536000, immutable

# the ERSE dataset changes on every data refresh – revalidate
/data/*
  Cache-Control: public, max-age=3600, must-revalidate

/samples/*
  Content-Type: application/pdf
`);

writeFileSync(resolve(DIST, '_redirects'), `# Cloudflare Pages redirects (https://developers.cloudflare.com/pages/configuration/redirects/)
/index.html   /   301
`);

// Pages treats a top-level 404.html as the not-found page.
writeFileSync(resolve(DIST, '404.html'), `<!DOCTYPE html><html lang="pt-PT"><head><meta charset="utf-8"><title>Página não encontrada</title>
<meta http-equiv="refresh" content="3;url=/"><link rel="stylesheet" href="/styles.css"></head>
<body><main class="wrap"><section class="card"><h1>Página não encontrada</h1><p class="muted">A redirecionar para o <a href="/">comparador</a>…</p></section></main></body></html>
`);

// robots + a tiny build manifest (handy to check which dataset is live)
writeFileSync(resolve(DIST, 'robots.txt'), 'User-agent: *\nAllow: /\nDisallow: /data/\n');
const meta = JSON.parse(readFileSync(resolve(PUBLIC, 'data/ofertas.json'), 'utf8')).meta;
writeFileSync(resolve(DIST, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), dataset: meta }, null, 2));

// --- report ------------------------------------------------------------------
let total = 0, count = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e), st = statSync(p);
    if (st.isDirectory()) walk(p); else { total += st.size; count++; }
  }
};
walk(DIST);
console.log(`${relative(ROOT, DIST)}/: ${count} files, ${(total / 1024 / 1024).toFixed(2)} MB (uncompressed)`);
for (const f of ['index.html', 'app.js', 'styles.css', 'lib', 'vendor', 'data', 'samples', '_headers', '_redirects', '404.html']) {
  console.log('  ' + (existsSync(resolve(DIST, f)) ? '✓' : '✗'), f);
}

// --- zip ---------------------------------------------------------------------
rmSync(ZIP, { force: true });
try {
  execFileSync('zip', ['-qr', '-X', ZIP, '.'], { cwd: DIST, stdio: 'inherit' });
  console.log(`zip: ${relative(ROOT, ZIP)} (${(statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB)`);
} catch (e) {
  console.warn(`zip not available – upload the ${relative(ROOT, DIST)}/ folder directly. (${e.message})`);
}
