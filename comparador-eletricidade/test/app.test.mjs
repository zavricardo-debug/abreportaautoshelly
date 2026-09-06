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
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')), text: async () => readFileSync(file, 'utf8'), blob: async () => new Blob([readFileSync(file)]) };
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

/* ------------------------------------------------------------------ Spanish flow */
test('Spanish bill: auto-detected, every cost line pre-filled, bill rebuilt to 89,84 € and compared concept by concept', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(d.querySelector('#dataset-pill-es').textContent, /\d+ tarifas ES/);

  const text = readFileSync(resolve(__dirname, 'fixtures/endesa-es-2026.txt'), 'utf8');
  const parsed = window.__test_text(text); // same path as handleFile() after pdf.js
  assert.equal(parsed.country, 'ES');
  assert.equal(d.body.dataset.country, 'ES');
  assert.ok(!d.querySelector('#step-values-es').classList.contains('hidden'));
  assert.ok(d.querySelector('#step-values').classList.contains('hidden'), 'Portuguese form stays hidden');

  const v = (sel) => d.querySelector(sel).value;
  assert.equal(v('#es-p1kw'), '4.6');
  assert.equal(v('#es-p2kw'), '4.6');
  assert.equal(v('#es-days'), '31');
  assert.match(v('#es-period'), /2026/);
  assert.equal(v('#es-supplier'), 'ENDESA');
  assert.ok(Math.abs(+v('#es-pp1') - 0.117686) < 2e-5);
  assert.ok(Math.abs(+v('#es-pp2') - 0.041554) < 5e-5);
  assert.ok(d.querySelector('#es-single').checked);
  assert.equal(v('#es-ep-single'), '0.167283');
  // consumption split from the meter readings 97 / 60 / 119 kWh scaled to the billed 277,224 kWh
  const kwh = ['punta', 'llano', 'valle'].map((k) => +v(`#es-kwh-${k}`));
  assert.ok(Math.abs(kwh[0] + kwh[1] + kwh[2] - 277.224) < 0.01, `sum ${kwh}`);
  assert.ok(Math.abs(kwh[0] / kwh[2] - 97 / 119) < 1e-3);
  assert.equal(v('#es-bono'), '0.024688');
  assert.equal(v('#es-rent'), '0.026774');
  assert.ok(Math.abs(+v('#es-ie') - 5.1126963) < 1e-6);
  assert.equal(v('#es-iva'), '21');
  assert.equal(v('#es-total'), '89.84');
  assert.match(d.querySelector('#es-parse-warnings').textContent, /6 de 6 conceptos/);
  assert.match(d.querySelector('#es-check').textContent, /89,84/);
  assert.match(d.querySelector('#es-check').textContent, /coincide/);
  assert.match(d.querySelector('#es-o-energy-total').textContent, /46,37/);
  assert.ok(d.querySelectorAll('#values-form-es input.auto').length >= 10, 'auto-filled fields highlighted');
  // step 2 table: every cost line of the bill (as read) next to the recomputed value – all equal
  const billLines = [...d.querySelectorAll('#es-bill-lines tbody tr')];
  const lineText = (r) => [...r.children].map((c) => c.textContent.trim());
  const expectLines = { 'Potencia P1 (punta-llano)': '16,78', 'Potencia P2 / P3 (valle)': '5,93', 'Energía (precio único)': '46,37', 'Financiación Bono Social': '0,77', 'Alquiler del contador': '0,83', 'Impuesto electricidad': '3,57', 'IVA 21 %': '15,59', 'TOTAL': '89,84' };
  for (const [label, amount] of Object.entries(expectLines)) {
    const r = billLines.find((x) => lineText(x)[0] === label);
    assert.ok(r, `bill line ${label}`);
    const cells = lineText(r);
    assert.match(cells[3], new RegExp(amount), `${label} read amount`);
    assert.match(cells[4], new RegExp(amount), `${label} recomputed amount`);
    assert.equal(cells[5], '=', `${label} matches`);
  }
  assert.equal(billLines.length, 8, 'no discount/services rows for this bill');

  d.querySelector('#values-form-es').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(!d.querySelector('#step-results-es').classList.contains('hidden'));
  const cards = [...d.querySelectorAll('#es-summary-grid .sum')];
  assert.ok(cards.length === 4, 'summary cards');
  assert.match(cards[0].textContent, /89,84/);
  assert.match(cards[1].textContent, /potencia 22,71/);
  assert.match(cards[1].textContent, /energía 46,37/);
  assert.match(cards[3].textContent, /Ahorro estimado/);

  const rows = [...d.querySelectorAll('#es-results-table tbody tr')];
  assert.ok(rows.length > 10, `rows ${rows.length}`);
  assert.ok(rows[0].classList.contains('baseline'));
  // baseline row shows the real bill lines: potencia 22,71 · energía 46,37 · regulados 1,60 · IE 3,57 · IVA 15,59 · total 89,84
  const cellsBase = [...rows[0].children].map((c) => c.textContent);
  assert.match(cellsBase[2], /22,71/); assert.match(cellsBase[3], /46,37/); assert.match(cellsBase[4], /1,60/);
  assert.match(cellsBase[5], /3,57/); assert.match(cellsBase[6], /15,59/); assert.match(cellsBase[7], /89,84/);
  assert.ok(rows[1].classList.contains('best'));
  // every offer row carries a per-concept delta; bono social + alquiler (1,60 €) never change –
  // only offers with an extra regulated line (Repsol SNOEE, indexed management fees) add to that column
  for (const r of rows.slice(1)) assert.ok(r.querySelectorAll('.cell-delta').length >= 6, 'deltas under each cost cell');
  const regulated = rows.slice(1).map((r) => r.children[4].textContent);
  assert.ok(regulated.filter((t) => /^1,60\s*€=$/.test(t)).length >= regulated.length / 2, regulated.join(' | '));
  assert.ok(regulated.every((t) => /^1,60\s*€=$/.test(t) || /\+/.test(t)), 'regulated column never goes below the bill');
  const totals = rows.slice(1).map((r) => Number(r.children[7].textContent.replace(/[^\d,]/g, '').replace(',', '.')));
  for (let i = 1; i < totals.length; i++) assert.ok(totals[i - 1] <= totals[i], 'sorted by total');
  assert.ok(totals[0] < 80, `best total ${totals[0]}`);
  // Endesa (current supplier) rows lose the welcome promotion / new-client offers are hidden for it
  const endesaRows = rows.slice(1).filter((r) => /^Endesa/.test(r.querySelector('.offer-name').textContent));
  assert.ok(endesaRows.length >= 1 && endesaRows.every((r) => r.classList.contains('current-supplier-es')));
  assert.ok(!endesaRows.some((r) => /Conecta/.test(r.textContent)), 'Conecta (new clients only) hidden for an Endesa customer');

  // CNMC deep link carries the profile
  const link = new URL(d.querySelector('#es-cnmc-link').href);
  assert.equal(link.hostname, 'comparador.cnmc.gob.es');
  assert.equal(link.searchParams.get('pP1'), '4.6');
  assert.equal(link.searchParams.get('iniA'), '2026-07-19');

  // detail modal: all concepts with "su factura" vs "esta tarifa"
  rows[1].querySelector('button').click();
  const body = d.querySelector('#modal-body').textContent;
  for (const c of ['Potencia P1', 'Potencia P2', 'Energía', 'Financiación Bono Social', 'Alquiler del contador', 'Impuesto electricidad', 'IVA 21 %', 'TOTAL', 'Fuente de los precios']) assert.match(body, new RegExp(c));
  assert.match(body, /Ahorro respecto a su factura/);
  d.querySelector('#modal-close').click();

  // filters: only best per supplier -> unique suppliers
  const best = d.querySelector('#es-flt-best'); best.checked = true; best.dispatchEvent(new window.Event('change', { bubbles: true }));
  const names = [...d.querySelectorAll('#es-results-table tbody tr')].slice(1).map((r) => r.querySelector('.offer-name').textContent.split(' · ')[0]);
  assert.equal(new Set(names).size, names.length);
});

