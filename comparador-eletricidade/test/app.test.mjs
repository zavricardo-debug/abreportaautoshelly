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
    const bytes = () => { const b = readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file, 'utf8')), text: async () => readFileSync(file, 'utf8'), blob: async () => new Blob([readFileSync(file)]), arrayBuffer: async () => bytes() };
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
  // results table: energy per period "su factura → tarifa" inside the Energía cell (baseline shows only what is paid today)
  const peBase = [...rows[0].querySelectorAll('.period-energy .pe-row')];
  assert.equal(peBase.length, 3);
  assert.match(peBase[2].textContent, /^Valle/);
  assert.equal(rows[0].querySelectorAll('.pe-arrow').length, 0);
  const num = (t) => Number(t.replace(/[^\d,−-]/g, '').replace('−', '-').replace(',', '.'));
  const peBest = [...rows[1].querySelectorAll('.period-energy .pe-row')];
  assert.equal(peBest.length, 3);
  assert.equal(rows[1].querySelectorAll('.pe-arrow').length, 3);
  const nowSum = peBest.reduce((a, r) => a + num(r.querySelector('.pe-now').textContent), 0);
  const offSum = peBest.reduce((a, r) => a + num(r.querySelector('.pe-off').textContent), 0);
  assert.ok(Math.abs(nowSum - 46.37) < 0.03, `today per period sums to the bill's energy: ${nowSum}`);
  assert.ok(Math.abs(offSum - num(rows[1].children[3].firstChild.textContent)) < 0.03, `offer per period sums to its Energía cell: ${offSum}`);
  // detail modal of the best tariff: per-period table (today vs. this tariff) + hour-by-hour energy cost from the curve
  rows[1].querySelector('button').click();
  const hb = d.querySelector('#modal-body');
  const pc = hb.querySelector('table.periods-cmp');
  assert.ok(pc, 'per-period comparison table present');
  assert.match(pc.querySelector('thead').textContent, /Paga hoy.*Con esta tarifa.*Diferencia/);
  const pcRows = [...pc.querySelectorAll('tbody tr')];
  assert.equal(pcRows.length, 4, 'punta, llano, valle, total');
  assert.match(pcRows[0].textContent, /Punta.*\(único\)/, 'single-price bill: the same €/kWh in every period');
  assert.ok(Math.abs(num(pcRows[3].children[3].textContent) - 46.37) < 0.02, 'today total = bill energy');
  assert.ok(Math.abs(num(pcRows[3].children[5].textContent) - num(rows[1].children[3].firstChild.textContent)) < 0.02, 'offer total = its Energía cell');
  // the invoice table shows the "su factura" energy per period with the single price (no more "(precio único)" placeholders)
  const invEnergy = [...hb.querySelectorAll('table.invoice:not(.periods-cmp):not(.hourly) tbody tr')].filter((r) => /^Energía (punta|llano|valle)/.test(r.textContent));
  assert.equal(invEnergy.length, 3);
  assert.ok(Math.abs(invEnergy.reduce((a, r) => a + num(r.children[3].textContent.split('€')[0] + '€'), 0) - 46.37) < 0.03, 'per-period "su factura" amounts sum to 46,37');
  assert.match(invEnergy[0].children[3].textContent, /0,167283 €\/kWh \(precio único\)/);
  assert.ok(hb.querySelector('#hourly-detail'), 'hourly section present when a curve drives the comparison');
  assert.match(hb.querySelector('#hourly-detail').textContent, /Energía hora a hora con su consumo real/);
  assert.match(hb.querySelector('#hourly-detail').textContent, /consumos\.csv/);
  assert.match(hb.querySelector('#hourly-detail').textContent, /escalados a los 277 kWh facturados/);
  const hRows = [...hb.querySelectorAll('table.hourly tbody tr')];
  assert.equal(hRows.length, 25, '24 hours + total');
  assert.match(hRows[0].children[0].textContent, /^00–01$/);
  assert.match(hRows[0].querySelector('.pchip').textContent, /Valle/);            // 0-1 h is valle every day
  assert.match(hRows[12].querySelector('.pchip').textContent, /Punta/);           // 12-13 h: punta on weekdays (dominant), valle at weekends
  assert.ok(hRows[12].querySelectorAll('.pchip').length >= 2, 'weekday punta + weekend valle chips');
  assert.equal(hb.querySelectorAll('table.hourly thead th').length, 6, 'hour, period, kWh, su tarifa, esta tarifa, diferencia');
  const totalRow = hRows[24];
  assert.match(totalRow.textContent, /Total energía/);
  const kwhSum = hRows.slice(0, 24).reduce((a, r) => a + num(r.children[2].textContent.split(' ')[0]), 0);
  assert.ok(Math.abs(kwhSum - 277.2) < 0.5, `hour kWh sum ${kwhSum}`);
  assert.ok(Math.abs(num(totalRow.children[3].textContent) - 46.37) < 0.02, `base energy ${totalRow.children[3].textContent}`); // = "Su factura" energy line
  assert.equal(hb.querySelectorAll('#hourly-detail svg rect').length, 48, 'two bars per hour');
  d.querySelector('#modal-close').click();
  // baseline detail: single set of bars, cost column only
  rows[0].querySelector('button').click();
  assert.equal(hb.querySelectorAll('#hourly-detail svg rect').length, 24);
  assert.equal(hb.querySelectorAll('table.hourly thead th').length, 4);
  d.querySelector('#modal-close').click();
  // what-if: shift 25 % of punta+llano to valle -> cheaper 3-period totals
  const before = Number(rows[1].children[7].textContent.replace(/[^\d,]/g, '').replace(',', '.'));
  const sh = d.querySelector('#es-flt-shift'); sh.value = '0.25'; sh.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(d.querySelector('#es-results-sub').textContent, /trasladar el 25 %/);
  const after = Number(d.querySelectorAll('#es-results-table tbody tr')[1].children[7].textContent.replace(/[^\d,]/g, '').replace(',', '.'));
  assert.ok(after < before, `shift lowers the best total: ${after} < ${before}`);
  // the hourly detail follows the what-if scenario and its total matches the tariff's energy line
  const bestRow = d.querySelectorAll('#es-results-table tbody tr')[1]; bestRow.querySelector('button').click();
  assert.match(hb.querySelector('#hourly-detail').textContent, /trasladar el 25 %/);
  const energyLine = [...hb.querySelectorAll('table.invoice:not(.hourly) tbody tr')].find((r) => /Energía \(total\)/.test(r.textContent));
  const shownEnergy = num(energyLine.children[4].textContent);
  const hourlyTotal = num([...hb.querySelectorAll('table.hourly tbody tr')].pop().children[4].textContent);
  assert.ok(Math.abs(shownEnergy - hourlyTotal) < 0.03, `hourly total ${hourlyTotal} = energy line ${shownEnergy}`);
  d.querySelector('#modal-close').click();
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

