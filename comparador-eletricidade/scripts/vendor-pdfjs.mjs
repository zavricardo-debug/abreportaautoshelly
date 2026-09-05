#!/usr/bin/env node
// Copies the pdf.js browser build from node_modules into public/vendor so the
// site works fully offline / self-hosted (no CDN).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'node_modules/pdfjs-dist/legacy/build');
const pkgEarly = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
// Versioned folder => a new pdf.js version always gets a new URL (old one may be cached "immutable" for a year)
const DST = resolve(ROOT, `public/vendor/pdfjs-${pkgEarly.version}`);
rmSync(resolve(ROOT, 'public/vendor'), { recursive: true, force: true });
mkdirSync(DST, { recursive: true });
// Copied with a .js extension: some static hosts serve .mjs as application/octet-stream,
// which browsers reject for ES modules / module workers.
const FILES = { 'pdf.min.mjs': 'pdf.min.js', 'pdf.worker.min.mjs': 'pdf.worker.min.js' };

// pdf.js is pinned to the 4.x legacy build on purpose: pdf.js 5+/6+ use
// `for await (... of readableStream)` in PDFPageProxy.getTextContent(), which Safari
// (macOS/iOS, all versions up to 26.x) does not support -> "undefined is not a function
// (near '...t of e...')" (mozilla/pdf.js#21557; the upstream fixes were not merged).
// 4.10.38 reads the text stream with a classic reader and works on Safari 16.4+.
// We still prepend a Web Streams async-iterator polyfill (main + worker are separate
// JS contexts) as a belt-and-braces measure for the remaining `for await` in the worker.
const STREAM_POLYFILL = `/* comparador: ReadableStream async-iterator polyfill for Safari <= 26 */
(function(){try{if(typeof ReadableStream==="undefined")return;var p=ReadableStream.prototype;if(typeof p[Symbol.asyncIterator]==="function")return;var v=function(o){var r=this.getReader(),pc=!!(o&&o.preventCancel);return{next:function(){return r.read()},return:function(x){var c=pc?Promise.resolve():r.cancel(x);return c.then(function(){r.releaseLock();return{value:x,done:true}})},[Symbol.asyncIterator]:function(){return this}}};Object.defineProperty(p,Symbol.asyncIterator,{value:v,writable:true,configurable:true});if(typeof p.values!=="function")Object.defineProperty(p,"values",{value:v,writable:true,configurable:true})}catch(e){}})();
`;
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
if (!/^4\./.test(pkg.version)) {
  console.error(`pdfjs-dist ${pkg.version} found – this project requires the 4.x legacy build (Safari compatibility). Run: npm i -D pdfjs-dist@4.10.38`);
  process.exit(1);
}
for (const [src, dst] of Object.entries(FILES)) {
  const code = readFileSync(resolve(SRC, src), 'utf8');
  writeFileSync(resolve(DST, dst), STREAM_POLYFILL + code);
  rmSync(resolve(DST, src), { force: true }); // stale copies from older versions of this script
  console.log(`copied ${src} -> ${dst} (+ streams polyfill)`);
}
const pt = resolve(ROOT, 'public/lib/pdf-text.js');
writeFileSync(pt, readFileSync(pt, 'utf8').replace(/const PDFJS_DIR = '\.\.\/vendor\/pdfjs-[^']*';/, `const PDFJS_DIR = '../vendor/pdfjs-${pkg.version}';`));
writeFileSync(resolve(ROOT, 'public/vendor/pdfjs.json'), JSON.stringify({ version: pkg.version, dir: `pdfjs-${pkg.version}` }) + '\n');
console.log(`pdf.js ${pkg.version} vendored into public/vendor/pdfjs-${pkg.version}`);
