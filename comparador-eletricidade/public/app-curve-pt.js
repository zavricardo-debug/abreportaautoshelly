// Portuguese flow – "diagrama de carga" upload (E-Redes Excel/CSV or any date/hour/consumption file).
// Reads the file in the browser (xlsx-lite for Excel, CSV otherwise), classifies every quarter-hour with
// the ERSE schedules (ciclo diário / semanal) and feeds the real kWh per period into step 2 so the
// comparison (step 3) can be run for simples, bi-horário and tri-horário with the household's real profile.
import { readXlsxRows, isZip, isOle } from './lib/xlsx-lite.js';
import { readXlsRows, tableTextToRows } from './lib/xls-lite.js';
import { parseConsumptionPT, sliceCurvePT, kwhForOption, periodFor, scheduleText, TRI_PERIODS, BI_PERIODS, PERIOD_LABELS_PT } from './lib/consumption-pt.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** Shared state of the PT curve (read by app.js through the exported helpers). */
export const PT_CURVE = { curve: null, used: null, file: '', cycle: 'diario', cycleFromBill: null };

let ctx = null; // callbacks into app.js: { getParsed, getOption, setRowsKwh, updateDerived, fmtNum, fmtDate, sumCard, esc }

export function initCurvePT(c) {
  ctx = c;
  const input = $('#pt-curve-input'), drop = $('#pt-curve-drop');
  if (!input) return;
  // start clean and in sync with the DOM (the module may outlive a document, e.g. in tests)
  Object.assign(PT_CURVE, { curve: null, used: null, file: '', cycle: $('#pt-curve-cycle')?.value || 'diario', cycleFromBill: null });
  input.addEventListener('change', () => input.files[0] && handleCurveFilePT(input.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) handleCurveFilePT(f); });
  $('#btn-pt-curve-sample').addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation();
    try {
      const res = await fetch('samples/consumos-eredes-exemplo.xlsx');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await handleCurveFilePT(new File([await res.arrayBuffer()], 'consumos-eredes-exemplo.xlsx'));
    } catch (err) { curveError(`Não foi possível abrir o ficheiro de exemplo: ${err.message}`); }
  });
  $('#btn-pt-curve-clear').addEventListener('click', () => {
    PT_CURVE.curve = null; PT_CURVE.used = null; PT_CURVE.file = ''; input.value = '';
    $('#pt-curve-result').classList.add('hidden'); $('#pt-curve-error').classList.add('hidden');
    $('#pt-split-hint').textContent = '';
    ctx.onCurveChanged?.('cleared'); // app.js refills the form from the invoice
  });
  $('#pt-curve-cycle').addEventListener('change', (e) => { PT_CURVE.cycle = e.target.value; applyCurveToFormPT(); renderCurvePT(); ctx.updateDerived(); ctx.onCurveChanged?.('changed'); });
  for (const id of ['#pt-curve-use', '#pt-curve-period']) $(id).addEventListener('change', () => { applyCurveToFormPT(); renderCurvePT(); ctx.updateDerived(); ctx.onCurveChanged?.('changed'); });
}

function curveError(msg, preview = '', sheetNames = null) {
  const el = $('#pt-curve-error');
  el.textContent = msg;
  if (sheetNames && sheetNames.length > 1) { const p = document.createElement('div'); p.className = 'small'; p.textContent = `Folhas encontradas: ${sheetNames.join(', ')} (todas foram tentadas).`; el.appendChild(p); }
  if (preview) {
    const d = document.createElement('details'); d.className = 'err-preview';
    const sm = document.createElement('summary'); sm.textContent = 'O que foi lido do ficheiro (primeiras linhas)'; d.appendChild(sm);
    const pre = document.createElement('pre'); pre.textContent = preview; d.appendChild(pre);
    const hint = document.createElement('div'); hint.className = 'small muted'; hint.textContent = 'Se estas linhas não mostram data, hora e consumo, o ficheiro não é o detalhe por hora/15 min. Copie estas linhas para pedir suporte.'; d.appendChild(hint);
    el.appendChild(d);
  }
  el.classList.remove('hidden');
}

