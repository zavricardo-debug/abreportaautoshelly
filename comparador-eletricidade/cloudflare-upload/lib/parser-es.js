// Spanish electricity bill parser (peaje 2.0TD – mercado libre and PVPC).
// Works on the raw text extracted from the PDF (pdf.js), line based, tolerant to
// layout differences (Endesa, Iberdrola, Naturgy, Repsol, TotalEnergies, Octopus…).
//
// It extracts every cost line of the bill so the comparison can be done concept by concept:
//   - Potencia   P1 (punta) / P2 (valle)   -> kW × €/kW·día × días = €
//   - Energía    punta / llano / valle or single price -> kWh × €/kWh = €
//   - Financiación Bono Social             -> días × €/día = €
//   - Alquiler del contador                -> días × €/día = €
//   - Impuesto electricidad                -> base × % = €
//   - IVA (or IGIC / IPSI)                 -> % s/ base = €
//   - TOTAL
// plus period, potencias contratadas, consumption per period (meter readings), supplier and contract name.
import { stripAccents, ptNumber } from './parser.js';

export const esNumber = ptNumber; // es-ES numbers use the same "1.234,56" format as pt-PT

const MONTHS_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
};

function norm(s) { return stripAccents(String(s)).toLowerCase().replace(/\s+/g, ' ').trim(); }
/** Remove dotted leaders ("Consumo ..... 46,37 €") and collapse whitespace. Single dots (thousands) are kept. */
function clean(line) { return String(line).replace(/\.{2,}/g, ' ').replace(/[…·•]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/* ------------------------------------------------------------------ country detection */
const ES_MARKERS = [
  [/\b(eur|€)\s*\/\s*kw\b/, 3], [/impuesto (especial )?(sobre la )?electricidad|impuesto electrico/, 4], [/\biva (normal )?21 ?%/, 3],
  [/bono social/, 4], [/alquiler (del |de los |de )?(contador|equipos?)/, 4], [/potencias? contratadas?/, 3], [/\bcups\b/, 2],
  [/comercializador/, 2], [/2\.0 ?td/, 3], [/\bpeajes?\b/, 2], [/\bfactura\b/, 2], [/\bpunta\b/, 1], [/\bllano\b/, 3], [/\bvalle\b/, 1],
  [/\bd[ií]as?\b/, 1], [/\bkw\b/, 1], [/periodo/, 1], [/consumo/, 1],
];
const PT_MARKERS = [
  [/termo de energia/, 4], [/termo de potencia/, 4], [/acesso as redes/, 4], [/contribuicao audiovisual/, 4], [/dgeg/, 4],
  [/imposto especial (de )?consumo/, 4], [/\bkva\b/, 3], [/\biva 6 ?%/, 3], [/\biva 23 ?%/, 3], [/\bfatura\b/, 3], [/comercializador/, 0],
  [/\bvazio\b/, 3], [/\bponta\b/, 2], [/\bcheias?\b/, 2], [/\bdias?\b/, 1], [/\berse\b/, 3], [/potencia contratada/, 1],
];

/** @returns {{country:'ES'|'PT', scoreES:number, scorePT:number}} */
export function detectCountry(text) {
  const n = norm(text);
  const score = (table) => table.reduce((a, [re, w]) => a + (re.test(n) ? w : 0), 0);
  const scoreES = score(ES_MARKERS), scorePT = score(PT_MARKERS);
  return { country: scoreES > scorePT ? 'ES' : 'PT', scoreES, scorePT };
}

/* ------------------------------------------------------------------ tokens */
// A number token (es-ES "1.234,56", "277,224", "31", or plain "0.117686") followed by an optional unit.
const NUM = String.raw`-?\d{1,3}(?:\.\d{3})+(?:,\d+)?|-?\d+(?:,\d+)?|-?\d+\.\d+`;
const UNIT = String.raw`kwh|kw|d[ií]as?|(?:eur|€)\s*\/\s*kwh|(?:eur|€)\s*\/\s*kw(?:\s*[·*x]?\s*(?:d[ií]a|mes|a[ñn]o))?|(?:eur|€)\s*\/\s*d[ií]a|(?:eur|€)\s*\/\s*mes|eur|€|%`;
const TOKEN_RE = new RegExp(String.raw`(?<![\w/,.\-])(${NUM})(?![\w/]|[.,]\d)\s*(${UNIT})?(?![a-z])`, 'gi');

function unitOf(raw) {
  if (!raw) return { unit: '' };
  const u = stripAccents(raw.toLowerCase()).replace(/€/g, 'eur').replace(/\s+/g, '');
  if (u === 'kwh') return { unit: 'kwh' };
  if (u === 'kw') return { unit: 'kw' };
  if (/^dias?$/.test(u)) return { unit: 'dias' };
  if (u === 'eur/kwh') return { unit: 'eur/kwh' };
  const m = u.match(/^eur\/kw[·*x]?(dia|mes|ano)?$/);
  if (m) return { unit: 'eur/kw', per: m[1] || null };
  if (u === 'eur/dia') return { unit: 'eur/dia' };
  if (u === 'eur/mes') return { unit: 'eur/mes' };
  if (u === 'eur') return { unit: 'eur' };
  if (u === '%') return { unit: 'pct' };
  return { unit: '' };
}

/** All numeric tokens of a (cleaned) line, in order. */
function tokensOf(line) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line))) {
    const value = ptNumber(m[1]);
    if (value === null) continue;
    out.push({ raw: m[1], value, index: m.index, ...unitOf(m[2]) });
  }
  return out;
}
const first = (toks, unit) => toks.find((t) => t.unit === unit) || null;
const lastEur = (toks) => { const e = toks.filter((t) => t.unit === 'eur'); return e.length ? e[e.length - 1] : null; };
const unitless = (toks) => toks.filter((t) => !t.unit);