test('Portuguese flow with the E-Redes consumption Excel: real vazio/cheias/ponta split, bi/tri-horário comparison, cycle switch, what-if', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  const v = (sel) => d.querySelector(sel).value;
  const kwhRows = () => [...d.querySelectorAll('#energy-rows input.kwh')].map((i) => +i.value);
  // bi-horária EDP invoice (ciclo diário, 245 + 168 kWh, 05/08 → 04/09/2026)
  const p = window.__test_text(readFileSync(resolve(__dirname, 'fixtures/edp-bihoraria-extracted.txt'), 'utf8'));
  assert.equal(p.option, 2); assert.equal(p.cycle, 'diario');
  assert.deepEqual(kwhRows(), [245, 168]);

  // drop the E-Redes Excel on the main dropzone -> routed to the PT curve box
  const b = readFileSync(resolve(PUBLIC, 'samples/consumos-eredes-exemplo.xlsx'));
  window.__test_curve_buffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'consumos-eredes-exemplo.xlsx');
  assert.equal(d.body.dataset.country, 'PT');
  assert.ok(d.querySelector('#pt-curve-error').classList.contains('hidden'), d.querySelector('#pt-curve-error').textContent);
  assert.ok(!d.querySelector('#pt-curve-result').classList.contains('hidden'));
  assert.equal(v('#pt-curve-cycle'), 'diario', 'cycle taken from the invoice');
  assert.match(d.querySelector('#pt-curve-summary').textContent, /38 dias/);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /Consumo no período da fatura/);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /Potência máxima registada/);
  assert.equal(d.querySelectorAll('#pt-curve-table tbody tr').length, 5);
  assert.equal(d.querySelectorAll('#pt-curve-util rect').length, 96);
  assert.ok(d.querySelectorAll('#pt-curve-util rect.ponta').length > 0);
  assert.equal(d.querySelectorAll('#pt-curve-domingo rect.vazio').length, 40, 'ciclo diário: Sunday still has 10 h vazio (22-08)');
  // real split applied to the 413 kWh of the invoice
  const kw = kwhRows();
  assert.ok(Math.abs(kw[0] + kw[1] - 413) < 0.01, `sum ${kw}`);
  assert.ok(kw[1] < 168, 'the household uses less vazio than the invoice split suggested');
  assert.match(d.querySelector('#pt-split-hint').textContent, /Repartição REAL .* ciclo diário/);
  assert.equal(v('#flt-option'), 'all', 'loading a curve switches the comparison to all options');

  // comparison over simples + bi + tri with the real split
  d.querySelector('#values-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const sub = () => d.querySelector('#results-sub').textContent;
  assert.match(sub(), /Opções comparadas: simples, bi-horária, tri-horária/);
  assert.match(sub(), /consumo por período REAL/);
  const rows = () => [...d.querySelectorAll('#results-table tbody tr')];
  assert.ok(rows().length > 10);
  const optBadges = new Set(rows().slice(1).map((r) => r.querySelector('.badge.opt')?.textContent));
  assert.ok(optBadges.has('simples') && (optBadges.has('bi-horária') || optBadges.has('tri-horária')), `options shown: ${[...optBadges]}`);
  const total = (tr) => Number(tr.children[4].textContent.replace(/[^\d,]/g, '').replace(',', '.'));
  assert.ok(Math.abs(total(rows()[0]) - 105.97) < 0.01, 'baseline reconstructed from the invoice prices');

  // only tri-horária
  const fo = d.querySelector('#flt-option'); fo.value = '3'; fo.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(sub(), /Opções comparadas: tri-horária/);
  assert.ok(rows().slice(1).every((r) => r.querySelector('.badge.opt')?.textContent === 'tri-horária'));
  assert.ok(rows().slice(1).every((r) => [...r.querySelectorAll('.badge')].some((x) => /consumo real por período/.test(x.textContent))));
  const bestTri = total(rows()[1]);
  // Energia cell: bill periods (fora de vazio / vazio) for the baseline; ponta/cheias/vazio "paga hoje → oferta" for a tri offer
  const numPT = (t) => Number(t.replace(/[^\d,−-]/g, '').replace('−', '-').replace(',', '.'));
  const baseCell = rows()[0].children[2];
  assert.deepEqual([...baseCell.querySelectorAll('.pe-k')].map((k) => k.textContent), ['Fora de Vazio', 'Vazio']);
  const triCell = rows()[1].children[2];
  assert.deepEqual([...triCell.querySelectorAll('.pe-k')].map((k) => k.textContent), ['Ponta', 'Cheias', 'Vazio']);
  const nowSum = [...triCell.querySelectorAll('.pe-now')].reduce((a, e) => a + numPT(e.textContent), 0);
  const baseNow = [...baseCell.querySelectorAll('.pe-off')].reduce((a, e) => a + numPT(e.textContent), 0);
  assert.ok(Math.abs(nowSum - baseNow) < 0.03, `what is paid today is the same money whichever way the periods are cut: ${nowSum} vs ${baseNow}`);
  // detail of the best tri-horária offer: per-period table + quarter-hours of the E-Redes file classified in ponta/cheias/vazio vs. the bi-horária bill
  rows()[1].querySelector('button').click();
  const mb = d.querySelector('#modal-body');
  const pc = mb.querySelector('table.periods-cmp');
  assert.ok(pc);
  const pcRows = [...pc.querySelectorAll('tbody tr')];
  assert.equal(pcRows.length, 4);
  assert.match(pcRows[0].textContent, /^Ponta/); assert.match(pcRows[3].textContent, /^Total energia/);
  assert.ok(Math.abs(numPT(pcRows[3].children[3].textContent) - baseNow) < 0.03, 'today total');
  assert.match(mb.querySelector('table.periods-cmp + p').textContent, /A sua fatura é bi-horária e esta oferta é tri-horária/);
  assert.ok(mb.querySelector('#hourly-detail'));
  const ht = mb.querySelector('#hourly-detail').textContent;
  assert.match(ht, /Energia hora a hora com o seu consumo real/);
  assert.match(ht, /Oferta tri-horária \(a sua fatura é bi-horária\), ciclo diário/);
  assert.match(ht, /registos de 15 min/);
  const hr = [...mb.querySelectorAll('table.hourly tbody tr')];
  assert.equal(hr.length, 25);
  assert.match(hr[9].querySelector('.pchip').textContent, /Cheias/);  // Aug/Sep = hora legal de Verão: 09-10 h is cheias (ponta 10:30-13 / 19:30-21)
  assert.match(hr[11].querySelector('.pchip').textContent, /Ponta/);
  assert.match(hr[10].textContent, /Cheias \d+ %.*Ponta \d+ %|Ponta \d+ %.*Cheias \d+ %/); // 10-11 h: 10:00-10:30 cheias + 10:30-11:00 ponta (quarter-hour resolution)
  assert.match(hr[23].querySelector('.pchip').textContent, /Vazio/);
  const tot = hr[24];
  assert.match(tot.textContent, /Total energia/);
  // total of the offer's hourly energy = the sum of its "Termo de Energia" lines in the invoice table above
  const energyLines = [...mb.querySelectorAll('table.invoice:not(.hourly) tbody tr')].filter((r) => /Termo de Energia/.test(r.textContent));
  const energySum = energyLines.reduce((a, r) => a + numPT(r.children[3].textContent), 0);
  assert.ok(Math.abs(numPT(tot.children[4].textContent) - energySum) < 0.03, `hourly ${tot.children[4].textContent} vs lines ${energySum}`);
  assert.equal(mb.querySelectorAll('#hourly-detail svg rect').length, 48);
  d.querySelector('#modal-close').click();
  // what-if: 25 % to vazio lowers the best tri-horária total, baseline unchanged
  const sh = d.querySelector('#flt-shift'); sh.value = '0.25'; sh.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(sub(), /25 % do consumo fora de vazio/);
  assert.ok(total(rows()[1]) < bestTri, `${total(rows()[1])} < ${bestTri}`);
  assert.ok(Math.abs(total(rows()[0]) - 105.97) < 0.01);
  sh.value = '0'; sh.dispatchEvent(new window.Event('change', { bubbles: true }));

  // switch to ciclo semanal -> different split, comparison re-run
  const cy = d.querySelector('#pt-curve-cycle'); cy.value = 'semanal'; cy.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.match(d.querySelector('#pt-split-hint').textContent, /ciclo semanal/);
  assert.notDeepEqual(kwhRows(), kw);
  assert.match(sub(), /ciclo semanal/);
  // form option -> tri-horária: three real kWh rows
  const fopt = d.querySelector('#f-option'); fopt.value = '3'; fopt.dispatchEvent(new window.Event('input', { bubbles: true }));
  const k3 = kwhRows();
  assert.equal(k3.length, 3); assert.ok(Math.abs(k3[0] + k3[1] + k3[2] - 413) < 0.01);
  fopt.value = '2'; fopt.dispatchEvent(new window.Event('input', { bubbles: true }));

  // curve off -> invoice kWh back; tri-horária no longer simulable without the file
  const use = d.querySelector('#pt-curve-use'); use.checked = false; use.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(kwhRows(), [245, 168]);
  assert.match(sub(), /tri-horária: não simulável sem o ficheiro/);
  use.checked = true; use.dispatchEvent(new window.Event('change', { bubbles: true }));
  // remove the file
  d.querySelector('#btn-pt-curve-clear').click();
  assert.ok(d.querySelector('#pt-curve-result').classList.contains('hidden'));
  assert.deepEqual(kwhRows(), [245, 168]);
  assert.equal(v('#flt-option'), 'fatura');

  // a "simples" invoice + the CSV twin: the split hint explains bi/tri shares and the comparison covers all options
  window.__test_text(readFileSync(resolve(__dirname, 'fixtures/endesa-sample-extracted.txt'), 'utf8'));
  const curve = window.__test_curve_pt(readFileSync(resolve(PUBLIC, 'samples/consumos-eredes-exemplo.csv'), 'utf8'), 'consumos.csv');
  assert.ok(curve && curve.days === 38);
  assert.deepEqual(kwhRows(), [157], 'simples: the invoice kWh stay');
  assert.match(d.querySelector('#pt-split-hint').textContent, /A fatura é simples/);
  d.querySelector('#values-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.match(sub(), /Opções comparadas: simples, bi-horária, tri-horária/);
  assert.ok(Math.abs(total(rows()[0]) - 40.87) < 0.01);
  // unreadable file -> error in the box, curve dropped
  assert.equal(window.__test_curve_pt('foo;bar\n1;2\n', 'x.csv'), null);
  assert.match(d.querySelector('#pt-curve-error').textContent, /Não foi possível ler "x.csv"/);
  assert.ok(d.querySelector('#pt-curve-result').classList.contains('hidden'));
});