/** Decode a File (xlsx / csv / txt) into rows or text and load it. */
export async function handleCurveFilePT(file) {
  $('#pt-curve-error').classList.add('hidden');
  if (file.size > 40 * 1024 * 1024) return curveError('O ficheiro é demasiado grande (máx. 40 MB).');
  try {
    const buf = await file.arrayBuffer();
    return loadCurveBufferPT(buf, file.name);
  } catch (e) {
    console.error(e);
    curveError(`Não foi possível ler "${file.name}": ${e.message}`);
    return null;
  }
}

/** ArrayBuffer -> parsed curve (xlsx via xlsx-lite, otherwise text). Exposed for app.js (main dropzone) and tests. */
export function loadCurveBufferPT(buf, fileName = 'consumos.xlsx') {
  try {
    const dec = decodeCurveBuffer(buf);
    return loadCurveDecodedPT(dec, fileName);
  } catch (e) {
    console.error(e);
    PT_CURVE.curve = null; PT_CURVE.used = null;
    $('#pt-curve-result').classList.add('hidden');
    curveError(`Não foi possível ler "${fileName}": ${e.message}`);
    return null;
  }
}

/**
 * Bytes of any supported consumption file -> { rows, source, sheets } (Excel .xlsx / .xls, HTML, SpreadsheetML,
 * SYLK/DIF tables saved as .xls) or { text } (CSV / TXT, UTF-8 / UTF-16 / Windows-1252).
 * `sheets` lists every worksheet/table found ([{ name, rows }]) so the caller can try the ones after the first.
 * Shared with app.js (main dropzone) and app-es.js.
 */
export function decodeCurveBuffer(buf) {
  if (buf.byteLength >= 8 && isOle(buf)) { const r = readXlsRows(buf, { sheetIndex: 'all' }); return { rows: r.rows, source: `Excel 97-2003, folha "${r.sheet}"`, sheets: r.all, kind: 'xls' }; }
  if (buf.byteLength >= 4 && isZip(buf)) { const r = readXlsxRows(buf, { sheetIndex: 'all' }); return { rows: r.rows, source: `folha "${r.sheet}"`, sheets: r.all, kind: 'xlsx' }; }
  const text = decodeText(buf);
  const all = tableTextToRows(text, { all: true }); // web portals often export an HTML/XML table under the name "ficheiro.xls"
  if (all) { const ssml = /<(?:ss:)?Workbook\b/i.test(text.slice(0, 4000)); return { rows: all[0].rows, source: ssml ? `Excel XML 2003, folha "${all[0].name}"` : 'tabela HTML', sheets: all, kind: ssml ? 'xml' : 'html' }; }
  const single = tableTextToRows(text); // SYLK / DIF
  if (single) return { rows: single, source: /^ID;P/i.test(text) ? 'SYLK' : 'DIF', sheets: [{ name: 'Folha1', rows: single }], kind: 'text' };
  return { text, kind: 'text' };
}

/** Bytes -> string: BOM-aware UTF-16 (Excel "Unicode text"), UTF-8, else Windows-1252. */
export function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(buf).replace(/^\uFEFF/, '');
  // UTF-16 without BOM: every other byte is 0 in ASCII text
  const n = Math.min(b.length, 400);
  if (n >= 8) { let z1 = 0, z0 = 0; for (let i = 0; i + 1 < n; i += 2) { if (b[i + 1] === 0) z1++; if (b[i] === 0) z0++; } if (z1 > n / 2 * 0.8) return new TextDecoder('utf-16le').decode(buf); if (z0 > n / 2 * 0.8) return new TextDecoder('utf-16be').decode(buf); }
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (/\uFFFD/.test(text)) text = new TextDecoder('windows-1252').decode(buf);
  return text.replace(/^\uFEFF/, '');
}

