// Runs the real browser module (public/lib/pdf-text.js + vendored pdf.js) in Node,
// including a simulation of Safari <= 26, which lacks ReadableStream[Symbol.asyncIterator]
// (pdf.js 5 then throws "undefined is not a function (near '...t of e...')").
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '../public');
const vendored = existsSync(resolve(PUBLIC, 'vendor/pdfjs/pdf.min.js'));
const toAB = (f) => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

let mod;
before(async () => {
  // Simulate Safari BEFORE the module (and pdf.js) is loaded
  delete ReadableStream.prototype[Symbol.asyncIterator];
  assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], 'undefined');
  mod = await import('../public/lib/pdf-text.js');
});

test('browserSupport reports ok in a modern runtime', { skip: !vendored && 'run npm run vendor' }, () => {
  assert.deepEqual(mod.browserSupport(), { ok: true, missing: [] });
});

test('extracts text with pdf.js even without ReadableStream async iteration (Safari)', { skip: !vendored && 'run npm run vendor' }, async () => {
  const r = await mod.extractPdfText(toAB(resolve(PUBLIC, 'samples/fatura-exemplo-endesa.pdf')));
  assert.equal(r.numPages, 2);
  assert.ok(r.info.textItems > 50);
  assert.match(r.text, /Termo de Energia \(Real\) 157 kWh 0,166823 €/);
  assert.match(r.text, /Termo Fixo Acesso às Redes 31 dias 0,171800 €/);
  assert.match(r.text, /Imposto Especial Consumo \(Real\) 157 kWh/);
  // the vendored pdf.js carries the polyfill, so the iterator now exists
  assert.equal(typeof ReadableStream.prototype[Symbol.asyncIterator], 'function');
});

test('password-protected and image-only PDFs are reported distinctly', { skip: !vendored && 'run npm run vendor' }, async () => {
  const { default: PDFDocument } = await import('pdfkit');
  const { Writable } = await import('node:stream');
  const make = (opts, draw) => new Promise((res) => {
    const chunks = []; const doc = new PDFDocument({ size: 'A4', ...opts });
    doc.pipe(new Writable({ write(c, _e, cb) { chunks.push(c); cb(); }, final(cb) { res(Buffer.concat(chunks)); cb(); } }));
    draw(doc); doc.end();
  });
  const protectedPdf = await make({ userPassword: '123456789' }, (d) => d.text('Termo de Energia (Real) 100 kWh 0,15 € 15,00 €'));
  const imagePdf = await make({}, (d) => d.rect(20, 20, 200, 100).fill('#999'));
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

  await assert.rejects(mod.extractPdfText(ab(protectedPdf)), (e) => e.name === 'PasswordException' && e.code === 1);
  await assert.rejects(mod.extractPdfText(ab(protectedPdf), null, { password: 'nope' }), (e) => e.name === 'PasswordException' && e.code === 2);
  const ok = await mod.extractPdfText(ab(protectedPdf), null, { password: '123456789' });
  assert.match(ok.text, /Termo de Energia/);
  const img = await mod.extractPdfText(ab(imagePdf));
  assert.equal(img.info.textItems, 0);
  assert.equal(img.text.trim(), '');
});
