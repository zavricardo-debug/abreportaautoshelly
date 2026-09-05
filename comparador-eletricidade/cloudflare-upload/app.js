import { extractPdfText } from './lib/pdf-text.js';
import { parseInvoiceText } from './lib/parser.js';
import { parseInvoiceTextES, detectCountry } from './lib/parser-es.js';
import { simulate, simulateAll, baselinePrices, nearestStandardPower, STANDARD_POWERS, PERIOD_KEYS, PERIOD_LABELS, RULES_2026 } from './lib/simulator.js';
import { initES, fillFormES, showManualES } from './app-es.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TODAY = new Date().toISOString().slice(0, 10);
export const APP_VERSION = '1.3.0'; // shown in the footer + error messages (helps spot stale caches)

const state = {
  country: 'PT',    // 'PT' (ERSE flow) or 'ES' (2.0TD flow, app-es.js)
  dataset: null,
  parsed: null,
  form: null,       // current profile & prices
  results: [],
  baseline: null,
};

const fmtEur = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtNum = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : new Intl.NumberFormat('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' }) : '';

// Map detected supplier name -> ERSE supplier code
const SUPPLIER_CODE = {
  'Endesa': 'END', 'EDP Comercial': 'EDPC', 'Iberdrola': 'IBD', 'Galp': 'GALP', 'Goldenergy': 'GOLD', 'Repsol': 'REPSOL',
  'SU Eletricidade': 'TUR', 'Plenitude': 'ENIPLENITUDE', 'MEO Energia': 'MEOENERGIA', 'Coopérnico': 'COOP', 'Luzboa': 'LUZBOA',
  'Audax': 'AUDAX', 'Ibelectra': 'IBELECTRA', 'Muon': 'MUON', 'YesEnergy': 'YESENERGY', 'Alfa Energia': 'ALFAENERGIA', 'EZU': 'EZUENERGIA',
};

/* ------------------------------------------------------------------ boot */
init();

async function init() {
  bindUpload();
  bindForm();
  bindFilters();
  $('#modal-close').addEventListener('click', () => $('#detail-modal').close());
  initES({ show, hide, showError, hideError }); // Spanish flow (loads data/ofertas-es.json in parallel)
  try {
    const res = await fetch('data/ofertas.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.dataset = await res.json();
    const d = state.dataset.meta.publishedAt ? fmtDate(state.dataset.meta.publishedAt) : '';
    $('#dataset-pill').textContent = `${state.dataset.meta.offers} ofertas · ERSE ${d}`;
    $('#dataset-date').textContent = `lista de ofertas publicada em ${d}`;
    const sel = $('#f-supplier');
    for (const s of state.dataset.suppliers) {
      const o = document.createElement('option'); o.value = s.code; o.textContent = s.name; sel.appendChild(o);
    }
    const fsel = $('#flt-supplier');
    for (const s of state.dataset.suppliers) {
      const o = document.createElement('option'); o.value = s.code; o.textContent = `${s.name} (${s.offers})`; fsel.appendChild(o);
    }
  } catch (e) {
    $('#dataset-pill').textContent = 'erro a carregar ofertas';
    showError(`Não foi possível carregar a lista de ofertas (public/data/ofertas.json): ${e.message}. Corra "npm run data:build".`);
  }
  const ver = $('#app-version');
  if (ver) ver.textContent = `v${APP_VERSION}`;
  // power select
  const ps = $('#f-power');
  for (const p of STANDARD_POWERS) { const o = document.createElement('option'); o.value = p; o.textContent = `${fmtNum(p, 2)} kVA`; ps.appendChild(o); }
  ps.value = 6.9;
  renderEnergyRows(1, {});
}

/* ------------------------------------------------------------------ upload */
function bindUpload() {
  const dz = $('#dropzone');
  const input = $('#file-input');
  input.addEventListener('change', () => input.files[0] && handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); });
  document.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f && /pdf/i.test(f.type + f.name)) handleFile(f); });

  $('#btn-sample').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('samples/fatura-exemplo-endesa.pdf');
      if (!res.ok) throw new Error('exemplo não disponível');
      handleFile(new File([await res.blob()], 'fatura-exemplo-endesa.pdf', { type: 'application/pdf' }));
    } catch (err) { showError(`Não foi possível abrir o exemplo: ${err.message}`); }
  });
  $('#btn-sample-es').addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const res = await fetch('samples/factura-ejemplo-endesa-es.pdf');
      if (!res.ok) throw new Error('ejemplo no disponible');
      handleFile(new File([await res.blob()], 'factura-ejemplo-endesa-es.pdf', { type: 'application/pdf' }));
    } catch (err) { showError(`No se ha podido abrir el ejemplo: ${err.message}`); }
  });
  $('#btn-manual').addEventListener('click', (e) => {
    e.preventDefault();
    state.parsed = null;
    setCountry('PT');
    fillForm(null);
    $('#raw-text').textContent = '';
    show('#step-values');
    $('#step-values').scrollIntoView({ behavior: 'smooth' });
  });
  $('#btn-manual-es').addEventListener('click', (e) => {
    e.preventDefault();
    hideError();
    setCountry('ES');
    showManualES();
  });
}