/** Human-readable preview of what was decoded (first non-empty lines / rows) for error messages. */
export function previewOfDecoded(dec, n = 4) {
  const rows = dec.rows || null;
  const lines = rows ? rows.filter((r) => r && r.some((c) => c !== null && c !== undefined && String(c).trim() !== '')).slice(0, n).map((r) => r.map((c) => (c === null || c === undefined ? '' : String(c))).join(' | '))
    : String(dec.text || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, n);
  return lines.map((l) => (l.length > 140 ? l.slice(0, 140) + '…' : l)).join('\n');
}

/** Try the parser on the first sheet, then on every other sheet/table; returns { curve, sheetName } or throws the first error. */
export function parseAnySheet(dec, parse) {
  let firstErr = null;
  const sheets = dec.sheets && dec.sheets.length ? dec.sheets : [{ name: '', rows: dec.rows }];
  for (const sh of sheets) {
    if (!sh.rows || !sh.rows.length) continue;
    try { return { curve: parse(sh.rows), sheetName: sh.name }; } catch (e) { firstErr = firstErr || e; }
  }
  throw firstErr || new Error('o ficheiro não tem nenhuma folha com dados');
}

/** Decoded file ({rows, sheets, source} or {text}) -> curve; tries every sheet and shows a diagnostic error on failure. */
export function loadCurveDecodedPT(dec, fileName = 'consumos.xlsx') {
  if (!dec.rows) return loadCurvePT(dec.text, fileName);
  try {
    const { curve } = parseAnySheet(dec, (rows) => parseConsumptionPT(rows, { source: sourceFor(dec, rows) }));
    return applyLoadedPT(curve, fileName);
  } catch (e) {
    console.error(e);
    PT_CURVE.curve = null; PT_CURVE.used = null;
    $('#pt-curve-result').classList.add('hidden');
    curveError(`Não foi possível ler "${fileName}": ${e.message}`, previewOfDecoded(dec), dec.sheets?.map((x) => x.name));
    return null;
  }
  function sourceFor(d, rows) { const sh = d.sheets?.find((x) => x.rows === rows); return sh && d.sheets.length > 1 ? `${d.source.replace(/, folha .*$/, '')}, folha "${sh.name}"` : d.source; }
}

function applyLoadedPT(curve, fileName) {
  PT_CURVE.curve = curve; PT_CURVE.file = fileName;
  $('#pt-curve-error').classList.add('hidden');
  $('#pt-curve-use').checked = true;
  syncCycleFromBill(ctx.getParsed());
  applyCurveToFormPT();
  renderCurvePT();
  ctx.updateDerived();
  ctx.onCurveChanged?.('loaded');
  return curve;
}

/** Parse rows/text, apply to the form and render. Returns the curve or null (error shown in the box). */
export function loadCurvePT(input, fileName = 'consumos.csv', source = '') {
  try {
    const curve = parseConsumptionPT(input, { source: source || (/\.xlsx?$/i.test(fileName) ? 'Excel' : 'CSV') });
    PT_CURVE.curve = curve; PT_CURVE.file = fileName;
    $('#pt-curve-error').classList.add('hidden');
    $('#pt-curve-use').checked = true;
    syncCycleFromBill(ctx.getParsed());
    applyCurveToFormPT();
    renderCurvePT();
    ctx.updateDerived();
    ctx.onCurveChanged?.('loaded');
    return curve;
  } catch (e) {
    console.error(e);
    PT_CURVE.curve = null; PT_CURVE.used = null;
    $('#pt-curve-result').classList.add('hidden');
    curveError(`Não foi possível ler "${fileName}": ${e.message}`, previewOfDecoded(typeof input === 'string' ? { text: input } : { rows: input }));
    return null;
  }
}

/** Use the cycle printed on the invoice ("ciclo diário" / "ciclo semanal") when the parser found it. */
export function syncCycleFromBill(parsed) {
  const c = parsed?.cycle || null;
  PT_CURVE.cycleFromBill = c;
  if (c) { PT_CURVE.cycle = c; const sel = $('#pt-curve-cycle'); if (sel) sel.value = c; }
}