test('Spanish manual mode: defaults, 3-period prices and reconstruction check', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  d.querySelector('#btn-manual-es').click();
  assert.ok(!d.querySelector('#step-values-es').classList.contains('hidden'));
  assert.ok(d.querySelector('#step-values').classList.contains('hidden'));
  assert.equal(d.querySelector('#es-bono').value, '0.024688');
  assert.equal(d.querySelector('#es-iva').value, '21');
  const set = (sel, v) => { const el = d.querySelector(sel); el.value = v; el.dispatchEvent(new window.Event('input', { bubbles: true })); };
  const single = d.querySelector('#es-single'); single.checked = false; single.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.ok(d.querySelector('#es-single-row').classList.contains('hidden'));
  set('#es-p1kw', '3.45'); set('#es-p2kw', '3.45'); set('#es-days', '30');
  set('#es-pp1', '0.1'); set('#es-pp2', '0.05');
  set('#es-kwh-punta', '80'); set('#es-kwh-llano', '70'); set('#es-kwh-valle', '120');
  set('#es-ep-punta', '0.2'); set('#es-ep-llano', '0.15'); set('#es-ep-valle', '0.1');
  assert.match(d.querySelector('#es-o-energy-total').textContent, /38,50/);
  d.querySelector('#values-form-es').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(!d.querySelector('#step-results-es').classList.contains('hidden'));
  assert.match(d.querySelector('#es-results-sub').textContent, /3,45 kW punta/);
  const baseCells = [...d.querySelector('#es-results-table tbody tr').children].map((c) => c.textContent);
  assert.match(baseCells[2], /15,53/);   // 3,45 × 0,1 × 30 + 3,45 × 0,05 × 30 = 10,35 + 5,18
  assert.match(baseCells[3], /38,50/);
  // switching the PT manual button back hides the Spanish sections
  d.querySelector('#btn-manual').click();
  assert.ok(d.querySelector('#step-values-es').classList.contains('hidden'));
  assert.ok(!d.querySelector('#step-values').classList.contains('hidden'));
});

