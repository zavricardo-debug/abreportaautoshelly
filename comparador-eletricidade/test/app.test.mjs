// UI smoke test: loads public/index.html + app.js in jsdom, fills the form the
// way the PDF parser would, runs the comparison and checks the rendered results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '../public');
const datasetPath = resolve(PUBLIC, 'data/ofertas.json');

async function boot() {
  const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: pathToFileURL(resolve(PUBLIC, 'index.html')).href, pretendToBeVisual: true });
  const { window } = dom;
  // jsdom lacks these
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.Element.prototype.scrollIntoView = () => {};
  // app.js uses the global fetch with relative URLs -> serve them from ./public
  globalThis.fetch = async (url) => {
    const file = resolve(PUBLIC, String(url));
    if (!existsSync(file)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')), blob: async () => new Blob([readFileSync(file)]) };
  };
  // expose globals for the app module
  for (const k of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'File', 'Blob', 'Intl', 'CustomEvent', 'Event']) {
    if (!(k in globalThis) || k === 'window' || k === 'document') globalThis[k] = k === 'Intl' ? Intl : window[k];
  }
  // fresh import per test (cache-bust)
  await import(pathToFileURL(resolve(PUBLIC, 'app.js')).href + `?t=${Date.now()}${Math.random()}`);
  // wait for dataset load
  for (let i = 0; i < 50 && !/ofertas ·/.test(window.document.querySelector('#dataset-pill').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  return window;
}

test('app boots, fills manual values, compares and renders results', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  assert.match(d.querySelector('#dataset-pill').textContent, /\d+ ofertas/);
  assert.ok(d.querySelectorAll('#f-supplier option').length > 20, 'supplier select filled');

  // manual mode
  d.querySelector('#btn-manual').click();
  assert.ok(!d.querySelector('#step-values').classList.contains('hidden'));

  const set = (sel, v) => { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  set('#f-power', '3.45');
  set('#f-option', '1');
  set('#f-days', '31');
  set('#energy-rows input.kwh', '157');
  set('#energy-rows input.eprice', String(24.88 / 157));
  set('#f-powerprice', String(4.46 / 31));
  set('#f-tarprice', '0.1718');
  set('#f-invoicetotal', '40.87');
  set('#f-supplier', 'END');
  assert.match(d.querySelector('#o-energy-total').textContent, /24,88/);

  d.querySelector('#values-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(!d.querySelector('#step-results').classList.contains('hidden'));

  const cards = [...d.querySelectorAll('#summary-grid .sum')];
  assert.ok(cards.length >= 3, 'summary cards rendered');
  assert.match(cards[0].textContent, /40,87/);
  assert.match(cards[0].textContent, /real: 40,87/);
  assert.match(cards.find((c) => /Tarifa regulada/.test(c.textContent)).textContent, /37,29/);

  const rows = [...d.querySelectorAll('#results-table tbody tr')];
  assert.ok(rows.length > 10, `rows rendered (${rows.length})`);
  assert.ok(rows[0].classList.contains('baseline'));
  assert.ok(rows[1].classList.contains('best'));
  // default filters: best per supplier -> supplier names unique among offer rows
  const names = rows.slice(1).map((r) => r.querySelector('.offer-name').textContent.split(' · ')[0]);
  assert.equal(new Set(names).size, names.length, 'one row per supplier with "best" filter');
  // Endesa rows are marked as current supplier
  assert.ok(rows.slice(1).some((r) => r.classList.contains('current-supplier')));

  // totals sorted ascending
  const totals = rows.slice(1).map((r) => Number(r.children[4].textContent.replace(/[^\d,]/g, '').replace(',', '.')));
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1] <= totals[i]);

  // toggle "best per supplier" off -> more rows
  const best = d.querySelector('#flt-best'); best.checked = false; best.dispatchEvent(new window.Event('change', { bubbles: true }));
  const rows2 = d.querySelectorAll('#results-table tbody tr').length;
  assert.ok(rows2 > rows.length, `${rows2} > ${rows.length}`);

  // detail modal
  d.querySelector('#results-table tbody tr.best button').click();
  const modal = d.querySelector('#detail-modal');
  assert.ok(modal.hasAttribute('open'));
  assert.match(d.querySelector('#modal-body').textContent, /Termo Fixo Acesso às Redes/);
  assert.match(d.querySelector('#modal-body').textContent, /Contribuição Audiovisual/);
  assert.match(d.querySelector('#modal-body').textContent, /Código ERSE/);
  d.querySelector('#modal-close').click();
  assert.ok(!modal.hasAttribute('open'));
});

test('switching to bi-horária re-renders two energy rows', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  d.querySelector('#btn-manual').click();
  const opt = d.querySelector('#f-option'); opt.value = '2'; opt.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(d.querySelectorAll('#energy-rows .period-row').length, 2);
  assert.match(d.querySelector('#energy-rows').textContent, /Fora de Vazio/);
  opt.value = '3'; opt.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(d.querySelectorAll('#energy-rows .period-row').length, 3);
});

test('sample PDF button: parsed values pre-fill the form and comparison runs', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  // Bypass pdf.js (no worker in jsdom): dispatch the parsed text through the same handler path
  // by stubbing extractPdfText via the module hook is not possible here, so we emulate the file
  // flow at the parser level: feed the extracted-text fixture into a File and the app's handler.
  const { parseInvoiceText } = await import('../public/lib/parser.js');
  const text = readFileSync(resolve(__dirname, 'fixtures/endesa-sample-extracted.txt'), 'utf8');
  const parsed = parseInvoiceText(text);
  window.__test_fill(parsed); // exposed by app.js for tests
  assert.ok(!d.querySelector('#step-values').classList.contains('hidden'));
  assert.equal(d.querySelector('#f-power').value, '3.45');
  assert.equal(d.querySelector('#f-option').value, '1');
  assert.equal(d.querySelector('#f-days').value, '31');
  assert.equal(d.querySelector('#f-supplier').value, 'END');
  assert.equal(d.querySelector('#energy-rows input.kwh').value, '157');
  assert.ok(Math.abs(Number(d.querySelector('#energy-rows input.eprice').value) - 24.88 / 157) < 1e-5);
  assert.ok(Math.abs(Number(d.querySelector('#f-powerprice').value) - 4.46 / 31) < 1e-5);
  assert.equal(d.querySelector('#f-tarprice').value, '0.171935');
  assert.equal(d.querySelector('#f-cav').value, '2.9');
  assert.equal(d.querySelector('#f-dgeg').value, '0.07');
  assert.equal(d.querySelector('#f-iec').value, '0.16');
  assert.equal(d.querySelector('#f-invoicetotal').value, '40.87');
  assert.match(d.querySelector('#parse-warnings').textContent, /6 de 6 rubricas/);
  assert.ok(d.querySelectorAll('#values-form input.auto').length >= 7, 'auto-filled fields highlighted');

  d.querySelector('#values-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const first = d.querySelector('#summary-grid .sum');
  assert.match(first.textContent, /40,87/); // simulated baseline equals the invoice total
});