/** Curve restricted to the invoice period when requested and covered (≥ 7 days). */
export function curveForBillPT() {
  const c = PT_CURVE.curve; if (!c) return null;
  const p = ctx.getParsed();
  if ($('#pt-curve-period').checked && p?.period?.start && p?.period?.end) {
    const sl = sliceCurvePT(c, p.period.start, p.period.end);
    if (sl && sl.days >= 7) return { curve: sl, scope: 'period' };
  }
  return { curve: c, scope: 'all' };
}

/** The curve currently driving the comparison, or null (no file / "use" unchecked). */
export function activeCurvePT() {
  if (!PT_CURVE.curve || !$('#pt-curve-use')?.checked) return null;
  const sel = curveForBillPT();
  return sel ? { curve: sel.curve, scope: sel.scope, cycle: PT_CURVE.cycle, file: PT_CURVE.file } : null;
}

/** Put the real kWh per period (scaled to the invoice's kWh) into the consumption inputs of the current option. */
export function applyCurveToFormPT() {
  const sel = curveForBillPT();
  PT_CURVE.used = sel;
  const hint = $('#pt-split-hint');
  if (!sel || !$('#pt-curve-use').checked) { hint.textContent = ''; ctx.restoreBillKwh?.(); return; }
  const { curve, scope } = sel;
  const option = ctx.getOption();
  const p = ctx.getParsed();
  const billKwh = p?.energy?.kwh || null;
  const useCurveKwh = !billKwh || (scope === 'period' && Math.abs(curve.totalKwh - billKwh) / billKwh < 0.03);
  const kwh = kwhForOption(curve, PT_CURVE.cycle, option, useCurveKwh ? null : billKwh);
  if (option > 1) ctx.setRowsKwh(kwh);
  else if (!billKwh) ctx.setRowsKwh(kwh);
  const keys = option === 3 ? TRI_PERIODS : option === 2 ? BI_PERIODS : [];
  const share = curve.share[PT_CURVE.cycle];
  const src = scope === 'period' ? `os ${curve.days} dias do ficheiro dentro do período da fatura (${ctx.fmtDate(curve.start)} → ${ctx.fmtDate(curve.end)})` : `o ficheiro completo (${curve.days} dias, ${ctx.fmtDate(curve.start)} → ${ctx.fmtDate(curve.end)})`;
  const parts = keys.map((k) => `${PERIOD_LABELS_PT[k].toLowerCase()} ${ctx.fmtNum(100 * share[option][k], 1)} %`).join(' · ');
  hint.textContent = option === 1
    ? `Repartição REAL segundo ${src}, ${cycleLabel()}: bi-horário ${ctx.fmtNum(100 * share[2].vazio, 0)} % em vazio · tri-horário ${ctx.fmtNum(100 * share[3].ponta, 0)} % ponta / ${ctx.fmtNum(100 * share[3].cheias, 0)} % cheias / ${ctx.fmtNum(100 * share[3].vazio, 0)} % vazio. A fatura é simples – em "Opção horária a comparar" (passo 3) pode ver quanto pagaria em bi e tri-horário com este consumo.`
    : `Repartição REAL segundo ${src}, ${cycleLabel()}: ${parts}` + (billKwh && !useCurveKwh ? ` aplicada aos ${ctx.fmtNum(billKwh, 0)} kWh faturados.` : useCurveKwh && billKwh ? ` (${ctx.fmtNum(curve.totalKwh, 1)} kWh, coincide com a fatura).` : '.');
}

function cycleLabel() { return PT_CURVE.cycle === 'semanal' ? 'ciclo semanal' : 'ciclo diário'; }