test('Spanish flow accepts an Excel consumption file (Datadis layout) and a Spanish CSV dropped on the main dropzone is routed to the ES flow', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  const b = readFileSync(resolve(__dirname, 'fixtures/datadis-ejemplo.xlsx'));
  window.__test_curve_buffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'consumo.xlsx');
  assert.equal(d.body.dataset.country, 'ES');
  assert.ok(!d.querySelector('#step-values-es').classList.contains('hidden'));
  assert.ok(d.querySelector('#es-curve-error').classList.contains('hidden'), d.querySelector('#es-curve-error').textContent);
  assert.match(d.querySelector('#es-curve-summary').textContent, /Datadis/);
  assert.match(d.querySelector('#es-curve-summary').textContent, /2 días/);
  // legacy .xls (Excel 97-2003) with the Datadis layout is read too
  const x = readFileSync(resolve(__dirname, 'fixtures/datadis-ejemplo.xls'));
  window.__test_curve_buffer(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength), 'consumo.xls');
  assert.equal(d.body.dataset.country, 'ES');
  assert.ok(d.querySelector('#es-curve-error').classList.contains('hidden'), d.querySelector('#es-curve-error').textContent);
  assert.match(d.querySelector('#es-curve-summary').textContent, /2 días/);
  // a corrupt OLE container is refused with a clear message
  const ole = new Uint8Array(600); ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  window.__test_curve_buffer(ole.buffer, 'estranho.xls');
  assert.match(d.querySelector('#pt-curve-error').textContent, /Não foi possível ler "estranho.xls"/);
});

