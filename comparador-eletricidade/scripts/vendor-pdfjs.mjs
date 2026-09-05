#!/usr/bin/env node
// Copies the pdf.js browser build from node_modules into public/vendor so the
// site works fully offline / self-hosted (no CDN).
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// Safari (up to 26.x) has no ReadableStream[Symbol.asyncIterator]; pdf.js 5 uses
// `for await (const chunk of readable)` (DecompressionStream in the worker,
// getTextContent in the main thread) -> "undefined is not a function (near '...t of e...')".
// The legacy build's core-js polyfills cover ECMAScript only, not this Web Streams API,
// so we prepend a tiny polyfill to both files (the worker is a separate JS context).
const STREAM_POLYFILL = `/* comparador: ReadableStream async-iterator polyfill for Safari <= 26 */
(function(){try{if(typeof ReadableStream==="undefined")return;var p=ReadableStream.prototype;if(typeof p[Symbol.asyncIterator]==="function")return;var v=function(o){var r=this.getReader(),pc=!!(o&&o.preventCancel);return{next:function(){return r.read()},return:function(x){var c=pc?Promise.resolve():r.cancel(x);return c.then(function(){r.releaseLock();return{value:x,done:true}})},[Symbol.asyncIterator]:function(){return this}}};Object.defineProperty(p,Symbol.asyncIterator,{value:v,writable:true,configurable:true});if(typeof p.values!=="function")Object.defineProperty(p,"values",{value:v,writable:true,configurable:true})}catch(e){}})();
`;
for (const [src, dst] of Object.entries(FILES)) {
  const code = readFileSync(resolve(SRC, src), 'utf8');
  writeFileSync(resolve(DST, dst), STREAM_POLYFILL + code);
  rmSync(resolve(DST, src), { force: true }); // stale copies from older versions of this script
  console.log(`copied ${src} -> ${dst} (+ streams polyfill)`);
}
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/pdfjs-dist/package.json'), 'utf8'));
console.log(`pdf.js ${pkg.version} vendored into public/vendor/pdfjs`);