/** Summary cards, per-option table and the three daily profiles. */
export function renderCurvePT() {
  const c = PT_CURVE.curve; if (!c) return;
  const sel = curveForBillPT(); const cu = sel?.curve || c;
  const { fmtNum, fmtDate, sumCard, esc } = ctx;
  $('#pt-curve-result').classList.remove('hidden');
  const g = $('#pt-curve-summary'); g.innerHTML = '';
  const cyc = PT_CURVE.cycle;
  const tri = cu.share[cyc][3], bi = cu.share[cyc][2];
  const bar = (keys, sh) => `<div class="period-bar">${keys.map((k) => `<span class="${k}" style="width:${(100 * sh[k]).toFixed(1)}%" title="${PERIOD_LABELS_PT[k]} ${(100 * sh[k]).toFixed(1)} %"></span>`).join('')}</div>`;
  g.appendChild(sumCard('Ficheiro', esc(PT_CURVE.file), `${esc(c.format)} · registos de ${c.step} min · ${c.days} dias (${fmtDate(c.start)} → ${fmtDate(c.end)})`, ''));
  g.appendChild(sumCard(sel?.scope === 'period' ? 'Consumo no período da fatura' : 'Consumo do ficheiro', `${fmtNum(cu.totalKwh, 1)} kWh`, `${fmtNum(cu.totalKwh / Math.max(1, cu.days), 2)} kWh/dia · ${cu.days} dias${cu.estimatedShare ? ` · ${Math.round(cu.estimatedShare * 100)} % estimado` : ''}`, ''));
  g.appendChild(sumCard(`Tri-horário (${cycleLabel()})`, `${fmtNum(100 * tri.ponta, 0)} / ${fmtNum(100 * tri.cheias, 0)} / ${fmtNum(100 * tri.vazio, 0)} %`, `ponta ${fmtNum(cu.split[cyc][3].ponta, 1)} · cheias ${fmtNum(cu.split[cyc][3].cheias, 1)} · vazio ${fmtNum(cu.split[cyc][3].vazio, 1)} kWh${bar(TRI_PERIODS, tri)}`, ''));
  g.appendChild(sumCard(`Bi-horário (${cycleLabel()})`, `${fmtNum(100 * bi.foraVazio, 0)} / ${fmtNum(100 * bi.vazio, 0)} %`, `fora de vazio ${fmtNum(cu.split[cyc][2].foraVazio, 1)} · vazio ${fmtNum(cu.split[cyc][2].vazio, 1)} kWh${bar(BI_PERIODS, bi)}`, bi.vazio >= 0.4 ? 'good' : ''));
  const p = ctx.getParsed();
  if (cu.maxPower) {
    const contracted = p?.power || null;
    const ratio = contracted ? cu.maxPower.kw / contracted : null;
    g.appendChild(sumCard('Potência máxima registada', `${fmtNum(cu.maxPower.kw, 2)} kW`, `${cu.maxPower.basis} em ${fmtDate(cu.maxPower.date)} às ${cu.maxPower.time}` + (contracted ? ` · ${Math.round(ratio * 100)} % da potência contratada (${fmtNum(contracted, 2)} kVA)` : ''), ratio !== null && ratio < 0.6 ? 'good' : ratio !== null && ratio > 0.95 ? 'bad' : ''));
  }
  if (PT_CURVE.cycleFromBill) g.appendChild(sumCard('Ciclo horário', PT_CURVE.cycleFromBill === 'semanal' ? 'Semanal' : 'Diário', 'lido da fatura – pode alterar em baixo para ver o outro ciclo', ''));
  if (c.warnings.length) { const w = document.createElement('div'); w.className = 'alert warn'; w.style.gridColumn = '1/-1'; w.innerHTML = `<ul>${c.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`; g.appendChild(w); }

  // per-option table (both cycles, so the user sees the effect of the cycle)
  const tb = $('#pt-curve-table tbody'); tb.innerHTML = '';
  const cell = (v, sh) => `<td class="num">${fmtNum(v, 1)} kWh<span class="pct">${fmtNum(100 * sh, 1)} %</span></td>`;
  for (const cy of ['diario', 'semanal']) {
    const s3 = cu.split[cy][3], h3 = cu.share[cy][3], s2 = cu.split[cy][2], h2 = cu.share[cy][2];
    tb.insertAdjacentHTML('beforeend', `<tr class="${cy === cyc ? 'current' : ''}"><td><b>Tri-horário</b> · ${cy === 'semanal' ? 'ciclo semanal' : 'ciclo diário'}</td>${cell(s3.ponta, h3.ponta)}${cell(s3.cheias, h3.cheias)}${cell(s3.vazio, h3.vazio)}<td class="num">—</td><td class="num">${fmtNum(cu.totalKwh, 1)} kWh</td></tr>`);
    tb.insertAdjacentHTML('beforeend', `<tr class="${cy === cyc ? 'current' : ''}"><td><b>Bi-horário</b> · ${cy === 'semanal' ? 'ciclo semanal' : 'ciclo diário'}</td><td class="num">—</td><td class="num">—</td>${cell(s2.vazio, h2.vazio)}${cell(s2.foraVazio, h2.foraVazio)}<td class="num">${fmtNum(cu.totalKwh, 1)} kWh</td></tr>`);
  }
  tb.insertAdjacentHTML('beforeend', `<tr><td><b>Simples</b></td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">${fmtNum(cu.totalKwh, 1)} kWh</td></tr>`);

  // charts: average day per day type, coloured with the tri-horário periods of the dominant season
  const season = cu.season;
  const seasonTxt = season === 'verao' ? 'hora legal de Verão' : 'hora legal de Inverno';
  $('#pt-chart-util-title').textContent = `Dia útil médio (kWh por hora) – ${cu.dayCounts.util} dias`;
  $('#pt-chart-sab-title').textContent = `Sábado médio – ${cu.dayCounts.sabado} dias`;
  $('#pt-chart-dom-title').textContent = `Domingo médio – ${cu.dayCounts.domingo} dias`;
  drawProfilePT($('#pt-curve-util'), cu.profileQ.util, { season, dayType: 'util', cycle: cyc });
  drawProfilePT($('#pt-curve-sabado'), cu.profileQ.sabado, { season, dayType: 'sabado', cycle: cyc });
  drawProfilePT($('#pt-curve-domingo'), cu.profileQ.domingo, { season, dayType: 'domingo', cycle: cyc });
  $('#pt-curve-legend-text').textContent = `· cores segundo o ${cycleLabel()} em ${seasonTxt}${cu.seasonDays.inverno && cu.seasonDays.verao ? ` (o ficheiro abrange ${cu.seasonDays.inverno} dias de Inverno e ${cu.seasonDays.verao} de Verão; a repartição usa o horário correto de cada dia)` : ''}. ${scheduleText(cyc)}`;
}