test('step 1 has a dedicated upload for the consumption file: .xls (Excel 97-2003) and HTML-table "xls" from E-Redes fill vazio/cheias/ponta before any invoice', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  const kwhRows = () => [...d.querySelectorAll('#energy-rows input.kwh')].map((i) => +i.value);
  assert.ok(d.querySelector('#curve-dropzone'), 'second dropzone present');
  assert.ok(d.querySelector('#curve-file-input').accept.includes('.xls'));
  // legacy .xls with E-Redes layout dropped BEFORE any invoice -> PT manual form pre-filled from the curve
  const x = readFileSync(resolve(__dirname, 'fixtures/eredes-datas-serial.xls'));
  window.__test_curve_buffer(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength), 'consumos.xls');
  assert.equal(d.body.dataset.country, 'PT');
  assert.ok(!d.querySelector('#step-values').classList.contains('hidden'));
  assert.ok(d.querySelector('#pt-curve-error').classList.contains('hidden'), d.querySelector('#pt-curve-error').textContent);
  assert.ok(!d.querySelector('#pt-curve-result').classList.contains('hidden'));
  assert.match(d.querySelector('#pt-curve-summary').textContent, /3 dias/);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /Excel 97-2003/);
  assert.equal(d.querySelector('#f-days').value, '3');
  // no invoice: the file's own kWh drive the form (simples -> total 72 kWh)
  assert.deepEqual(kwhRows(), [72]);
  const fopt = d.querySelector('#f-option'); fopt.value = '3'; fopt.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(kwhRows(), [12, 30, 30], 'flat 1 kW in February, ciclo diário: ponta 2 h, cheias 12 h, vazio 10 h per day');
  d.querySelector('#values-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok(d.querySelectorAll('#results-table tbody tr').length > 10);
  assert.match(d.querySelector('#results-sub').textContent, /consumo por período REAL/);
  // HTML table saved as .xls (portal export) via the step-1 input
  const html = readFileSync(resolve(__dirname, 'fixtures/eredes-tabela-html.xls'));
  window.__test_curve_buffer(html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength), 'export.xls');
  assert.ok(d.querySelector('#pt-curve-error').classList.contains('hidden'), d.querySelector('#pt-curve-error').textContent);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /tabela HTML/);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /2 dias/);
  // the sample button of step 1 loads the E-Redes example
  d.querySelector('#btn-curve-sample-main').click();
  for (let i = 0; i < 50 && !/38 dias/.test(d.querySelector('#pt-curve-summary').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(d.querySelector('#pt-curve-summary').textContent, /38 dias/);
});