/* ------------------------------------------------------------------ line parsers */
function powerPrice(tok) {
  if (!tok) return null;
  // Endesa prints "Eur/kW" and multiplies by days -> €/kW·día. Yearly prices (~30 €/kW) are converted.
  const per = tok.per || (tok.value > 1.5 ? 'ano' : 'dia');
  if (per === 'ano') return tok.value / 365;
  if (per === 'mes') return tok.value * 12 / 365;
  return tok.value;
}

function parsePowerLine(n, toks) {
  const kw = first(toks, 'kw'), price = first(toks, 'eur/kw'), days = first(toks, 'dias'), amount = lastEur(toks);
  const period = /\bvalle\b|\bp3\b|\bp2\b/.test(n) && !/\bp1\b/.test(n) ? 'p2' : 'p1';
  return { period, kw: kw?.value ?? null, price: powerPrice(price), days: days?.value ?? null, amount: amount?.value ?? null };
}

function energyPeriod(n) {
  if (/\bpunta\b|\bp1\b/.test(n)) return 'punta';
  if (/\bllano\b|\bp2\b/.test(n)) return 'llano';
  if (/\bvalle\b|\bp3\b/.test(n)) return 'valle';
  return 'single';
}

function parseEnergyLine(n, toks) {
  const kwh = first(toks, 'kwh');
  let price = first(toks, 'eur/kwh')?.value ?? null;
  const amount = lastEur(toks)?.value ?? null;
  if (price === null) {
    // "Consumo 277,224 kWh 0,167283 46,37 €" (no unit printed on the price)
    const cand = unitless(toks).filter((t) => t.index > (kwh?.index ?? -1) && t.value > 0 && t.value < 1);
    if (cand.length) price = cand[0].value;
    else if (kwh && amount) price = amount / kwh.value;
  }
  return { period: energyPeriod(n), kwh: kwh?.value ?? null, price, amount };
}

function parsePerDayLine(toks) {
  const days = first(toks, 'dias'), price = first(toks, 'eur/dia'), amount = lastEur(toks);
  return { days: days?.value ?? null, price: price?.value ?? null, amount: amount?.value ?? null };
}

function parseTaxLine(toks) {
  const eur = toks.filter((t) => t.unit === 'eur');
  const pct = first(toks, 'pct');
  const amount = eur.length ? eur[eur.length - 1].value : null;
  let base = eur.length >= 2 ? eur[0].value : null;
  if (base === null) { const u = unitless(toks).filter((t) => t.value > 0); if (u.length) base = u[u.length - 1].value; }
  return { base, rate: pct ? pct.value / 100 : null, amount };
}