/** 96 quarter-hour bars grouped visually by hour; each bar coloured by its tri-horário period. */
function drawProfilePT(svg, valuesQ, { season, dayType, cycle }) {
  if (!svg) return;
  const W = 720, H = 200, padL = 36, padB = 22, padT = 8;
  const hourly = Array.from({ length: 24 }, (_, h) => valuesQ.slice(h * 4, h * 4 + 4).reduce((a, b) => a + b, 0));
  const max = Math.max(0.05, ...hourly);
  const bw = (W - padL - 6) / 96;
  const yOf = (v) => padT + (H - padB - padT) * (1 - v / max);
  let out = '';
  for (const t of [0.25, 0.5, 0.75, 1]) { const y = yOf(max * t); out += `<line class="grid" x1="${padL}" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="2" y="${(y + 4).toFixed(1)}">${ctx.fmtNum(max * t, 2)}</text>`; }
  valuesQ.forEach((v, q) => {
    const h = Math.floor(q / 4), per = periodFor({ season, dayType, minute: q * 15, cycle, option: 3 });
    const vh = v * 4; // kWh/h scale so the bars are comparable to the hourly axis
    const x = padL + q * bw, y = yOf(vh);
    out += `<rect class="${per}" x="${(x + 0.5).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${Math.max(0, H - padB - y).toFixed(1)}"><title>${String(h).padStart(2, '0')}:${String((q % 4) * 15).padStart(2, '0')} · ${ctx.fmtNum(v, 3)} kWh no quarto de hora · ${PERIOD_LABELS_PT[per]}</title></rect>`;
    if (q % 8 === 0) out += `<text x="${(x + 1).toFixed(1)}" y="${H - 6}">${String(h).padStart(2, '0')}</text>`;
  });
  svg.innerHTML = out;
}