/** Show only the sections of one country's flow (PT: #step-values/#step-results, ES: #step-values-es/#step-results-es). */
function setCountry(country) {
  state.country = country;
  document.body.dataset.country = country;
  if (country === 'ES') { hide('#step-values'); hide('#step-results'); }
  else { hide('#step-values-es'); hide('#step-results-es'); }
}

async function handleFile(file, password) {
  hideError();
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  if (!isPdf) return showError(`"${file.name}" não parece ser um PDF (tipo: ${file.type || 'desconhecido'}). Escolha o PDF da fatura – imagens (JPG/PNG) e capturas de ecrã não são suportadas.`);
  if (file.size === 0) return showError('O ficheiro está vazio (0 bytes). Volte a descarregar a fatura do site do seu comercializador.');
  if (file.size > 25 * 1024 * 1024) return showError('O ficheiro é demasiado grande (máx. 25 MB).');
  const prog = $('#progress'); prog.classList.remove('hidden');
  setProgress(5, 'A abrir o PDF…');
  try {
    const buf = await file.arrayBuffer();
    const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
    if (!/%PDF-/.test(head)) {
      throw new Error(/^\s*</.test(head) ? 'o conteúdo do ficheiro é HTML e não um PDF – provavelmente foi guardada a página web em vez da fatura. Descarregue o PDF a partir da área de cliente.' : 'o conteúdo não é um PDF válido (cabeçalho %PDF em falta). Volte a descarregar a fatura.');
    }
    const { text, numPages, info } = await extractPdfText(buf, ({ page, pages }) => setProgress(10 + 70 * page / pages, `A ler página ${page} de ${pages}…`), { password });
    setProgress(85, 'A identificar as linhas da fatura…');
    if (!text.trim() || info.textItems < 5) {
      state.parsed = null;
      setCountry('PT');
      fillForm(null);
      $('#raw-text').textContent = text;
      show('#step-values');
      hide('#step-results');
      prog.classList.add('hidden');
      showError(`O PDF (${numPages} página(s)) não contém texto pesquisável – parece ser uma digitalização/imagem${info.producer ? ` (gerado por ${info.producer})` : ''}. Introduza os valores manualmente em baixo ou descarregue a fatura original em PDF da área de cliente do comercializador.`);
      $('#step-values').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const { country } = detectCountry(text);
    if (country === 'ES') {
      // Spanish bill (peaje 2.0TD): Potencia P1/P3, Consumo, Bono Social, Alquiler, Impuesto electricidad, IVA, TOTAL
      const parsedES = parseInvoiceTextES(text);
      parsedES.fileName = file.name; parsedES.numPages = numPages; parsedES.pdfInfo = info;
      state.parsed = parsedES;
      setCountry('ES');
      fillFormES(parsedES, text);
      $('#es-raw-text').textContent = text;
      setProgress(100, 'Completado');
      setTimeout(() => prog.classList.add('hidden'), 600);
      show('#step-values-es');
      hide('#step-results-es');
      $('#step-values-es').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const parsed = parseInvoiceText(text);
    parsed.fileName = file.name; parsed.numPages = numPages; parsed.pdfInfo = info;
    state.parsed = parsed;
    setCountry('PT');
    $('#raw-text').textContent = text;
    fillForm(parsed);
    setProgress(100, 'Concluído');
    setTimeout(() => prog.classList.add('hidden'), 600);
    show('#step-values');
    hide('#step-results');
    $('#step-values').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    prog.classList.add('hidden');
    console.error(e);
    if (e?.name === 'PasswordException') {
      // Many suppliers protect the invoice with the customer's NIF / contract number
      const pw = window.prompt(e.code === 2 || password ? 'Palavra-passe incorreta. Tente novamente (normalmente é o NIF do titular):' : 'Este PDF está protegido por palavra-passe (normalmente é o NIF do titular ou o n.º de cliente). Introduza-a para continuar:');
      if (pw) return handleFile(file, pw);
      return showError('O PDF está protegido por palavra-passe. Sem ela não é possível ler a fatura – pode introduzir os valores manualmente.');
    }
    if (e?.name === 'InvalidPDFException') return showError(`O ficheiro não é um PDF válido ou está corrompido (${e.message}). Volte a descarregar a fatura.`);
    if (e?.code === 'PDFJS_LOAD') return showError(e.message);
    const ua = (navigator.userAgent.match(/(Firefox|Edg|OPR|Chrome|Version)\/[\d.]+/g) || []).join(' ') + (/iPhone|iPad/.test(navigator.userAgent) ? ' iOS' : '');
    showError(`Erro ao ler o PDF: ${e?.message || e} [${e?.name || 'Error'}; ${ua || navigator.userAgent.slice(0, 60)}; app v${APP_VERSION}]. Pode introduzir os valores manualmente com o botão "Não tenho PDF".`);
  }
}

// Hooks used by the automated UI test (test/app.test.mjs) to inject a parsed invoice / raw text without pdf.js.
if (typeof window !== 'undefined') {
  window.__test_fill = (parsed) => { state.parsed = parsed; setCountry('PT'); fillForm(parsed); show('#step-values'); };
  window.__test_text = (text) => {
    const { country } = detectCountry(text);
    if (country === 'ES') { const p = parseInvoiceTextES(text); state.parsed = p; setCountry('ES'); fillFormES(p, text); show('#step-values-es'); return p; }
    const p = parseInvoiceText(text); state.parsed = p; setCountry('PT'); fillForm(p); show('#step-values'); return p;
  };
}

function setProgress(pct, text) { $('#progress .bar').style.width = `${pct}%`; $('#progress .ptext').textContent = text; }
function showError(msg) { const el = $('#upload-error'); el.textContent = msg; el.classList.remove('hidden'); }
function hideError() { $('#upload-error').classList.add('hidden'); }
function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }

/* ------------------------------------------------------------------ form */
function renderEnergyRows(option, byPeriod = {}, auto = false) {
  const keys = PERIOD_KEYS[option] || PERIOD_KEYS[1];
  const wrap = $('#energy-rows');
  wrap.innerHTML = '';
  keys.forEach((k, i) => {
    const d = byPeriod[k] || byPeriod[i] || {};
    const row = document.createElement('div');
    row.className = 'period-row';
    row.innerHTML = `
      <div class="plabel">${PERIOD_LABELS[k]}</div>
      <label>Consumo (kWh)<input type="number" name="kwh_${i}" data-i="${i}" class="kwh ${auto && d.kwh != null ? 'auto' : ''}" step="1" min="0" value="${d.kwh ?? ''}" required></label>
      <label>Preço (€/kWh s/IVA)<input type="number" name="ep_${i}" data-i="${i}" class="eprice ${auto && d.price != null ? 'auto' : ''}" step="0.000001" min="0" value="${d.price != null ? +d.price.toFixed(6) : ''}" required></label>
      <label>Valor (€ s/IVA)<output class="eamount" data-i="${i}">${d.amount != null ? fmtEur(d.amount) : '—'}</output></label>`;
    wrap.appendChild(row);
  });
  updateDerived();
}

function fillForm(p) {
  const f = $('#values-form');
  $$('input', f).forEach((i) => i.classList.remove('auto'));
  $('#supplier-tag').textContent = p?.supplier ? `Fatura ${p.supplier}` : '';
  const power = nearestStandardPower(p?.power) || 6.9;
  $('#f-power').value = power;
  const option = p?.option || 1;
  $('#f-option').value = option;
  $('#f-days').value = p?.billedDays || p?.days || 30;
  $('#f-period').value = p?.period ? `${fmtDate(p.period.start)} a ${fmtDate(p.period.end)}` : '';
  setVal('#f-powerprice', p?.power_term?.effectivePrice ?? p?.power_term?.price, p);
  setVal('#f-tarprice', p?.tar?.effectivePrice ?? p?.tar?.price ?? (p ? 0 : ''), p);
  setVal('#f-cav', p?.cav?.total ?? p?.cav?.amount, p);
  setVal('#f-dgeg', p?.dgeg?.total ?? p?.dgeg?.amount, p);
  setVal('#f-iec', p?.iec?.total, p);
  setVal('#f-invoicetotal', p?.totals?.invoiceTotal, p);
  $('#f-supplier').value = SUPPLIER_CODE[p?.supplier] || '';
  $('#f-largefamily').checked = false;
  $('#f-social').checked = false;

  // energy rows
  const byPeriod = {};
  if (p?.energy?.byPeriod) {
    for (const [k, v] of Object.entries(p.energy.byPeriod)) {
      const price = v.effectivePrice ?? v.price ?? (v.kwh ? v.amount / v.kwh : null);
      byPeriod[k] = { kwh: v.kwh, price, amount: v.total ?? v.amount };
    }
  }
  renderEnergyRows(option, byPeriod, !!p);
  markAuto(!!p);

  // warnings
  const w = $('#parse-warnings'); w.innerHTML = '';
  if (p) {
    const items = [...(p.warnings || [])];
    if (p.energy?.hasEstimated) items.push('A fatura inclui consumos estimados; a comparação usa a soma de reais + estimados.');
    const found = ['energy', 'power', 'tar', 'cav', 'dgeg', 'iec'].filter((id) => p.items.some((it) => it.id === id));
    const labels = { energy: 'Termo de Energia', power: 'Termo de Potência', tar: 'Termo Fixo Acesso às Redes', cav: 'Contribuição Audiovisual', dgeg: 'Taxa DGEG', iec: 'Imposto Especial Consumo' };
    const missing = Object.keys(labels).filter((k) => !found.includes(k));
    const ok = document.createElement('div');
    ok.className = `alert ${missing.length > 2 ? 'warn' : 'ok'}`;
    ok.innerHTML = `<b>${found.length} de 6 rubricas encontradas</b> em ${p.numPages} página(s): ${found.map((k) => labels[k]).join(', ') || '—'}.` +
      (missing.length ? `<br>Não encontradas: ${missing.map((k) => labels[k]).join(', ')} – preencha manualmente se necessário.` : '');
    w.appendChild(ok);
    if (items.length) { const el = document.createElement('div'); el.className = 'alert warn'; el.innerHTML = `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>`; w.appendChild(el); }
  } else {
    const el = document.createElement('div'); el.className = 'alert info';
    el.textContent = 'Introduza os valores tal como aparecem na sua fatura (preços sem IVA).';
    w.appendChild(el);
  }
  updateDerived();
}

function setVal(sel, v, p) {
  const el = $(sel);
  el.value = (v === null || v === undefined || v === '') ? '' : +(+v).toFixed(6);
  if (p && v !== null && v !== undefined && v !== '') el.classList.add('auto');
}
function markAuto(on) { if (!on) $$('#values-form input').forEach((i) => i.classList.remove('auto')); }

function bindForm() {
  const f = $('#values-form');
  f.addEventListener('input', (e) => {
    e.target.classList.remove('auto');
    if (e.target.id === 'f-option') {
      const cur = readEnergyRows();
      renderEnergyRows(+e.target.value, cur.map((r) => ({ kwh: r.kwh, price: r.price })));
    }
    updateDerived();
  });
  f.addEventListener('submit', (e) => { e.preventDefault(); runComparison(); });
}

function readEnergyRows() {
  return $$('#energy-rows .period-row').map((row) => ({
    kwh: +$('.kwh', row).value || 0,
    price: +$('.eprice', row).value || 0,
  }));
}

function updateDerived() {
  const rows = readEnergyRows();
  let total = 0;
  $$('#energy-rows .period-row').forEach((row, i) => { const a = rows[i].kwh * rows[i].price; total += a; $('.eamount', row).textContent = fmtEur(a); });
  $('#o-energy-total').textContent = fmtEur(total);
  const pd = (+$('#f-powerprice').value || 0) + (+$('#f-tarprice').value || 0);
  $('#o-powerday').textContent = `${fmtNum(pd, 4)} €/dia`;
}

function readForm() {
  const rows = readEnergyRows();
  return {
    power: +$('#f-power').value,
    option: +$('#f-option').value,
    days: +$('#f-days').value || 30,
    kwh: rows.map((r) => r.kwh),
    energyPrice: rows.map((r) => r.price),
    powerPrice: +$('#f-powerprice').value || 0,
    tarPrice: +$('#f-tarprice').value || 0,
    cav: $('#f-cav').value === '' ? null : +$('#f-cav').value,
    dgeg: $('#f-dgeg').value === '' ? null : +$('#f-dgeg').value,
    iec: $('#f-iec').value === '' ? null : +$('#f-iec').value,
    invoiceTotal: $('#f-invoicetotal').value === '' ? null : +$('#f-invoicetotal').value,
    supplierCode: $('#f-supplier').value || null,
    largeFamily: $('#f-largefamily').checked,
    socialTariff: $('#f-social').checked,
  };
}

/* ------------------------------------------------------------------ compare */
function runComparison() {
  if (!state.dataset) return showError('A lista de ofertas ainda não está carregada.');
  const form = readForm();
  state.form = form;
  const profile = { power: form.power, option: form.option, days: form.days, kwh: form.kwh, largeFamily: form.largeFamily, socialTariff: form.socialTariff };
  state.baseline = simulate(profile, baselinePrices(form));
  state.results = simulateAll(state.dataset, profile, { currentSupplierCode: form.supplierCode, includeNewClientDiscount: $('#flt-newclient').checked });
  show('#step-results');
  renderResults();
  $('#step-results').scrollIntoView({ behavior: 'smooth' });
}

function bindFilters() {
  $$('.filters input, .filters select').forEach((el) => el.addEventListener('change', () => {
    if (el.id === 'flt-newclient' && state.form) {
      const f = state.form;
      const profile = { power: f.power, option: f.option, days: f.days, kwh: f.kwh, largeFamily: f.largeFamily, socialTariff: f.socialTariff };
      state.results = simulateAll(state.dataset, profile, { currentSupplierCode: f.supplierCode, includeNewClientDiscount: el.checked });
    }
    renderResults();
  }));
}

function filteredResults() {
  let r = state.results;
  if ($('#flt-dom').checked) r = r.filter((x) => x.offer.segment !== 'Ndom');
  if ($('#flt-noindexed').checked) r = r.filter((x) => !x.offer.indexed);
  if ($('#flt-norestricted').checked) r = r.filter((x) => !x.offer.restricted);
  if ($('#flt-noservices').checked) r = r.filter((x) => !x.offer.requiresServices);
  if ($('#flt-nodual').checked) r = r.filter((x) => !x.offer.dual);
  // offers reserved for new clients: never available at the current supplier; optionally hidden everywhere
  r = r.filter((x) => !(x.offer.newClientsOnly && x.isCurrentSupplier));
  if (!$('#flt-newclient').checked) r = r.filter((x) => !x.offer.newClientsOnly);
  if ($('#flt-noexpired').checked) r = r.filter((x) => !x.offer.validTo || x.offer.validTo >= TODAY);
  const sup = $('#flt-supplier').value;
  if (sup) r = r.filter((x) => x.offer.supplierCode === sup);
  if ($('#flt-best').checked) {
    const seen = new Set();
    r = r.filter((x) => { if (seen.has(x.offer.supplierCode)) return false; seen.add(x.offer.supplierCode); return true; });
  }
  const sort = $('#flt-sort').value;
  r = [...r];
  if (sort === 'energy') r.sort((a, b) => a.sim.avgEnergyPrice - b.sim.avgEnergyPrice);
  else if (sort === 'power') r.sort((a, b) => a.prices.tf - b.prices.tf);
  else if (sort === 'supplier') r.sort((a, b) => a.offer.supplier.localeCompare(b.offer.supplier, 'pt') || a.sim.total - b.sim.total);
  else r.sort((a, b) => a.sim.total - b.sim.total);
  return r;
}

function renderResults() {
  const f = state.form, base = state.baseline;
  const rows = filteredResults();
  const kwhTotal = f.kwh.reduce((a, b) => a + b, 0);
  const optName = { 1: 'simples', 2: 'bi-horária', 3: 'tri-horária' }[f.option];
  $('#results-sub').textContent = `Perfil: ${fmtNum(f.power, 2)} kVA · ${optName} · ${kwhTotal} kWh em ${f.days} dias · ${state.results.length} ofertas com preços para este perfil.`;
  $('#th-days').textContent = `${f.days} dias, c/ IVA`;

  const best = rows[0];
  const cheaper = rows.filter((x) => x.sim.total < base.total - 0.005).length;
  const measuredTotal = f.invoiceTotal;
  const sg = $('#summary-grid');
  sg.innerHTML = '';
  sg.appendChild(sumCard('A sua fatura (simulada)', fmtEur(base.total), `${fmtEur(base.totalPerYear, 0)}/ano · ${fmtNum(base.avgEnergyPrice, 4)} €/kWh · ${fmtNum(base.powerTerm.unitPrice, 4)} €/dia` + (measuredTotal ? ` · real: ${fmtEur(measuredTotal)}` : ''), ''));
  if (best) {
    const saving = base.total - best.sim.total;
    sg.appendChild(sumCard('Melhor oferta', `${best.offer.supplier}`, `${best.offer.name}${best.offer.variant ? ' – ' + best.offer.variant : ''}`, ''));
    sg.appendChild(sumCard(saving >= 0 ? 'Poupança estimada' : 'Já está numa boa tarifa', `${saving >= 0 ? '−' : '+'}${fmtEur(Math.abs(saving))}`, `${saving >= 0 ? '−' : '+'}${fmtEur(Math.abs(saving) * 365 / f.days, 0)} por ano · ${cheaper} ofertas mais baratas que a sua`, saving > 0.5 ? 'good' : saving < -0.5 ? 'bad' : ''));
  }
  const reg = state.results.find((x) => x.offer.id === 'TUR');
  if (reg) sg.appendChild(sumCard('Tarifa regulada (SU Eletricidade)', fmtEur(reg.sim.total), `${reg.sim.total < base.total ? 'mais barata' : 'mais cara'} que a sua em ${fmtEur(Math.abs(reg.sim.total - base.total))}`, ''));

  const tb = $('#results-table tbody');
  tb.innerHTML = '';
  // baseline row
  tb.appendChild(rowEl({ rank: '', name: 'A sua fatura atual', sub: `${f.supplierCode ? supplierName(f.supplierCode) : 'preços lidos da fatura'} · ${fmtNum(f.powerPrice, 4)} + ${fmtNum(f.tarPrice, 4)} €/dia`, energy: base.avgEnergyPrice, power: base.powerTerm.unitPrice, total: base.total, diff: null, year: base.totalPerYear, cls: 'baseline', onDetail: () => openDetail({ offer: { supplier: 'A sua fatura', name: 'Preços atuais', variant: '' }, sim: base, prices: baselinePrices(f) }, base) }));
  rows.forEach((x, i) => {
    const diff = x.sim.total - base.total;
    tb.appendChild(rowEl({
      rank: i + 1, name: `${x.offer.supplier} · ${x.offer.name}`, sub: x.offer.variant, badges: badges(x.offer),
      energy: x.sim.avgEnergyPrice, power: x.prices.tf, total: x.sim.total, diff, year: x.sim.totalPerYear,
      cls: (i === 0 ? 'best ' : '') + (x.isCurrentSupplier ? 'current-supplier' : ''),
      onDetail: () => openDetail(x, base),
    }));
  });
  $('#results-count').textContent = `${rows.length} ofertas apresentadas (de ${state.results.length} aplicáveis ao seu perfil; ${state.dataset.meta.offers} no total na lista ERSE).`;
}

function supplierName(code) { return state.dataset.suppliers.find((s) => s.code === code)?.name || code; }

function sumCard(k, v, s, cls) {
  const el = document.createElement('div');
  el.className = `sum ${cls}`;
  el.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div>`;
  return el;
}

function badges(o) {
  const b = [];
  if (o.indexed) b.push(['idx', 'indexada OMIE']);
  if (o.newClientsOnly) b.push(['new', 'desconto novos clientes']);
  if (o.restricted) b.push(['cond', 'condicionada']);
  if (o.requiresServices) b.push(['serv', `serviços obrig. ${fmtEur(o.servicesCostYear, 0)}/ano`]);
  if (o.dual) b.push(['dual', 'dual luz+gás']);
  if (o.loyalty) b.push(['fid', 'fidelização']);
  if (o.renewable) b.push(['green', '100% renovável']);
  if (o.segment === 'Ndom') b.push(['', 'empresas']);
  if (o.refundFixedYear) b.push(['', `reembolso ${fmtEur(o.refundFixedYear, 0)}/ano`]);
  return b;
}

function rowEl(r) {
  const tr = document.createElement('tr');
  tr.className = r.cls || '';
  const diffCell = r.diff === null ? '<td class="num">—</td>' :
    `<td class="num diff ${r.diff < -0.005 ? 'good' : r.diff > 0.005 ? 'bad' : ''}">${r.diff < 0 ? '−' : r.diff > 0 ? '+' : ''}${fmtEur(Math.abs(r.diff))}</td>`;
  tr.innerHTML = `
    <td class="rank">${r.rank}</td>
    <td><div class="offer-name">${esc(r.name)}</div>${r.sub ? `<div class="offer-sub">${esc(r.sub)}</div>` : ''}${r.badges?.length ? `<div class="badges">${r.badges.map(([c, t]) => `<span class="badge ${c}">${esc(t)}</span>`).join('')}</div>` : ''}</td>
    <td class="num">${fmtNum(r.energy, 4)}</td>
    <td class="num">${fmtNum(r.power, 4)}</td>
    <td class="num"><b>${fmtEur(r.total)}</b></td>
    ${diffCell}
    <td class="num">${fmtEur(r.year, 0)}</td>
    <td><button type="button" class="btn ghost small">Detalhe</button></td>`;
  $('button', tr).addEventListener('click', r.onDetail);
  return tr;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ------------------------------------------------------------------ detail modal */
function openDetail(x, base) {
  const o = x.offer, s = x.sim;
  $('#modal-title').textContent = `${o.supplier} – ${o.name}${o.variant ? ' (' + o.variant + ')' : ''}`;
  const keys = PERIOD_KEYS[s.option];
  const energyRows = s.energy.lines.map((l) => `<tr><td>Termo de Energia – ${PERIOD_LABELS[l.period]}</td><td>${fmtNum(l.kwh, 0)} kWh</td><td>${fmtNum(l.unitPrice, 6)} €/kWh</td><td>${fmtEur(l.amount)}</td><td>${ivaLabelEnergy(s)}</td></tr>`).join('');
  const tarReduced = s.power <= RULES_2026.ivaReducedTarMaxPower + 1e-9;
  const invoice = `
    <table class="invoice">
      <thead><tr><th>Rubrica</th><th>Quantidade</th><th>Preço s/IVA</th><th>Valor s/IVA</th><th>IVA</th></tr></thead>
      <tbody>
        ${energyRows}
        ${s.energy.refund ? `<tr><td>Reembolso/desconto na energia</td><td></td><td></td><td>−${fmtEur(s.energy.refund)}</td><td></td></tr>` : ''}
        <tr><td>Termo de Potência (${fmtNum(s.power, 2)} kVA)</td><td>${s.days} dias</td><td>${fmtNum(s.powerTerm.supplierPerDay, 6)} €/dia</td><td>${fmtEur(s.powerTerm.supplierAmount)}</td><td>23%</td></tr>
        <tr><td>Termo Fixo Acesso às Redes</td><td>${s.days} dias</td><td>${fmtNum(s.powerTerm.tarPerDay, 6)} €/dia</td><td>${fmtEur(s.powerTerm.tarAmount)}</td><td>${tarReduced ? '6%' : '23%'}</td></tr>
        <tr><td>Contribuição Audiovisual</td><td>${fmtNum(s.months, 4)} meses</td><td>${fmtNum(RULES_2026.cavPerMonth, 2)} €/mês</td><td>${fmtEur(s.cav)}</td><td>6%</td></tr>
        <tr><td>Taxa Exploração DGEG</td><td>${fmtNum(s.months, 4)} meses</td><td>${fmtNum(RULES_2026.dgegPerMonth, 2)} €/mês</td><td>${fmtEur(s.dgeg)}</td><td>23%</td></tr>
        <tr><td>Imposto Especial Consumo</td><td>${fmtNum(s.totalKwh, 0)} kWh</td><td>${fmtNum(RULES_2026.iecPerKwh, 3)} €/kWh</td><td>${fmtEur(s.iec)}</td><td>23%</td></tr>
        <tr><td>Subtotal s/IVA</td><td></td><td></td><td>${fmtEur(s.subtotal)}</td><td></td></tr>
        <tr><td>IVA 6% (base ${fmtEur(s.base6)})</td><td></td><td></td><td>${fmtEur(s.iva6)}</td><td></td></tr>
        <tr><td>IVA 23% (base ${fmtEur(s.base23)})</td><td></td><td></td><td>${fmtEur(s.iva23)}</td><td></td></tr>
        ${s.extras.services ? `<tr><td>Serviços adicionais obrigatórios (pro-rata, c/IVA)</td><td></td><td></td><td>${fmtEur(s.extras.services)}</td><td></td></tr>` : ''}
        ${s.extras.refundFixedYear ? `<tr><td>Reembolso fixo anual (pro-rata)</td><td></td><td></td><td>−${fmtEur(s.extras.refundFixedYear)}</td><td></td></tr>` : ''}
        ${s.extras.newClientDiscount ? `<tr><td>Desconto novos clientes (pro-rata)</td><td></td><td></td><td>−${fmtEur(s.extras.newClientDiscount)}</td><td></td></tr>` : ''}
        <tr class="total"><td>Total estimado</td><td></td><td></td><td>${fmtEur(s.total)}</td><td></td></tr>
      </tbody>
    </table>`;
  const diff = base && x.sim !== base ? `<div class="alert ${s.total <= base.total ? 'ok' : 'warn'}">${s.total <= base.total ? 'Poupança' : 'Custo adicional'} face à sua fatura: <b>${fmtEur(Math.abs(s.total - base.total))}</b> neste período (${fmtEur(Math.abs(s.totalPerYear - base.totalPerYear), 0)}/ano).</div>` : '';
  const meta = o.id ? `
    <dl class="kv">
      <dt>Descrição</dt><dd>${esc(o.description || '—')}</dd>
      <dt>Notas ERSE</dt><dd>${esc(o.erseNotes || '—')}</dd>
      ${o.restrictionsText ? `<dt>Restrições</dt><dd>${esc(o.restrictionsText)}</dd>` : ''}
      ${o.otherBenefits ? `<dt>Outros benefícios</dt><dd>${esc(o.otherBenefits)}</dd>` : ''}
      <dt>Preço</dt><dd>${o.indexed ? 'Indexado ao mercado OMIE (valor médio comunicado à ERSE)' : 'Fixo'} · atualização: ${esc(o.priceUpdatePolicy || '—')}</dd>
      <dt>Contrato</dt><dd>${o.contractMonths ? o.contractMonths + ' meses' : '—'}${o.loyalty ? ' · com fidelização' : ' · sem fidelização'}${o.validTo ? ' · válida até ' + fmtDate(o.validTo) : ''}</dd>
      <dt>Contratação</dt><dd>${esc(o.contracting || '—')}</dd>
      <dt>Faturação / pagamento</dt><dd>${esc(o.billing || '—')} · ${esc(o.payment || '—')}</dd>
      ${o.servicesCostYear ? `<dt>Serviços obrigatórios</dt><dd>${fmtEur(o.servicesCostYear)}/ano c/IVA (incluído no total)</dd>` : ''}
      ${o.newClientDiscountYear ? `<dt>Desconto novos clientes</dt><dd>${fmtEur(o.newClientDiscountYear)}/ano c/IVA</dd>` : ''}
      <dt>Contacto</dt><dd>${esc(o.phone || '—')}</dd>
      <dt>Ligações</dt><dd class="links">${o.links?.offer ? `<a href="${esc(o.links.offer)}" target="_blank" rel="noopener">Página da oferta</a>` : ''}${o.links?.sheet ? `<a href="${esc(o.links.sheet)}" target="_blank" rel="noopener">Ficha padronizada</a>` : ''}${o.links?.terms ? `<a href="${esc(o.links.terms)}" target="_blank" rel="noopener">Condições gerais</a>` : ''}${o.links?.supplier ? `<a href="${esc(o.links.supplier)}" target="_blank" rel="noopener">Site</a>` : ''}</dd>
      <dt>Código ERSE</dt><dd>${esc(o.id)}</dd>
    </dl>` : '';
  $('#modal-body').innerHTML = diff + invoice + meta;
  $('#detail-modal').showModal();
}

function ivaLabelEnergy(s) {
  if (s.energy.reducedShare >= 0.999) return '6%';
  if (s.energy.reducedShare <= 0.001) return '23%';
  return `6% (${Math.round(s.energy.reducedShare * 100)}%) / 23%`;
}