const DATE = String.raw`(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})`;
const DATE_PAIR = new RegExp(String.raw`${DATE}\s*(?:-|–|—|a|al|hasta|y|to)?\s*${DATE}`, 'i');
const LONG_DATE = String.raw`(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de|\s+del)?\s+(\d{4})`;
const LONG_PAIR = new RegExp(String.raw`${LONG_DATE}\s*(?:-|–|a|al|hasta|y)\s*(?:el\s+)?${LONG_DATE}`, 'i');
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function findPeriod(lines) {
  const cands = [];
  for (const raw of lines) {
    const line = clean(raw);
    const n = norm(line);
    let m = DATE_PAIR.exec(line);
    if (m) cands.push({ start: iso(m[3], m[2], m[1]), end: iso(m[6], m[5], m[4]), pref: /periodo|facturac|consumo|lectura|del/.test(n) ? 1 : 0 });
    else if ((m = LONG_PAIR.exec(stripAccents(line).toLowerCase()))) {
      const m1 = MONTHS_ES[m[2]], m2 = MONTHS_ES[m[5]];
      if (m1 && m2) cands.push({ start: iso(m[3], m1, m[1]), end: iso(m[6], m2, m[4]), pref: /periodo|facturac/.test(n) ? 1 : 0 });
    }
  }
  const good = cands.filter((c) => c.end > c.start && daysBetween(c.start, c.end) <= 400);
  if (!good.length) return null;
  good.sort((a, b) => b.pref - a.pref);
  return { start: good[0].start, end: good[0].end };
}
function daysBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000); }

/* ------------------------------------------------------------------ supplier */
const SUPPLIERS_ES = [
  ['Energía XXI (Endesa – PVPC)', /energia xxi/, 'PVPC'], ['Curenergía (Iberdrola – PVPC)', /curenergia/, 'PVPC'],
  ['Comercializadora Regulada (Naturgy – PVPC)', /comercializadora regulada/, 'PVPC'], ['Baser (EDP – PVPC)', /\bbaser\b/, 'PVPC'],
  ['Régsiti (Repsol – PVPC)', /regsiti/, 'PVPC'],
  ['Endesa', /endesa/, 'ENDESA'], ['Iberdrola', /iberdrola/, 'IBERDROLA'], ['Naturgy', /naturgy/, 'NATURGY'], ['Repsol', /repsol/, 'REPSOL'],
  ['TotalEnergies', /total ?energies/, 'TOTAL'], ['Octopus Energy', /octopus/, 'OCTOPUS'], ['Plenitude', /plenitude|\beni\b/, 'PLENITUDE'],
  ['Holaluz', /holaluz/, 'HOLALUZ'], ['Imagina Energía', /imagina energ/, 'IMAGINA'], ['Chippio', /chippio/, 'CHIPPIO'], ['EDP', /\bedp\b/, 'EDP'],
  ['Gana Energía', /gana energia/, 'GANA'], ['Podo', /\bpodo\b/, 'PODO'], ['Lucera', /lucera/, 'LUCERA'], ['Audax', /audax/, 'AUDAX'],
  ['Factor Energía', /factor energia/, 'FACTOR'], ['Som Energia', /som energia/, 'SOM'], ['Goiener', /goiener/, 'GOIENER'],
  ['Feníe Energía', /fenie energia/, 'FENIE'], ['Aldro', /\baldro\b/, 'ALDRO'], ['Visalia', /visalia/, 'VISALIA'], ['A Tu Lado Energía', /a tu lado energia/, 'ATULADO'],
];
function detectSupplierES(text) {
  const n = norm(text);
  for (const [name, re, code] of SUPPLIERS_ES) if (re.test(n)) return { supplier: name, supplierCode: code };
  return { supplier: null, supplierCode: null };
}

/* ------------------------------------------------------------------ main */
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

/**
 * @param {string} text raw text extracted from the PDF (lines separated by \n)
 */
