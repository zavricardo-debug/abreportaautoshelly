// Spanish flow (peaje 2.0TD): values form, line-by-line comparison and results UI.
// Loaded by app.js; activated when the uploaded bill is detected as Spanish or when the
// user clicks "No tengo PDF (España)". All strings of this flow are in Spanish, the
// same words the bill uses (Potencia, Energía, Bono Social, Alquiler, Impuesto, IVA).
import { simulateES, simulateAllES, splitConsumption, cnmcLink, PERIODS_ES, PERIOD_LABELS_ES, RULES_ES_2026 } from './lib/simulator-es.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const fmtEur = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtNum = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : new Intl.NumberFormat('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed = (v, d = 2) => `${v < 0 ? '−' : v > 0 ? '+' : ''}${fmtEur(Math.abs(v), d)}`;
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

export const ES = { dataset: null, parsed: null, form: null, baseline: null, results: [], rawText: '' };
let ui = { show: () => {}, hide: () => {}, showError: () => {}, hideError: () => {} };
const rules = () => ES.dataset?.rules || RULES_ES_2026;

/* ------------------------------------------------------------------ boot */
export async function initES(hooks) {
  ui = { ...ui, ...hooks };
  bindForm();
  bindFilters();
  try {
    const res = await fetch('data/ofertas-es.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    ES.dataset = await res.json();
    $('#dataset-pill-es').textContent = `${ES.dataset.meta.offers} tarifas ES · ${fmtDate(ES.dataset.meta.publishedAt)}`;
    $('#dataset-date-es').textContent = fmtDate(ES.dataset.meta.publishedAt);
    const sel = $('#es-supplier');
    for (const s of ES.dataset.suppliers) { const o = document.createElement('option'); o.value = s.code; o.textContent = s.name; sel.appendChild(o); }
    for (const [code, name] of [['PVPC', 'Comercializadora de referencia (PVPC)'], ['OTHER', 'Otra comercializadora']]) { const o = document.createElement('option'); o.value = code; o.textContent = name; sel.appendChild(o); }
    const fsel = $('#es-flt-supplier');
    for (const s of ES.dataset.suppliers) { const o = document.createElement('option'); o.value = s.code; o.textContent = s.name; fsel.appendChild(o); }
  } catch (e) {
    $('#dataset-pill-es').textContent = 'error tarifas ES';
    console.error('ofertas-es.json', e);
  }
}

/* ------------------------------------------------------------------ form */
export function showManualES() {
  ES.parsed = null;
  ES.rawText = '';
  fillFormES(null, '');
  $('#es-raw-text').textContent = '';
  ui.show('#step-values-es');
  $('#step-values-es').scrollIntoView({ behavior: 'smooth' });
}

const setVal = (sel, v, auto) => {
  const el = $(sel);
  el.value = (v === null || v === undefined || v === '' || Number.isNaN(v)) ? '' : +(+v).toFixed(7); // 7 decimals: the IE rate is 5,1126963 %
  el.classList.toggle('auto', !!auto && el.value !== '');
};

/** Fill the Spanish form from the parser output (or defaults when p is null = manual mode). */
export function fillFormES(p, rawText) {
  ES.parsed = p;
  ES.rawText = rawText || '';
  const R = rules();
  $$('#values-form-es input').forEach((i) => i.classList.remove('auto'));
  $('#es-supplier-tag').textContent = p?.supplier ? `Factura ${p.supplier}${p.contractName ? ' · ' + p.contractName : ''}` : '';

  const p1 = p?.power?.p1 ?? p?.powerTerm?.p1?.kw ?? (p ? '' : 4.6);
  const p2 = p?.power?.p2 ?? p?.powerTerm?.p2?.kw ?? p1;
  setVal('#es-p1kw', p1, p); setVal('#es-p2kw', p2, p);
  setVal('#es-days', p?.days ?? 30, p && p.days);
  $('#es-period').value = p?.period ? `${fmtDate(p.period.start)} → ${fmtDate(p.period.end)}` : '';
  $('#es-period').dataset.start = p?.period?.start || '';
  $('#es-supplier').value = p?.supplierCode && $(`#es-supplier option[value="${p.supplierCode}"]`) ? p.supplierCode : (p?.supplierCode ? 'OTHER' : '');
  setVal('#es-pp1', p?.powerTerm?.p1?.price, p);
  setVal('#es-pp2', p?.powerTerm?.p2?.price ?? p?.powerTerm?.p1?.price, p);

  // energy
  const single = p ? !!p.energy?.single || !p.energy?.byPeriod || !Object.keys(p.energy.byPeriod).length : true;
  $('#es-single').checked = single;
  let kwh = { punta: '', llano: '', valle: '' };
  let hint = 'Introduzca el consumo de cada periodo (punta / llano / valle). Si su factura tiene precio único, el reparto sólo se usa para simular las tarifas con discriminación horaria.';
  if (p) {
    if (single) {
      const total = p.energy?.kwh || 0;
      const split = splitConsumption(total, p.energy?.readings, R.defaultSplit);
      kwh = { punta: r3(split.punta), llano: r3(split.llano), valle: r3(split.valle) };
      hint = p.energy?.readings
        ? `Consumo facturado ${fmtNum(total, 3)} kWh a precio único. Reparto por periodos según las lecturas de la factura (punta ${fmtNum(p.energy.readings.punta ?? 0, 0)} · llano ${fmtNum(p.energy.readings.llano ?? 0, 0)} · valle ${fmtNum(p.energy.readings.valle ?? 0, 0)} kWh) – sólo se usa para simular tarifas con discriminación horaria.`
        : `Consumo facturado ${fmtNum(total, 3)} kWh a precio único. La factura no indica el consumo por periodos: se usa un reparto estimado (${Math.round(R.defaultSplit.punta * 100)} / ${Math.round(R.defaultSplit.llano * 100)} / ${Math.round(R.defaultSplit.valle * 100)} %) para las tarifas con discriminación horaria – ajústelo si conoce sus consumos.`;
      setVal('#es-ep-single', p.energy?.price, p);
    } else {
      for (const k of PERIODS_ES) { kwh[k] = r3(p.energy.byPeriod[k]?.kwh || 0); setVal(`#es-ep-${k}`, p.energy.byPeriod[k]?.price, p); }
      hint = `Consumo facturado por periodos: ${PERIODS_ES.map((k) => `${PERIOD_LABELS_ES[k].toLowerCase()} ${fmtNum(kwh[k], 3)} kWh`).join(' · ')}.`;
      setVal('#es-ep-single', p.energy?.amount && p.energy?.kwh ? p.energy.amount / p.energy.kwh : null, false);
    }
  } else {
    setVal('#es-ep-single', '', false);
    for (const k of PERIODS_ES) setVal(`#es-ep-${k}`, '', false);
  }
  for (const k of PERIODS_ES) setVal(`#es-kwh-${k}`, kwh[k], p);
  $('#es-split-hint').textContent = hint;

  // regulated + taxes
  setVal('#es-bono', p?.bonoSocial?.price ?? R.bonoSocialPerDay, p && p.bonoSocial);
  setVal('#es-rent', p?.meterRent?.price ?? R.meterRentPerDay, p && p.meterRent);
  setVal('#es-ie', (p?.ie?.rate ?? R.ieRate) * 100, p && p.ie);
  setVal('#es-iva', (p?.iva?.rate ?? R.iva) * 100, p && p.iva);
  setVal('#es-other', p ? r2((p.discountAmount || 0) + (p.feeAmount || 0)) || '' : '', p && ((p.discountAmount || 0) !== 0 || (p.feeAmount || 0) !== 0));
  setVal('#es-services', p ? (p.serviceAmount || '') : '', p && (p.serviceAmount || 0) !== 0);
  setVal('#es-total', p?.total, p && p.total !== null);

  // warnings / found lines
  const w = $('#es-parse-warnings'); w.innerHTML = '';
  if (p) {
    const labels = { power: 'Potencia', energy: 'Energía', bonoSocial: 'Financiación Bono Social', meterRent: 'Alquiler del contador', ie: 'Impuesto electricidad', iva: 'IVA' };
    const found = Object.keys(labels).filter((id) => p.items.some((it) => it.id === id));
    const missing = Object.keys(labels).filter((k) => !found.includes(k));
    const ok = document.createElement('div');
    ok.className = `alert ${missing.length > 2 ? 'warn' : 'ok'}`;
    ok.innerHTML = `<b>Factura española (2.0TD) · ${found.length} de 6 conceptos encontrados</b>: ${found.map((k) => labels[k]).join(', ') || '—'}.` +
      (missing.length ? `<br>No encontrados: ${missing.map((k) => labels[k]).join(', ')} – complete los valores manualmente si es necesario.` : '') +
      (p.total !== null ? ` Total de la factura: <b>${fmtEur(p.total)}</b>.` : '');
    w.appendChild(ok);
    if (p.warnings?.length) { const el = document.createElement('div'); el.className = 'alert warn'; el.innerHTML = `<ul>${p.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`; w.appendChild(el); }
  } else {
    const el = document.createElement('div'); el.className = 'alert info';
    el.textContent = 'Introduzca los valores tal como aparecen en su factura (precios sin impuestos). Los conceptos regulados ya vienen rellenados con los valores vigentes.';
    w.appendChild(el);
  }
  toggleSingle();
  updateDerivedES();
}
const r3 = (v) => Math.round((v + Number.EPSILON) * 1000) / 1000;

function bindForm() {
  const f = $('#values-form-es');
  f.addEventListener('input', (e) => {
    e.target.classList.remove('auto');
    if (e.target.id === 'es-single') toggleSingle();
    updateDerivedES();
  });
  f.addEventListener('submit', (e) => { e.preventDefault(); runComparisonES(); });
}

function toggleSingle() {
  const single = $('#es-single').checked;
  $('#es-single-row').classList.toggle('hidden', !single);
  for (const k of PERIODS_ES) {
    const inp = $(`#es-ep-${k}`);
    inp.disabled = single; inp.required = !single;
    inp.closest('label').classList.toggle('hidden', single);
    $(`#es-o-e-${k}`).closest('label').classList.toggle('hidden', single);
  }
  $('#es-ep-single').required = single;
}

export function readFormES() {
  const num = (sel) => { const v = $(sel).value; return v === '' ? null : +v; };
  const kwh = {}; const energyPrice = {};
  for (const k of PERIODS_ES) { kwh[k] = num(`#es-kwh-${k}`) || 0; energyPrice[k] = num(`#es-ep-${k}`) || 0; }
  return {
    single: $('#es-single').checked,
    kwh, energyPrice, energySingle: num('#es-ep-single') || 0,
    power: { p1: num('#es-p1kw') || 0, p2: num('#es-p2kw') || num('#es-p1kw') || 0 },
    powerPrice: { p1: num('#es-pp1') || 0, p2: num('#es-pp2') || 0 },
    days: num('#es-days') || 30,
    bonoPerDay: num('#es-bono') ?? rules().bonoSocialPerDay,
    rentPerDay: num('#es-rent') ?? rules().meterRentPerDay,
    ieRate: (num('#es-ie') ?? rules().ieRate * 100) / 100,
    ivaRate: (num('#es-iva') ?? rules().iva * 100) / 100,
    otherAmount: num('#es-other') || 0,
    servicesAmount: num('#es-services') || 0,
    invoiceTotal: num('#es-total'),
    supplierCode: $('#es-supplier').value || null,
    postalCode: ($('#es-cp').value || '').trim(),
    periodStart: $('#es-period').dataset.start || null,
  };
}
const profileOf = (f) => ({ days: f.days, power: f.power, kwh: f.kwh, meterRentPerDay: f.rentPerDay, bonoSocialPerDay: f.bonoPerDay, ieRate: f.ieRate, ivaRate: f.ivaRate });
const basePricesOf = (f) => ({ energy: f.single ? { single: f.energySingle } : { ...f.energyPrice }, power: { ...f.powerPrice }, otherAmount: f.otherAmount || 0, otherLabel: f.otherAmount < 0 ? 'Descuentos de su tarifa' : 'Cuotas de su tarifa' });
/** Optional services (maintenance, insurance…) are outside the electricity tariff: IVA only, no impuesto eléctrico. */
const servicesWithIva = (f) => r2((f.servicesAmount || 0) * (1 + (f.ivaRate ?? rules().iva)));

function updateDerivedES() {
  const f = readFormES();
  const totalKwh = PERIODS_ES.reduce((a, k) => a + f.kwh[k], 0);
  $('#es-o-kwh').textContent = `${fmtNum(totalKwh, 3)} kWh`;
  $('#es-o-pp1').textContent = fmtEur(f.power.p1 * f.powerPrice.p1 * f.days);
  $('#es-o-pp2').textContent = fmtEur(f.power.p2 * f.powerPrice.p2 * f.days);
  if (f.single) {
    $('#es-o-e-single').textContent = fmtEur(totalKwh * f.energySingle);
    $('#es-o-energy-total').textContent = fmtEur(totalKwh * f.energySingle);
  } else {
    let t = 0;
    for (const k of PERIODS_ES) { const a = f.kwh[k] * f.energyPrice[k]; t += a; $(`#es-o-e-${k}`).textContent = fmtEur(a); }
    $('#es-o-energy-total').textContent = fmtEur(t);
  }
  // reconstruction check
  const sim = simulateES(profileOf(f), basePricesOf(f), rules());
  const services = servicesWithIva(f);
  const reconstructed = r2(sim.total + services);
  const box = $('#es-check');
  const parts = `Potencia ${fmtEur(sim.powerAmount)} + Energía ${fmtEur(sim.energyAmount)}${sim.other ? ` ${sim.other < 0 ? '−' : '+'} Descuentos/cuotas ${fmtEur(Math.abs(sim.other))}` : ''} + Bono social ${fmtEur(sim.bonoSocial)} + Alquiler ${fmtEur(sim.meterRent)} + Impuesto electricidad ${fmtEur(sim.ie)} + IVA ${fmtEur(sim.iva)}${services ? ` + Servicios adicionales ${fmtEur(services)} (IVA incl.)` : ''}`;
  if (f.invoiceTotal) {
    const d = r2(reconstructed - f.invoiceTotal);
    box.className = `alert ${Math.abs(d) <= 0.05 ? 'ok' : 'warn'}`;
    box.innerHTML = `<b>Comprobación:</b> con estos valores la factura se reconstruye en <b>${fmtEur(reconstructed)}</b> (${parts}). Total de su factura: <b>${fmtEur(f.invoiceTotal)}</b>` +
      (Math.abs(d) <= 0.05 ? ' ✓ coincide: todos los conceptos de la factura están identificados.' : ` – diferencia de ${signed(d)}. Puede deberse a descuentos, servicios adicionales, regularizaciones u otros conceptos que no entran en la comparación; revise la tabla de abajo.`);
  } else {
    box.className = 'alert info';
    box.innerHTML = `<b>Factura reconstruida con estos valores:</b> ${fmtEur(reconstructed)} (${parts}).`;
  }
  renderBillLines(f, sim, services);
}

/** Step 2 table: every cost line of the uploaded bill (as read) next to the same line recomputed from the form values. */
function renderBillLines(f, sim, services) {
  const tb = $('#es-bill-lines tbody');
  if (!tb) return;
  const p = ES.parsed;
  const read = (v) => (v === null || v === undefined) ? '<span class="muted">—</span>' : fmtEur(v);
  const diffCell = (a, b) => {
    if (a === null || a === undefined || b === null || b === undefined) return '<td class="num diff"></td>';
    const d = r2(a - b);
    return `<td class="num diff ${Math.abs(d) <= 0.005 ? 'zero' : Math.abs(d) <= 0.02 ? 'zero' : 'bad'}">${Math.abs(d) <= 0.005 ? '=' : signed(d)}</td>`;
  };
  const row = (label, qty, price, readAmount, simAmount, cls = '') =>
    `<tr class="${cls}"><td>${label}</td><td>${qty}</td><td>${price}</td><td class="num">${read(readAmount)}</td><td class="num">${simAmount === null || simAmount === undefined ? '' : fmtEur(simAmount)}</td>${diffCell(simAmount, readAmount)}</tr>`;
  const rows = [];
  rows.push(row('Potencia P1 (punta-llano)', `${fmtNum(f.power.p1, 3)} kW × ${f.days} días`, `${fmtNum(f.powerPrice.p1, 6)} €/kW·día`, p?.powerTerm?.p1?.amount ?? null, sim.powerP1));
  rows.push(row('Potencia P2 / P3 (valle)', `${fmtNum(f.power.p2, 3)} kW × ${f.days} días`, `${fmtNum(f.powerPrice.p2, 6)} €/kW·día`, p?.powerTerm?.p2?.amount ?? null, sim.powerP2));
  if (f.single) {
    rows.push(row('Energía (precio único)', `${fmtNum(sim.totalKwh, 3)} kWh`, `${fmtNum(f.energySingle, 6)} €/kWh`, p?.energy?.amount ?? null, sim.energyAmount));
  } else {
    for (const k of PERIODS_ES) rows.push(row(`Energía ${PERIOD_LABELS_ES[k].toLowerCase()}`, `${fmtNum(f.kwh[k], 3)} kWh`, `${fmtNum(f.energyPrice[k], 6)} €/kWh`, p?.energy?.byPeriod?.[k]?.amount ?? null, sim.lines.find((l) => l.id === `energy_${k}`)?.amount ?? 0));
  }
  if (f.otherAmount) rows.push(row(f.otherAmount < 0 ? 'Descuentos de su tarifa' : 'Cuotas de su tarifa', '', '', p ? r2((p.discountAmount || 0) + (p.feeAmount || 0)) : null, sim.other));
  rows.push(row('Financiación Bono Social', `${f.days} días`, `${fmtNum(f.bonoPerDay, 6)} €/día`, p?.bonoSocial?.amount ?? null, sim.bonoSocial));
  rows.push(row('Alquiler del contador', `${f.days} días`, `${fmtNum(f.rentPerDay, 6)} €/día`, p?.meterRent?.amount ?? null, sim.meterRent));
  if (f.servicesAmount) rows.push(row('Servicios adicionales (fuera de la tarifa eléctrica)', '', 'sin impuesto eléctrico', p?.serviceAmount || null, r2(f.servicesAmount), 'muted'));
  rows.push(row('Impuesto electricidad', `s/ ${fmtEur(sim.ieBase)}`, `${fmtNum(f.ieRate * 100, 7)} %`, p?.ie?.amount ?? null, sim.ie));
  const servicesIva = r2(services - (f.servicesAmount || 0));
  rows.push(row(`IVA ${Math.round(f.ivaRate * 100)} %`, `s/ ${fmtEur(r2(sim.ivaBase + (f.servicesAmount || 0)))}`, `${Math.round(f.ivaRate * 100)} %`, p?.iva?.amount ?? null, r2(sim.iva + servicesIva)));
  rows.push(row('TOTAL', '', '', f.invoiceTotal ?? p?.total ?? null, r2(sim.total + services), 'total'));
  tb.innerHTML = rows.join('');
}

/* ------------------------------------------------------------------ compare */
function runComparisonES() {
  if (!ES.dataset) return ui.showError('La lista de tarifas españolas (data/ofertas-es.json) no se ha podido cargar.');
  ui.hideError();
  const f = readFormES();
  ES.form = f;
  const profile = profileOf(f);
  ES.baseline = simulateES(profile, basePricesOf(f), rules());
  computeResults();
  $('#es-cnmc-link').href = cnmcLink(profile, { postalCode: f.postalCode, periodStart: f.periodStart, contractType: f.single ? 'F0' : 'E0' });
  ui.show('#step-results-es');
  renderResultsES();
  $('#step-results-es').scrollIntoView({ behavior: 'smooth' });
}

function computeResults() {
  const f = ES.form;
  const includePromo = $('#es-flt-promo').checked;
  ES.results = simulateAllES(ES.dataset, profileOf(f), { includePromo, currentSupplierCode: f.supplierCode });
  // welcome discounts are for new customers: an existing customer of that supplier gets the post-promo price
  for (const r of ES.results) {
    if (r.isCurrentSupplier && r.simAfter && includePromo) { r.sim = r.simAfter; r.promoDenied = true; }
  }
}

function bindFilters() {
  $$('#step-results-es .filters input, #step-results-es .filters select').forEach((el) => el.addEventListener('change', () => {
    if (!ES.form) return;
    if (el.id === 'es-flt-promo') computeResults();
    renderResultsES();
  }));
}

function filteredResultsES() {
  let r = ES.results;
  if ($('#es-flt-noindexed').checked) r = r.filter((x) => !x.offer.indexed);
  r = r.filter((x) => !(x.offer.newClientsOnly && x.isCurrentSupplier));
  if (!$('#es-flt-newclient').checked) r = r.filter((x) => !x.offer.newClientsOnly);
  const sup = $('#es-flt-supplier').value;
  if (sup) r = r.filter((x) => x.offer.supplierCode === sup);
  if ($('#es-flt-best').checked) {
    const seen = new Set();
    r = r.filter((x) => { if (seen.has(x.offer.supplierCode)) return false; seen.add(x.offer.supplierCode); return true; });
  }
  r = [...r];
  const sort = $('#es-flt-sort').value;
  if (sort === 'energy') r.sort((a, b) => a.sim.energyAmount - b.sim.energyAmount);
  else if (sort === 'power') r.sort((a, b) => a.sim.powerAmount - b.sim.powerAmount);
  else if (sort === 'supplier') r.sort((a, b) => a.offer.supplier.localeCompare(b.offer.supplier, 'es') || a.sim.total - b.sim.total);
  else r.sort((a, b) => a.sim.total - b.sim.total);
  return r;
}

const regulatedOf = (s) => r2(s.bonoSocial + s.meterRent + (s.fee || 0) + (s.extra || 0) + (s.other || 0));

function renderResultsES() {
  const f = ES.form, base = ES.baseline;
  const rows = filteredResultsES();
  const totalKwh = base.totalKwh;
  $('#es-results-sub').textContent = `Perfil: ${fmtNum(f.power.p1, 2)} kW punta / ${fmtNum(f.power.p2, 2)} kW valle · ${fmtNum(totalKwh, 0)} kWh en ${f.days} días (punta ${fmtNum(f.kwh.punta, 0)} · llano ${fmtNum(f.kwh.llano, 0)} · valle ${fmtNum(f.kwh.valle, 0)}) · ${ES.results.length} tarifas aplicables.`;
  $('#es-th-days').textContent = `${f.days} días, con impuestos`;

  const best = rows[0];
  const cheaper = rows.filter((x) => x.sim.total < base.total - 0.005).length;
  const sg = $('#es-summary-grid'); sg.innerHTML = '';
  const services = servicesWithIva(f);
  sg.appendChild(sumCard('Su factura (reconstruida)', fmtEur(base.total), `${fmtEur(base.totalPerYear, 0)}/año · energía media ${fmtNum(base.avgEnergyPrice, 4)} €/kWh · potencia ${fmtNum(base.avgPowerPerDay, 4)} €/día` + (f.invoiceTotal ? ` · factura real: ${fmtEur(f.invoiceTotal)}` : '') + (services ? ` (incluye ${fmtEur(services)} de servicios adicionales, fuera de la comparación)` : ''), ''));
  sg.appendChild(sumCard('Desglose de su factura', `${fmtEur(base.powerAmount + base.energyAmount)} <small>sin imp.</small>`, `potencia ${fmtEur(base.powerAmount)} · energía ${fmtEur(base.energyAmount)}${base.other ? ` · ${base.other < 0 ? 'descuentos' : 'cuotas'} ${fmtEur(base.other)}` : ''} · regulados ${fmtEur(r2(base.bonoSocial + base.meterRent))} · impuestos ${fmtEur(base.ie + base.iva)}`, ''));
  if (best) {
    const saving = base.total - best.sim.total;
    sg.appendChild(sumCard('Mejor tarifa', esc(best.offer.supplier), esc(best.offer.name) + (best.offer.promoText ? ' · con promoción' : ''), ''));
    sg.appendChild(sumCard(saving >= 0 ? 'Ahorro estimado' : 'Ya tiene una buena tarifa', signed(-saving), `${signed(-saving * 365 / f.days, 0)} al año · ${cheaper} tarifas más baratas que la suya`, saving > 0.5 ? 'good' : saving < -0.5 ? 'bad' : ''));
  }

  const tb = $('#es-results-table tbody'); tb.innerHTML = '';
  tb.appendChild(rowEl({ rank: '', name: 'Su factura actual', sub: `${supplierName(f.supplierCode)} · ${f.single ? fmtNum(f.energySingle, 6) + ' €/kWh' : PERIODS_ES.map((k) => fmtNum(f.energyPrice[k], 4)).join(' / ') + ' €/kWh'} · potencia ${fmtNum(f.powerPrice.p1, 6)} / ${fmtNum(f.powerPrice.p2, 6)} €/kW·día`, sim: base, base: null, cls: 'baseline', onDetail: () => openDetailES({ offer: { supplier: 'Su factura', name: 'Precios actuales' }, sim: base, prices: basePricesOf(f) }) }));
  rows.forEach((x, i) => {
    tb.appendChild(rowEl({ rank: i + 1, name: `${x.offer.supplier} · ${x.offer.name}`, sub: priceSub(x), badges: badges(x), sim: x.sim, base, cls: (i === 0 ? 'best ' : '') + (x.isCurrentSupplier ? 'current-supplier-es' : ''), onDetail: () => openDetailES(x) }));
  });
  $('#es-results-count').textContent = `${rows.length} tarifas mostradas (de ${ES.results.length} aplicables a su perfil; ${ES.dataset.meta.offers} en la lista, actualizada el ${fmtDate(ES.dataset.meta.publishedAt)}).`;
}

function supplierName(code) { return ES.dataset.suppliers.find((s) => s.code === code)?.name || (code === 'PVPC' ? 'PVPC' : 'precios leídos de la factura'); }

function priceSub(x) {
  const p = x.prices;
  const e = p.energy.single != null && p.energy.punta == null ? `${fmtNum(p.energy.single, 4)} €/kWh` : `${PERIODS_ES.map((k) => fmtNum(p.energy[k], 4)).join(' / ')} €/kWh`;
  return `${e} · potencia ${fmtNum(p.power.p1, 4)} / ${fmtNum(p.power.p2, 4)} €/kW·día${p.feePerDay ? ` · gestión ${fmtNum(p.feePerDay, 3)} €/día` : p.feePerMonth ? ` · gestión ${fmtNum(p.feePerMonth, 2)} €/mes` : ''}`;
}

function badges(x) {
  const o = x.offer, b = [];
  if (o.indexed) b.push(['idx', 'indexada (precio de mercado)']);
  if (o.promoText && !x.promoDenied) b.push(['new', $('#es-flt-promo').checked ? 'promoción 1.er año' : 'promoción no aplicada']);
  if (x.promoDenied) b.push(['cond', 'sin promoción (ya es cliente)']);
  if (o.newClientsOnly) b.push(['cond', 'sólo nuevos clientes']);
  if (o.onlineOnly) b.push(['', 'contratación online']);
  if (o.priceFixedMonths) b.push(['fid', `precio fijo ${o.priceFixedMonths} meses`]);
  if (o.renewable) b.push(['green', '100 % renovable']);
  if (o.maxKwhYear) b.push(['', `hasta ${fmtNum(o.maxKwhYear, 0)} kWh/año`]);
  if (o.maxPower && o.maxPower < 15) b.push(['', `hasta ${o.maxPower} kW`]);
  return b;
}

function cell(v, baseV, bold = false) {
  const d = baseV === null || baseV === undefined ? null : r2(v - baseV);
  const dHtml = d === null ? '' : `<span class="cell-delta ${d < -0.005 ? 'good' : d > 0.005 ? 'bad' : 'zero'}">${d === 0 ? '=' : signed(d)}</span>`;
  return `<td class="num">${bold ? '<b>' : ''}${fmtEur(v)}${bold ? '</b>' : ''}${dHtml}</td>`;
}

function rowEl(r) {
  const tr = document.createElement('tr');
  tr.className = r.cls || '';
  const s = r.sim, b = r.base;
  const diff = b ? r2(s.total - b.total) : null;
  tr.innerHTML = `
    <td class="rank">${r.rank}</td>
    <td><div class="offer-name">${esc(r.name)}</div>${r.sub ? `<div class="offer-sub">${esc(r.sub)}</div>` : ''}${r.badges?.length ? `<div class="badges">${r.badges.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('')}</div>` : ''}</td>
    ${cell(s.powerAmount, b?.powerAmount)}
    ${cell(s.energyAmount, b?.energyAmount)}
    ${cell(regulatedOf(s), b ? regulatedOf(b) : null)}
    ${cell(s.ie, b?.ie)}
    ${cell(s.iva, b?.iva)}
    ${cell(s.total, null, true)}
    ${diff === null ? '<td class="num">—</td>' : `<td class="num diff ${diff < -0.005 ? 'good' : diff > 0.005 ? 'bad' : ''}">${signed(diff)}<span class="cell-delta ${diff < -0.005 ? 'good' : diff > 0.005 ? 'bad' : 'zero'}">${signed(diff * 365 / s.days, 0)}/año</span></td>`}
    <td class="num">${fmtEur(s.totalPerYear, 0)}</td>
    <td><button type="button" class="btn ghost small">Detalle</button></td>`;
  $('button', tr).addEventListener('click', r.onDetail);
  return tr;
}

function sumCard(k, v, s, cls) {
  const el = document.createElement('div');
  el.className = `sum ${cls}`;
  el.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>`;
  return el;
}

/* ------------------------------------------------------------------ detail modal */
function openDetailES(x) {
  const o = x.offer, s = x.sim, base = ES.baseline, isBase = s === base;
  $('#modal-title').textContent = `${o.supplier} – ${o.name}`;
  const qty = (l) => l.unit === 'kW' ? `${fmtNum(l.qty, 3)} kW × ${l.days} días` : l.unit === 'kWh' ? `${fmtNum(l.qty, 3)} kWh` : l.unit === 'días' ? `${l.days ?? l.qty} días` : l.unit === '€' ? `s/ ${fmtEur(l.qty)}` : l.id === 'other' ? '<span class="muted">importe fijo de su factura</span>' : '';
  const price = (l) => l.priceUnit === '%' ? `${fmtNum(l.price, l.id === 'ie' ? 7 : 0)} %` : l.price != null ? `${fmtNum(l.price, 6)} ${l.priceUnit}` : '';
  const baseAmount = (l) => {
    if (isBase) return null;
    if (l.group === 'energy') return base.single && l.period !== 'single' ? undefined : (l.period === 'single' ? base.energyAmount : base.lines.find((b) => b.id === l.id)?.amount);
    return base.lines.find((b) => b.id === l.id)?.amount ?? 0;
  };
  const tr = (l) => {
    const b = baseAmount(l);
    const d = b === null || b === undefined ? null : r2(l.amount - b);
    return `<tr class="${l.group === 'total' ? 'total' : ''}"><td>${esc(l.label)}</td><td>${qty(l)}</td><td>${price(l)}</td>` +
      (isBase ? '' : `<td>${b === undefined ? '<span class="muted">(precio único)</span>' : fmtEur(b)}</td>`) +
      `<td>${fmtEur(l.amount)}</td>` +
      (isBase ? '' : `<td class="diff ${d === null ? '' : d < -0.005 ? 'good' : d > 0.005 ? 'bad' : ''}">${d === null ? '' : d === 0 ? '=' : signed(d)}</td>`) + '</tr>';
  };
  const lines = [...s.lines];
  // concepts that only exist on the user's bill (discounts / fees of the current tariff): show them with 0 for the offer
  if (!isBase) {
    for (const bl of base.lines.filter((l) => (l.id === 'other' || l.id === 'fee' || l.id === 'extra') && !lines.some((x) => x.id === l.id))) {
      const idx = lines.findIndex((l) => l.id === 'bono_social');
      lines.splice(idx < 0 ? lines.length : idx, 0, { ...bl, amount: 0, qty: null, price: null, priceUnit: '', unit: '' , label: `${bl.label} (sólo en su factura)` });
    }
  }
  // energy subtotal row when the offer has 3 periods (the bill may have a single price, so per-period deltas make no sense)
  const lastEnergy = lines.length - 1 - [...lines].reverse().findIndex((l) => l.group === 'energy');
  if (!isBase && lines.filter((l) => l.group === 'energy').length > 1) lines.splice(lastEnergy + 1, 0, { id: 'energy_total', group: 'energy_total', label: 'Energía (total)', amount: s.energyAmount, unit: 'kWh', qty: s.totalKwh, price: null });
  const rowsHtml = lines.map((l) => l.group === 'energy_total'
    ? `<tr><td><i>${esc(l.label)}</i></td><td>${fmtNum(l.qty, 3)} kWh</td><td>${fmtNum(s.avgEnergyPrice, 6)} €/kWh (media)</td><td>${fmtEur(base.energyAmount)}</td><td>${fmtEur(l.amount)}</td><td class="diff ${l.amount - base.energyAmount < -0.005 ? 'good' : l.amount - base.energyAmount > 0.005 ? 'bad' : ''}">${signed(r2(l.amount - base.energyAmount))}</td></tr>`
    : tr(l)).join('');
  const table = `
    <table class="invoice">
      <thead><tr><th>Concepto</th><th>Cantidad</th><th>Precio (sin imp.)</th>${isBase ? '' : '<th>Su factura</th>'}<th>${isBase ? 'Importe' : 'Esta tarifa'}</th>${isBase ? '' : '<th>Diferencia</th>'}</tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>`;
  const diffBox = !isBase ? `<div class="alert ${s.total <= base.total ? 'ok' : 'warn'}">${s.total <= base.total ? 'Ahorro' : 'Coste adicional'} respecto a su factura: <b>${fmtEur(Math.abs(s.total - base.total))}</b> en este periodo (${fmtEur(Math.abs(s.totalPerYear - base.totalPerYear), 0)}/año).${x.simAfter && x.simAfter !== s ? ` Cuando termine la promoción: <b>${fmtEur(x.simAfter.total)}</b> (${signed(r2(x.simAfter.total - base.total))}).` : ''}${x.promoDenied ? ' Como ya es cliente de esta comercializadora se aplican los precios sin la promoción de bienvenida.' : ''}</div>` : '';
  const typeName = { fixed: 'Precio fijo, único las 24 h', fixed3: 'Precio fijo con discriminación horaria (3 periodos)', indexed: 'Indexada al mercado mayorista (precio variable cada hora)' }[o.type] || '—';
  const meta = o.id ? `
    <dl class="kv">
      <dt>Tipo</dt><dd>${typeName}</dd>
      ${o.promoText ? `<dt>Promoción</dt><dd>${esc(o.promoText)}${o.after ? ` · precios tras la promoción: ${o.after.energy?.single != null ? fmtNum(o.after.energy.single, 6) + ' €/kWh' : PERIODS_ES.map((k) => fmtNum(o.after.energy?.[k], 6)).join(' / ') + ' €/kWh'}` : ''}</dd>` : ''}
      <dt>Condiciones</dt><dd>${o.permanence ? 'Con permanencia' : 'Sin permanencia'}${o.priceFixedMonths ? ` · precio fijo ${o.priceFixedMonths} meses` : ''}${o.onlineOnly ? ' · contratación sólo online' : ''}${o.newClientsOnly ? ' · sólo nuevos clientes' : ''}${o.maxPower ? ` · potencia hasta ${o.maxPower} kW` : ''}${o.maxKwhYear ? ` · consumo hasta ${fmtNum(o.maxKwhYear, 0)} kWh/año` : ''}${o.renewable ? ' · energía 100 % renovable' : ''}</dd>
      ${o.notes ? `<dt>Notas</dt><dd>${esc(o.notes)}</dd>` : ''}
      <dt>Fuente de los precios</dt><dd>${o.source?.url ? `<a href="${esc(o.source.url)}" target="_blank" rel="noopener">${esc(o.source.name)}</a>` : esc(o.source?.name || '—')} · consultado el ${fmtDate(o.source?.date)}. Los precios pueden haber cambiado: confirme siempre en la web de la comercializadora antes de contratar.</dd>
      <dt>Web</dt><dd class="links"><a href="${esc(ES.dataset.suppliers.find((sp) => sp.code === o.supplierCode)?.url || o.source?.url || '#')}" target="_blank" rel="noopener">${esc(o.supplier)}</a><a href="${esc($('#es-cnmc-link').href)}" target="_blank" rel="noopener">Comparador CNMC</a></dd>
    </dl>` : `<p class="muted small">Reconstrucción de su factura con los precios leídos. Financiación del bono social y alquiler del contador son conceptos regulados idénticos en todas las tarifas.</p>`;
  $('#modal-body').innerHTML = diffBox + table + meta;
  $('#detail-modal').showModal();
}
