#!/usr/bin/env node
// Copies the pdf.js browser build from node_modules into public/vendor so the
// site works fully offline / self-hosted (no CDN).
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'node_modules/pdfjs-dist/legacy/build');
const DST = resolve(ROOT, 'public/vendor/pdfjs');
mkdirSync(DST, { recursive: true });
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  copyFileSync(resolve(SRC, f), resolve(DST, f));
  console.log(`copied ${f}`);
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
console.log(`pdf.js ${pkg.version} vendored into public/vendor/pdfjs`);