export function parseInvoiceTextES(text) {
  const rawLines = String(text).split(/\r?\n/).map(clean).filter(Boolean);
  const warnings = [];
  const items = [];
  const powerLines = [], energyLines = [], bonoLines = [], rentLines = [], ieLines = [], ivaLines = [], totalCands = [], readings = {};
  let contracted = null, contractName = null, regulated = /pvpc|precio voluntario para el pequen|comercializador(a)? de referencia/.test(norm(text));

  for (const line of rawLines) {
    const n = norm(line);
    const toks = tokensOf(line);
    const hasUnit = (u) => toks.some((t) => t.unit === u);

    if (/potencias? contratadas?/.test(n) && hasUnit('kw')) {
      const kws = toks.filter((t) => t.unit === 'kw').map((t) => t.value);
      if (kws.length) contracted = { p1: kws[0], p2: kws[1] ?? kws[0] };
      continue;
    }
    if (/contrato de mercado libre\s*:|^(tarifa|producto|plan)( contratad[oa])?\s*:/.test(n)) {
      const m = line.match(/:\s*(.+)$/);
      if (m && !contractName) contractName = m[1].trim();
      continue;
    }
    // meter readings table: "Punta 7.161,000 7.258,000 1,00 0,000 97,000"  or  "Consumo punta 97 kWh"
    if (/^(consumo )?(punta|llano|valle)\b/.test(n) && !hasUnit('eur') && !hasUnit('eur/kwh') && !hasUnit('eur/kw')) {
      const key = energyPeriod(n);
      if (hasUnit('kwh')) readings[key] = first(toks, 'kwh').value;
      else if (toks.length >= 3 && toks.every((t) => !t.unit)) readings[key] = toks[toks.length - 1].value;
      continue;
    }
    if (/^total|^subtotal|^importe total|^total a pagar|^importe a pagar/.test(n)) {
      const e = lastEur(toks) || (unitless(toks).length ? unitless(toks)[unitless(toks).length - 1] : null);
      if (e && /^(total|importe total|total factura|total importe( de la)? factura|total a pagar|importe a pagar)\b/.test(n)) totalCands.push({ label: n, amount: e.value, pref: /^total( factura| a pagar| importe)?$|importe total( factura)?$|importe a pagar$/.test(n.replace(/[\d.,\s€]+$/, '').trim()) ? 1 : 0 });
      continue;
    }
    if (/excedent|compensaci|reactiva|vertid/.test(n)) { if (/excedent|compensaci/.test(n)) warnings.push('La factura incluye compensación de excedentes (autoconsumo); no se tiene en cuenta en la comparación.'); continue; }

    if (hasUnit('kw') && hasUnit('eur/kw') && !/kwh/.test(n.replace(/eur\/kw\b/g, ''))) { powerLines.push(parsePowerLine(n, toks)); items.push({ id: 'power', line }); continue; }
    if (hasUnit('kwh') && (hasUnit('eur/kwh') || /^(consumo|energia|termino de energia|termino variable)\b/.test(n)) && !/^total/.test(n)) {
      const e = parseEnergyLine(n, toks);
      if (e.kwh !== null && e.price !== null) { energyLines.push(e); items.push({ id: 'energy', line }); continue; }
    }
    if (/bono social/.test(n) && !/descuento|dto\.?|deducci/.test(n) && (hasUnit('eur') || hasUnit('eur/dia'))) { bonoLines.push(parsePerDayLine(toks)); items.push({ id: 'bonoSocial', line }); continue; }
    if (/alquiler/.test(n) && hasUnit('eur')) { rentLines.push(parsePerDayLine(toks)); items.push({ id: 'meterRent', line }); continue; }
    if (/impuesto( especial)?( sobre)?( la)? electricidad|impuesto electrico|\biee\b/.test(n) && hasUnit('eur')) { ieLines.push(parseTaxLine(toks)); items.push({ id: 'ie', line }); continue; }
    if (/\b(iva|igic|ipsi)\b/.test(n) && hasUnit('pct') && hasUnit('eur') && !/sin iva|precios? (con|sin)/.test(n)) { ivaLines.push({ ...parseTaxLine(toks), tax: /igic/.test(n) ? 'IGIC' : /ipsi/.test(n) ? 'IPSI' : 'IVA' }); items.push({ id: 'iva', line }); continue; }
  }

  // ---- aggregate ------------------------------------------------------------
  const aggPower = (period) => {
    const ls = powerLines.filter((l) => l.period === period);
    if (!ls.length) return null;
    const days = sum(ls.map((l) => l.days)), amount = sum(ls.map((l) => l.amount));
    const kw = ls.find((l) => l.kw !== null)?.kw ?? null;
    const price = kw && days ? amount / kw / days : ls[0].price;
    return { kw, price: price ?? ls[0].price, days: days || null, amount: r2(amount), lines: ls.length };
  };
  let p1 = aggPower('p1'), p2 = aggPower('p2');
  if (p1 && !p2 && powerLines.length >= 2) { /* two p1 lines? keep */ }
  if (!p1 && p2) { p1 = p2; p2 = null; }

  const byPeriod = {};
  for (const l of energyLines) {
    const cur = byPeriod[l.period] || { kwh: 0, amount: 0, lines: 0 };
    cur.kwh += l.kwh || 0; cur.amount += l.amount ?? r2((l.kwh || 0) * (l.price || 0)); cur.lines++;
    byPeriod[l.period] = cur;
  }
  for (const [k, v] of Object.entries(byPeriod)) { v.amount = r2(v.amount); v.price = v.kwh ? v.amount / v.kwh : energyLines.find((l) => l.period === k)?.price ?? null; if (v.lines === 1) v.price = energyLines.find((l) => l.period === k).price; }
  const single = !!byPeriod.single && !byPeriod.punta && !byPeriod.llano && !byPeriod.valle;
  const energyKwh = sum(Object.values(byPeriod).map((v) => v.kwh));
  const energyAmount = r2(sum(Object.values(byPeriod).map((v) => v.amount)));

  const per = (ls) => ls.length ? { days: sum(ls.map((l) => l.days)) || null, price: ls[0].price ?? (ls[0].amount && ls[0].days ? ls[0].amount / ls[0].days : null), amount: r2(sum(ls.map((l) => l.amount))) } : null;
  const bonoSocial = per(bonoLines), meterRent = per(rentLines);
  const ie = ieLines.length ? { base: ieLines[0].base, rate: ieLines[0].rate, amount: r2(sum(ieLines.map((l) => l.amount))) } : null;
  const iva = ivaLines.length ? { tax: ivaLines[0].tax, rate: ivaLines[0].rate, base: ivaLines[0].base, amount: r2(sum(ivaLines.map((l) => l.amount))) } : null;
  totalCands.sort((a, b) => b.pref - a.pref || b.amount - a.amount);
  const total = totalCands.length ? totalCands[0].amount : null;

  const period = findPeriod(rawLines);
  const days = p1?.days || bonoSocial?.days || meterRent?.days || (period ? daysBetween(period.start, period.end) : null);

  const power = contracted || (p1 ? { p1: p1.kw, p2: p2?.kw ?? p1.kw } : null);
  const readingsSum = sum(Object.values(readings));
  const consumption = { punta: readings.punta ?? null, llano: readings.llano ?? null, valle: readings.valle ?? null };
  if (!single) for (const k of ['punta', 'llano', 'valle']) if (byPeriod[k]) consumption[k] = byPeriod[k].kwh;
  const supplier = detectSupplierES(text);
  if (regulated && !supplier.supplierCode) supplier.supplierCode = 'PVPC';

  if (!energyLines.length) warnings.push('No se ha encontrado la línea de consumo de energía (kWh × €/kWh); revise los valores manualmente.');
  if (!powerLines.length) warnings.push('No se ha encontrado el término de potencia (kW × €/kW × días).');
  if (!period) warnings.push('No se ha podido determinar el periodo de facturación.');
  if (!power) warnings.push('No se ha podido determinar la potencia contratada (kW).');
  if (single && readingsSum === 0) warnings.push('La factura tiene un precio único y no indica el reparto del consumo por periodos (punta/llano/valle); se usa un reparto estimado para las tarifas con discriminación horaria – ajústelo si conoce sus consumos.');
  if (single && readingsSum > 0 && energyKwh && Math.abs(readingsSum - energyKwh) / energyKwh > 0.05) warnings.push(`El consumo facturado (${energyKwh} kWh) difiere de la suma de las lecturas por periodo (${readingsSum} kWh); el reparto por periodos se ajusta proporcionalmente.`);
  if (bonoSocial === null) warnings.push('No se ha encontrado la línea "Financiación Bono Social"; se aplica el valor regulado (0,024688 €/día).');
  if (meterRent === null) warnings.push('No se ha encontrado la línea "Alquiler del contador"; se aplica el valor habitual (0,026774 €/día).');

  return {
    country: 'ES',
    supplier: supplier.supplier, supplierCode: supplier.supplierCode, contractName, regulated,
    period, days, power,
    powerTerm: { p1, p2, amount: r2((p1?.amount || 0) + (p2?.amount || 0)) },
    energy: { kwh: energyKwh || null, single, byPeriod, amount: energyAmount || null, price: single ? byPeriod.single.price : null, readings: readingsSum ? readings : null, consumption },
    bonoSocial, meterRent, ie, iva, total,
    items, warnings,
  };
}
