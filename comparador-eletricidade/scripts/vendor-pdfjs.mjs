#!/usr/bin/env node
// Copies the pdf.js browser build from node_modules into public/vendor so the
// site works fully offline / self-hosted (no CDN).
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'node_modules/pdfjs-dist/legacy/build');
const DST = resolve(ROOT, 'public/vendor/pdfjs');
mkdirSync(DST, { recursive: true });
// Copied with a .js extension: some static hosts serve .mjs as application/octet-stream,
// which browsers reject for ES modules / module workers.
const FILES = { 'pdf.min.mjs': 'pdf.min.js', 'pdf.worker.min.mjs': 'pdf.worker.min.js' };
for (const [src, dst] of Object.entries(FILES)) {
  copyFileSync(resolve(SRC, src), resolve(DST, dst));
  rmSync(resolve(DST, src), { force: true }); // stale copies from older versions of this script
  console.log(`copied ${src} -> ${dst}`);
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
console.log(`pdf.js ${pkg.version} vendored into public/vendor/pdfjs`);