test('unreadable consumption file: the error box shows what was decoded (diagnostic preview, sheet names); a two-sheet E-Redes .xls after a Spanish invoice is still routed to the PT flow', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  // Spanish invoice first (the situation reported by the user)
  window.__test_text(readFileSync(resolve(__dirname, 'fixtures/endesa-es-2026.txt'), 'utf8'));
  assert.equal(d.body.dataset.country, 'ES');
  // an .xls that is a real workbook but holds no consumption table -> ES flow error with preview of what was read
  const { readFileSync: rf } = await import('node:fs');
  const X = new Uint8Array(rf(resolve(__dirname, 'fixtures/datadis-ejemplo.xls')));
  // build a workbook-less situation cheaply: an HTML table with unrelated columns saved as .xls
  const html = '<html><body><table><tr><th>Concepto</th><th>Importe</th></tr><tr><td>Potencia</td><td>12,34</td></tr><tr><td>Energía</td><td>45,67</td></tr></table></body></html>';
  window.__test_curve_buffer(new TextEncoder().encode(html).buffer, 'consumos.xls');
  const err = d.querySelector('#es-curve-error');
  assert.ok(!err.classList.contains('hidden'));
  assert.match(err.textContent, /No se ha podido leer "consumos.xls"/);
  assert.ok(err.querySelector('details.err-preview'), 'diagnostic preview present');
  assert.match(err.querySelector('pre').textContent, /Concepto \| Importe/);
  assert.match(err.querySelector('pre').textContent, /Potencia \| 12,34/);
  // now a two-sheet E-Redes .xls (first sheet = info) -> content sniff over all sheets routes to PT and the second sheet is parsed
  const b = rf(resolve(__dirname, 'fixtures/eredes-duas-folhas.xls'));
  window.__test_curve_buffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'consumos.xls');
  assert.equal(d.body.dataset.country, 'PT');
  assert.ok(d.querySelector('#pt-curve-error').classList.contains('hidden'), d.querySelector('#pt-curve-error').textContent);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /folha "Consumos"/);
  assert.match(d.querySelector('#pt-curve-summary').textContent, /4 dias/);
  // PT flow: an unrecognised sheet -> PT error with preview + list of sheets tried
  const info = '<?xml version="1.0"?><Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="Resumo"><Table><Row><Cell><Data ss:Type="String">CPE</Data></Cell><Cell><Data ss:Type="String">PT0002000000000000AA</Data></Cell></Row><Row><Cell><Data ss:Type="String">Consumo registado</Data></Cell><Cell><Data ss:Type="Number">123</Data></Cell></Row></Table></Worksheet><Worksheet ss:Name="Notas"><Table><Row><Cell><Data ss:Type="String">Sem dados</Data></Cell><Cell><Data ss:Type="String">-</Data></Cell></Row><Row><Cell><Data ss:Type="String">Gerado</Data></Cell><Cell><Data ss:Type="String">2026-09-07</Data></Cell></Row></Table></Worksheet></Workbook>';
  window.__test_curve_buffer(new TextEncoder().encode(info).buffer, 'export.xls');
  const perr = d.querySelector('#pt-curve-error');
  assert.ok(!perr.classList.contains('hidden'));
  assert.match(perr.textContent, /Não foi possível ler "export.xls"/);
  assert.match(perr.textContent, /Folhas encontradas: Resumo, Notas/);
  assert.match(perr.querySelector('pre').textContent, /CPE \| PT0002000000000000AA/);
  assert.ok(X.length > 0);
});