test('Spanish flow with an hourly consumption CSV: real punta/llano/valle split drives the comparison', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  window.__test_text(readFileSync(resolve(__dirname, 'fixtures/endesa-es-2026.txt'), 'utf8'));
  const v = (sel) => d.querySelector(sel).value;
  // bill split (from the meter readings 97/60/119)
  assert.ok(Math.abs(+v('#es-kwh-punta') - 97.43) < 0.01);

  // a Datadis-format curve for the billing period: everything in valle except 2 kWh/day in punta
  let csv = 'CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion\n';
  const start = new Date(2026, 6, 19);
  for (let i = 0; i < 31; i++) {
    const dt = new Date(2026, 6, 19 + i);
    const dd = `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/2026`;
    for (let h = 1; h <= 24; h++) csv += `ES0031;${dd};${h};${h <= 8 ? '0,900' : (h === 12 || h === 20) && dt.getDay() % 6 !== 0 ? '1,000' : '0,050'};R\n`;
  }
  const curve = window.__test_curve(csv, 'consumos.csv');
  assert.ok(curve, 'curve parsed');
  assert.equal(curve.days, 31);
  assert.equal(curve.format, 'Datadis / CNMC');
  assert.ok(!d.querySelector('#es-curve-result').classList.contains('hidden'));
  assert.ok(d.querySelector('#es-curve-error').classList.contains('hidden'));
  assert.equal(d.querySelectorAll('#es-curve-weekday rect').length, 24);
  assert.equal(d.querySelectorAll('#es-curve-weekday rect.punta').length, 8);
  assert.equal(d.querySelectorAll('#es-curve-weekend rect.valle').length, 24);
  assert.match(d.querySelector('#es-curve-summary').textContent, /31 días/);
  assert.match(d.querySelector('#es-split-hint').textContent, /Reparto REAL/);
  // real shares applied to the billed 277,224 kWh (the curve total differs from the bill)
  const kwh = ['punta', 'llano', 'valle'].map((k) => +v(`#es-kwh-${k}`));
  assert.ok(Math.abs(kwh[0] + kwh[1] + kwh[2] - 277.224) < 0.01, `sum ${kwh}`);
  assert.ok(Math.abs(kwh[2] / 277.224 - curve.share.valle) < 1e-3, 'valle share from the curve');
  assert.ok(curve.share.valle > 0.7, `mostly valle: ${curve.share.valle}`);
  // the bill itself is still reconstructed exactly (single price: the split does not change the energy amount)
  assert.match(d.querySelector('#es-check').textContent, /89,84/);

  d.querySelector('#values-form-es').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(d.querySelector('#es-results-sub').textContent, /reparto REAL de su curva horaria/);
  const rows = [...d.querySelectorAll('#es-results-table tbody tr')];
  assert.ok(rows.length > 10);
  // with 70 %+ of the consumption in valle a 3-period tariff must win and the row is flagged
  assert.match(rows[1].querySelector('.offer-name').textContent, /3 Periodos|Noche|Programa|Octopus 3/);
  assert.ok([...rows[1].querySelectorAll('.badge')].some((b) => /consumo real por horas/.test(b.textContent)));
  // per-period energy table
  const pt = d.querySelector('#es-period-table');
  assert.ok(!d.querySelector('#es-period-box').classList.contains('hidden'));
  assert.match(d.querySelector('#es-pt-valle').textContent, /kWh · \d+ %/);
  const ptRows = [...pt.querySelectorAll('tbody tr')];
  assert.ok(ptRows.length === rows.length, 'one row per shown tariff + baseline');
  assert.match(ptRows[0].textContent, /Su factura actual/);
  assert.match(ptRows[0].textContent, /46,37/);
  // what-if: shift 25 % of punta+llano to valle -> cheaper 3-period totals
  const before = Number(rows[1].children[7].textContent.replace(/[^\d,]/g, '').replace(',', '.'));
  const sh = d.querySelector('#es-flt-shift'); sh.value = '0.25'; sh.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(d.querySelector('#es-results-sub').textContent, /trasladar el 25 %/);
  const after = Number(d.querySelectorAll('#es-results-table tbody tr')[1].children[7].textContent.replace(/[^\d,]/g, '').replace(',', '.'));
  assert.ok(after < before, `shift lowers the best total: ${after} < ${before}`);
  // baseline row unchanged (the bill is what it is)
  assert.match(d.querySelectorAll('#es-results-table tbody tr')[0].children[7].textContent, /89,84/);

  // switch the curve off -> back to the bill's own split
  const use = d.querySelector('#es-curve-use'); use.checked = false; use.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(Math.abs(+v('#es-kwh-punta') - 97.43) < 0.01);
  // unreadable file -> error, curve dropped
  assert.equal(window.__test_curve('Nombre;Apellido\nAna;García', 'malo.csv'), null);
  assert.ok(!d.querySelector('#es-curve-error').classList.contains('hidden'));
  assert.match(d.querySelector('#es-curve-error').textContent, /malo\.csv/);
});