test('Endesa "área de clientes" consumption .xls dropped in step 1 is routed to the Spanish flow; with the Endesa bill the real split replaces the estimate', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, async () => {
  const window = await boot();
  const d = window.document;
  for (let i = 0; i < 50 && !/tarifas ES ·/.test(d.querySelector('#dataset-pill-es').textContent); i++) await new Promise((r) => setTimeout(r, 20));
  // curve first (no invoice yet): the metadata rows ("Tarifa:", "Coste por hora") identify a Spanish file
  const b = readFileSync(resolve(__dirname, 'fixtures/endesa-clientes.xls'));
  window.__test_curve_buffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), 'consumos.xls');
  assert.equal(d.body.dataset.country, 'ES');
  assert.ok(!d.querySelector('#step-values-es').classList.contains('hidden'));
  const err = d.querySelector('#es-curve-error');
  assert.ok(err.classList.contains('hidden'), err.textContent);
  const sum = d.querySelector('#es-curve-summary').textContent;
  assert.match(sum, /Endesa \(área de clientes\)/);
  assert.match(sum, /ES0031600000000000AB0F/);
  assert.match(sum, /3 días/);
  assert.match(sum, /72,0 kWh/);
  // then the Endesa bill: the curve is outside the billing period -> its real shares are applied to the billed kWh
  window.__test_text(readFileSync(resolve(__dirname, 'fixtures/endesa-es-2026.txt'), 'utf8'));
  const c2 = readFileSync(resolve(__dirname, 'fixtures/endesa-clientes.csv'));
  window.__test_curve_buffer(c2.buffer.slice(c2.byteOffset, c2.byteOffset + c2.byteLength), 'consumos.csv');
  assert.ok(d.querySelector('#es-curve-error').classList.contains('hidden'), d.querySelector('#es-curve-error').textContent);
  assert.match(d.querySelector('#es-split-hint').textContent, /Reparto REAL/);
  const v = (sel) => +d.querySelector(sel).value;
  assert.ok(Math.abs(v('#es-kwh-punta') + v('#es-kwh-llano') + v('#es-kwh-valle') - 277.224) < 0.01);
  assert.ok(Math.abs(v('#es-kwh-valle') - 277.224 * 40 / 72) < 0.01, `valle ${v('#es-kwh-valle')}`);
});
