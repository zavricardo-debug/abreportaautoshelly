// Spanish electricity bill parser (peaje 2.0TD – mercado libre and PVPC).
// Works on the raw text extracted from the PDF (pdf.js), line based, tolerant to
// layout differences (Endesa, Iberdrola, Naturgy, Repsol, TotalEnergies, Octopus, Gana Energía…).
// Layouts covered by fixtures in test/fixtures: endesa-es-2026.txt (Libre Endesa, "kW x Eur/kW x días" lines),
// gana-es-2026.txt (Gana Energía "Tarifa 24 horas": table columns "Potencia | Precio kW/día | Total", prices printed
// as plain € figures, "P1/P2/P3" labels, meter readings "P1 7386,00kWh 7451,00kWh 65,00kWh", SNOEE line, a summary
// block that repeats the taxes, and a glossary column glued to the detail lines).
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
function clean(line) { return String(line).replace(/\.{2,}/g, ' ').replace(/[…·•]+/g, ' ').replace(/(\d)\s*[x×]\s*(\d)/gi, '$1 x $2').replace(/\s+/g, ' ').trim(); }

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
// The unit may be glued to the figure ("4,6kW", "7386,00kWh", "0,089434€"); a figure followed by any other word character
// ("2.0TD", "ES0026…", "00h") is not a token.
const TOKEN_RE = new RegExp(String.raw`(?<![\w/,.\-])(${NUM})(?![.,]\d)(?:\s*(${UNIT})(?![a-z])|(?![\w/]))`, 'gi');

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
/**
 * The € amount of a cost line. Bills print a second column (bar chart with the € of previous invoices, summary
 * box…) whose labels share the vertical position of the detail lines, so the extracted line may end with figures
 * that do not belong to it ("Alquiler del contador 31 días x 0,026774 Eur/día 0,83 € 47,23 €"). Pick the € token
 * that reproduces the arithmetic of the line (qty × price) and, when that cannot be computed, the left-most one
 * (foreign columns are always to the right).
 */
function pickAmount(toks, expected = null, after = -1) {
  const cands = toks.filter((t) => t.unit === 'eur' && t.index > after);
  if (!cands.length) return null;
  if (expected !== null && Number.isFinite(expected)) {
    let best = null;
    for (const c of cands) { const d = Math.abs(c.value - expected); if (!best || d < best.d) best = { c, d }; }
    if (best.d <= 0.015) return best.c;
  }
  return cands[0];
}

/**
 * The period label that governs a figure is the last "P1/P2/P3/punta/llano/valle" printed BEFORE it: text glued to the
 * end of the line (glossary column "P1 De lunes a viernes…", "Periodo Llano") must not override the row's own label.
 */
function labelBefore(line, tok) {
  const pre = stripAccents(String(line).slice(0, tok ? tok.index : undefined)).toLowerCase();
  const m = [...pre.matchAll(/\b(punta|llano|valle|p1|p2|p3)\b/g)].pop();
  return m ? m[1] : null;
}
/** Power/energy lines whose price is printed as a plain € figure (column headers "Precio kW/día" / "Precio kWh"):
 *  the € that, multiplied by the quantity (× days for power), reproduces a later € of the line. */
function priceByArithmetic(toks, qtyTok, days = 1) {
  if (!qtyTok || !days) return null;
  const eurs = toks.filter((t) => t.unit === 'eur' && t.index > qtyTok.index);
  for (let i = 0; i < eurs.length - 1; i++) {
    if (eurs[i].value <= 0 || eurs[i].value >= 2) continue;
    if (eurs.slice(i + 1).some((a) => Math.abs(qtyTok.value * eurs[i].value * days - a.value) <= 0.015)) return eurs[i];
  }
  return null;
}

/** "Libre Endesa Segmento de cargos: 1" / "Tarifa 24 horas Número de contador: 46951230 Es el…" → the value stops where the
 *  next field label of the same row (or of a glued neighbouring column) starts. */
const FIELD_LABEL_RE = /^(numero|n[º°o]\.?|no\.?|num\.?|segmento|cups|referencia|ref\.?|contrato|tarifa de acceso|peaje|potencias?|fecha|direccion|titular|cliente|codigo|forma de pago|iban|distribuidora|tipo de|duracion|fin de|inicio|periodo|datos|nif|cif|dni|telefono|email|e-mail|web)\b[^:]{0,30}:/;
function cutAtNextField(value) {
  const words = clean(value).split(' ');
  for (let i = 1; i < words.length; i++) {
    if (FIELD_LABEL_RE.test(stripAccents(words.slice(i).join(' ')).toLowerCase())) return words.slice(0, i).join(' ').replace(/[,;:.\s]+$/, '');
  }
  return words.join(' ').replace(/[,;:.\s]+$/, '');
}

/* ------------------------------------------------------------------ line parsers */
function powerPrice(tok) {
  if (!tok) return null;
  // Endesa prints "Eur/kW" and multiplies by days -> €/kW·día. Yearly prices (~30 €/kW) are converted.
  const per = tok.per || (tok.value > 1.5 ? 'ano' : 'dia');
  if (per === 'ano') return tok.value / 365;
  if (per === 'mes') return tok.value * 12 / 365;
  return tok.value;
}

function parsePowerLine(n, toks, line = '') {
  const kw = first(toks, 'kw'), days = first(toks, 'dias');
  let price = first(toks, 'eur/kw'), unit = powerPrice(price);
  if (!price) { price = priceByArithmetic(toks, kw, days?.value); unit = price ? price.value : null; }   // "P1: 4,6 kW 0,089434€ 12,75€"
  const amount = pickAmount(toks, kw && unit !== null && days ? kw.value * unit * days.value : null, price ? price.index : -1);
  const lab = labelBefore(line, kw);
  const period = lab ? (/^(p2|p3|valle)$/.test(lab) ? 'p2' : 'p1') : (/\bvalle\b|\bp3\b|\bp2\b/.test(n) && !/\bp1\b/.test(n) ? 'p2' : 'p1');
  return { period, kw: kw?.value ?? null, price: unit, days: days?.value ?? null, amount: amount?.value ?? null };
}
const isPowerLine = (n, toks) => toks.some((t) => t.unit === 'kw') && !/kwh/.test(n.replace(/eur\/kw\b/g, '')) &&
  (toks.some((t) => t.unit === 'eur/kw') || !!priceByArithmetic(toks, first(toks, 'kw'), first(toks, 'dias')?.value));

function energyPeriod(n) {
  if (/\bpunta\b|\bp1\b/.test(n)) return 'punta';
  if (/\bllano\b|\bp2\b/.test(n)) return 'llano';
  if (/\bvalle\b|\bp3\b/.test(n)) return 'valle';
  return 'single';
}

function parseEnergyLine(n, toks, line = '') {
  const kwh = first(toks, 'kwh');
  const priceTok = first(toks, 'eur/kwh') || priceByArithmetic(toks, kwh);   // "P1: 65 kWh 0,129000 € 8,38 €" (price as a plain € figure)
  let price = priceTok?.value ?? null;
  if (price === null) {
    // "Consumo 277,224 kWh 0,167283 46,37 €" (no unit printed on the price)
    const cand = unitless(toks).filter((t) => t.index > (kwh?.index ?? -1) && t.value > 0 && t.value < 1);
    if (cand.length) price = cand[0].value;
  }
  const amount = pickAmount(toks, kwh && price !== null ? kwh.value * price : null, priceTok ? priceTok.index : -1)?.value ?? null;
  if (price === null && kwh && amount) price = amount / kwh.value;
  const lab = labelBefore(line, kwh);
  const period = lab ? (/^(p1|punta)$/.test(lab) ? 'punta' : /^(p2|llano)$/.test(lab) ? 'llano' : 'valle') : energyPeriod(n);
  return { period, kwh: kwh?.value ?? null, price, amount };
}

function parsePerDayLine(toks) {
  const days = first(toks, 'dias'), price = first(toks, 'eur/dia');
  const amount = pickAmount(toks, days && price ? days.value * price.value : null);
  return { days: days?.value ?? null, price: price?.value ?? null, amount: amount?.value ?? null };
}

function parseTaxLine(toks) {
  const eur = toks.filter((t) => t.unit === 'eur');
  const pct = first(toks, 'pct');
  const rate = pct ? pct.value / 100 : null;
  const pctIdx = pct ? pct.index : -1;
  // base: "( 69,85 Eur X 5,11 %) 3,57 €" -> the € printed before the percentage; "IVA 21 % s/ 74,25 15,59 €" -> the
  // unitless figure; "IVA 21 % 74,25 € 15,59 €" -> the first of two € tokens
  let baseTok = eur.find((t) => t.index < pctIdx) || null;
  let base = baseTok?.value ?? null;
  if (base === null) { const u = unitless(toks).filter((t) => t.value > 0 && t.index > pctIdx); if (u.length) base = u[0].value; }
  if (base === null) { const u = unitless(toks).filter((t) => t.value > 0); if (u.length) base = u[u.length - 1].value; }
  if (base === null && eur.length >= 2) { baseTok = eur[0]; base = baseTok.value; }
  const amount = pickAmount(toks, base !== null && rate !== null ? base * rate : null, baseTok ? baseTok.index : -1)?.value ?? null;
  return { base, rate, amount };
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
  ['Gana Energía', /gana ?energia|gaolania/, 'GANA'], ['Podo', /\bpodo\b/, 'PODO'], ['Lucera', /lucera/, 'LUCERA'], ['Audax', /audax/, 'AUDAX'],
  ['Factor Energía', /factor energia/, 'FACTOR'], ['Som Energia', /som energia/, 'SOM'], ['Goiener', /goiener/, 'GOIENER'],
  ['Feníe Energía', /fenie energia/, 'FENIE'], ['Aldro', /\baldro\b/, 'ALDRO'], ['Visalia', /visalia/, 'VISALIA'], ['A Tu Lado Energía', /a tu lado energia/, 'ATULADO'],
];
function detectSupplierES(text) {
  const n = norm(text);
  // regulated brands first (an Energía XXI bill also mentions Endesa); then the most mentioned comercializadora,
  // ignoring the distribution company ("Distribuidora: EDP - Hidrocantábrico…")
  for (const [name, re, code] of SUPPLIERS_ES) if (code === 'PVPC' && re.test(n)) return { supplier: name, supplierCode: code };
  const nd = n.replace(/distribuidora?\s*:?\s*[^:]{0,60}/g, ' ');
  let best = null;
  for (const [name, re, code] of SUPPLIERS_ES) {
    if (code === 'PVPC') continue;
    const count = (nd.match(new RegExp(re.source, 'g')) || []).length;
    if (count && (!best || count > best.count)) best = { supplier: name, supplierCode: code, count };
  }
  return best ? { supplier: best.supplier, supplierCode: best.supplierCode } : { supplier: null, supplierCode: null };
}

/**
 * Postal code of the supply point: a Spanish 5-digit code (01000–52999); the ones printed with the supply/billing
 * address win, the comercializadora's registered office (CIF, Registro Mercantil…) loses.
 */
function findPostalCode(lines) {
  const score = new Map();
  for (const raw of lines) {
    const line = clean(raw), n = norm(line);
    const office = /\bcif\b|inscrita|registro mercantil|domicilio social|\btomo\b|\bhoja\b|\bfolio\b/.test(n);
    for (const m of line.matchAll(/(?<![\d.,])(?:0[1-9]|[1-4]\d|5[0-2])\d{3}(?![\d.,]|\s*(?:€|eur|kwh|kw|%))/gi)) {
      let w = 1;
      if (/c\.?\s*p\.?\s*:|codigo postal/.test(n)) w += 3;
      if (/direccion|suministro|domicilio|titular/.test(n)) w += 2;
      if (/^[\s,.\-–]*[a-záéíóúñ]/i.test(line.slice(m.index + 5, m.index + 40))) w += 1;   // followed by the town
      if (office) w -= 5;
      score.set(m[0], (score.get(m[0]) || 0) + w);
    }
  }
  let best = null;
  for (const [cp, w] of score) if (w > 0 && (!best || w > best.w)) best = { cp, w };
  return best ? best.cp : null;
}

/* ------------------------------------------------------------------ main */
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);

// Informative consumption lines of the first page ("Consumo medio diario 8,94 kWh", "Consumo mismo periodo
// año anterior 301 kWh 52,10 €", "Consumo anual estimado 3.300 kWh"…) are NOT cost lines.
const INFO_RE = /\bmedi[oa]\b|\banual\b|estimad|anterior|histor|acumulad|previst|habitual|equivalente|ultimos? \d+|mismo periodo|\bcoste medio|por dia\b|comparativ|\bgrafic/;
// Discounts (part of the current tariff – reduce the taxable base), management fees (indexed tariffs) and
// optional services (maintenance, insurance… – outside the energy tariff, IVA only).
const DISCOUNT_RE = /descuento|\bdto\b|bonificaci|promoci|regalo|ahorro aplicado/;
const FEE_RE = /\bcuota\b|gesti[oó]n|comercializaci[oó]n/;
const SERVICE_RE = /servicio|mantenimiento|protecci|seguro|asistencia|urgencias|reparaci|ok ?luz|funciona|hogar|averias|\bplan\b/;
const SUBTOTAL_RE = /^(?:por )?(potencia|energia|varios|impuestos|otros|servicios|descuentos|base imponible)(?: contratada| consumida| conceptos)?\s*:?\s*(-?[\d.]+,\d{2})\s*(?:€|eur)(?![\w/])/;
// Regulated contribution to the national energy-efficiency fund (SNOEE) that some comercializadoras bill apart: part of
// the tariff (taxed like the energy), read as a fixed line.
const SNOEE_RE = /obligaciones de eficiencia|eficiencia energetica|\bsnoee\b|fondo nacional de eficiencia/;

/**
 * @param {string} text raw text extracted from the PDF (lines separated by \n)
 */
export function parseInvoiceTextES(text) {
  const rawLines = String(text).split(/\r?\n/).map(clean).filter(Boolean);
  const warnings = [];
  const items = [];
  const powerLines = [], energyLines = [], bonoLines = [], rentLines = [], ieLines = [], ivaLines = [], totalCands = [], readings = {};
  const discountLines = [], feeLines = [], serviceLines = [], subtotals = {};
  let contracted = null, contractName = null, regulated = /pvpc|precio voluntario para el pequen|comercializador(a)? de referencia/.test(norm(text));

  // The same cost line printed twice (copy of the invoice, "detalle" repeated on another page) must count once.
  const seenLines = new Set();
  let duplicatesSkipped = 0;
  const take = (id, line, n) => {
    if (seenLines.has(n)) { duplicatesSkipped++; return false; }
    seenLines.add(n); items.push({ id, line }); return true;
  };
  // The summary box of some bills repeats the taxes of the detail ("Impuesto Eléctrico (5,112696%) 3,72€" and, later,
  // "5,112696% sobre 72,75 3,72 €"): the same tax amount is counted once, keeping the base when one of them prints it.
  const addTax = (arr, t) => {
    const dup = arr.find((x) => x.amount !== null && t.amount !== null && Math.abs(x.amount - t.amount) < 0.005 && (x.rate === null || t.rate === null || Math.abs(x.rate - t.rate) < 1e-6));
    if (dup) { if (dup.base === null && t.base !== null) dup.base = t.base; if (dup.rate === null) dup.rate = t.rate; return; }
    arr.push(t);
  };
  // A bare "Impuesto Eléctrico" / "IVA" heading whose figures come on the next line ("5,112696% sobre 72,75 3,72 €")
  let pendingHeader = null;
  // Multi-invoice documents (Endesa): the electricity invoice is followed by a separate "FACTURA DE SERVICIOS"
  // (maintenance / insurance products with their own IVA and total) and a "RESUMEN TOTAL DE LAS FACTURAS" with the
  // grand total "Total importe a pagar". Those figures must not be mixed with the electricity invoice.
  let section = 'electricity', totalToPay = null;
  const svc = { iva: null, total: null };

  for (let line of rawLines) {
    if (pendingHeader && /^\d+(,\d+)?\s*%/.test(norm(line))) line = `${pendingHeader} ${line}`;
    const n = norm(line);
    const toks = tokensOf(line);
    const hasUnit = (u) => toks.some((t) => t.unit === u);
    const isInfo = INFO_RE.test(n);

    if (!hasUnit('eur')) {
      if (/factura de (servicios|mantenimiento|productos)|detalle de (los )?servicios (contratados|adicionales)/.test(n)) { section = 'services'; continue; }
      if (/resumen (total )?de (las|sus|tus) facturas/.test(n)) { section = 'summary'; continue; }
      if (/factura de electricidad|factura electrica/.test(n) && section === 'services') { section = 'electricity'; continue; }
    }
    if (section === 'services') {
      if (/\b(iva|igic|ipsi)\b/.test(n) && hasUnit('pct') && hasUnit('eur')) { svc.iva = r2((svc.iva || 0) + lastEur(toks).value); items.push({ id: 'servicesIva', line }); continue; }
      if (/^total|^importe total|^importe a pagar/.test(n) && hasUnit('eur')) { svc.total = lastEur(toks).value; continue; }
      if (hasUnit('eur') && !isInfo && !hasUnit('kwh') && !hasUnit('kw')) {
        const amount = lastEur(toks).value;
        const label = cutAtNextField(line.replace(/\s*[-−]?\s*[\d.]+,\d{2}\s*(€|eur)\s*$/i, '').replace(/[\s:(]+$/, ''));
        if (take('service', line, n)) serviceLines.push({ label, amount: DISCOUNT_RE.test(n) ? -Math.abs(amount) : amount, invoice: 'services' });
      }
      continue;   // dates, contract references, addresses of the services invoice
    }
    if (section === 'summary') {
      if (!hasUnit('eur')) continue;
      if (/factura de electricidad|factura electrica/.test(n)) { totalCands.push({ label: n, amount: lastEur(toks).value, pref: 1, pos: 0 }); continue; }
      if (/factura de (servicios|mantenimiento|productos)/.test(n)) { if (svc.total === null) svc.total = lastEur(toks).value; continue; }
      if (/^total|a pagar/.test(n)) { totalToPay = lastEur(toks).value; continue; }
      continue;
    }
    pendingHeader = !hasUnit('eur') && !hasUnit('pct') && /^(impuesto( especial)?( sobre)?( la)? electricidad|impuesto electrico|iva|igic|ipsi)\b/.test(n)
      ? (/^iva\b/.test(n) ? 'IVA' : /^igic\b/.test(n) ? 'IGIC' : /^ipsi\b/.test(n) ? 'IPSI' : 'Impuesto electricidad') : null;

    // section subtotals of the bill ("Potencia 22,71 €", "Energía 46,37 €", "Impuestos 19,16 €") – used only to cross-check
    const st = SUBTOTAL_RE.exec(n);
    if (st) { if (subtotals[st[1]] === undefined) subtotals[st[1]] = ptNumber(st[2]); continue; }

    if (/potencias? contratadas?/.test(n) && hasUnit('kw')) {
      const kws = toks.filter((t) => t.unit === 'kw').map((t) => t.value);
      if (kws.length) contracted = { p1: kws[0], p2: kws[1] ?? kws[0] };
      continue;
    }
    if (/contrato de mercado libre\s*:|^(tarifa|producto|plan)( contratad[oa])?\s*:/.test(n)) {
      const m = line.match(/:\s*(.+)$/);
      if (m && !contractName) contractName = cutAtNextField(m[1]);
      continue;
    }
    // meter readings with P1/P2/P3 labels: "P1 7386,00kWh 7451,00kWh 65,00kWh" (anterior, actual, consumo) – the row may
    // come glued to a neighbouring column ("0,85% Alquiler de contador P2 6928,00kWh 7000,00kWh 72,00kWh")
    const rd = !hasUnit('eur') && !hasUnit('eur/kwh') && n.match(/\bp([123])\s+[\d.]+(?:,\d+)?\s*kwh\s+[\d.]+(?:,\d+)?\s*kwh\s+([\d.]+(?:,\d+)?)\s*kwh/);
    if (rd) { readings[energyPeriod(`p${rd[1]}`)] = ptNumber(rd[2]); continue; }
    if (/^p[123]\b(?!:)/.test(n) && hasUnit('kwh') && !hasUnit('eur') && !hasUnit('eur/kwh')) {
      const ks = toks.filter((t) => t.unit === 'kwh');
      readings[energyPeriod(n)] = ks.length >= 3 ? ks[ks.length - 1].value : ks[0].value;
      continue;
    }
    // meter readings table: "Punta 7.161,000 7.258,000 1,00 0,000 97,000"  or  "Consumo punta 97 kWh"
    // (a € figure glued to a readings row comes from another column of the page – chart labels – and is ignored)
    // meter readings by period: "Punta 7.161,000 7.258,000 1,00 0,000 97,000" (anterior, actual, factor, …, consumo) or
    // "Consumo punta 97 kWh"; the row may come glued to the end of a text line of a neighbouring column ("…(BOE 22-12-2025)
    // Punta 7.161,000 7.258,000 1,00 0,000 97,000") or be followed by a figure of a chart ("… 97,000 55,10 €")
    const rr = !hasUnit('eur/kwh') && !hasUnit('eur/kw') && !hasUnit('kw') && n.match(/(?:^|\s)(?:consumo )?(punta|llano|valle)\b((?:\s+-?[\d.]+(?:,\d+)?\s*(?:kwh|€|eur|%)?)+)\s*$/);
    if (rr) {
      const key = energyPeriod(rr[1]);
      const after = toks.filter((t) => t.index >= rr.index);
      const own = after.filter((t) => !t.unit), ks = after.filter((t) => t.unit === 'kwh');
      if (ks.length) readings[key] = ks.length >= 3 ? ks[ks.length - 1].value : ks[0].value;
      else if (own.length >= 3 && after.every((t) => !t.unit || t.unit === 'eur')) readings[key] = own[own.length - 1].value;
      else if (own.length >= 1 && own.length < 3 && !after.some((t) => t.unit === 'eur') && /^(consumo )?(punta|llano|valle)\b/.test(n)) readings[key] = own[own.length - 1].value;
      continue;
    }
    if (/^total|^subtotal|^importe total|^total a pagar|^importe a pagar/.test(n)) {
      if (/^(total|importe total|total factura|total importe( de la)? factura|total a pagar|importe a pagar)\b/.test(n)) {
        const pref = /^total( factura| a pagar| importe)?$|importe total( factura)?$|importe a pagar$/.test(n.replace(/[\d.,\s€]+(eur)?[\d.,\s€]*$/i, '').trim()) ? 1 : 0;
        const eurs = toks.filter((t) => t.unit === 'eur');
        const cands = eurs.length ? eurs : unitless(toks).slice(-1);
        // left-most first: figures of a foreign column (chart labels) are appended to the right
        cands.forEach((t, i) => totalCands.push({ label: n, amount: t.value, pref, pos: i }));
      }
      continue;
    }
    if (/excedent|compensaci|reactiva|vertid/.test(n)) { if (/excedent|compensaci/.test(n)) warnings.push('La factura incluye compensación de excedentes (autoconsumo); no se tiene en cuenta en la comparación.'); continue; }

    if (isPowerLine(n, toks) && !DISCOUNT_RE.test(n)) { if (take('power', line, n)) powerLines.push(parsePowerLine(n, toks, line)); continue; }
    if (hasUnit('kwh') && !isInfo && !DISCOUNT_RE.test(n) && (hasUnit('eur/kwh') || /^(consumo|energia|termino de energia|termino variable)\b/.test(n) || priceByArithmetic(toks, first(toks, 'kwh'))) && !/^total/.test(n)) {
      const e = parseEnergyLine(n, toks, line);
      if (e.kwh !== null && e.price !== null && e.amount !== null) { if (take('energy', line, n)) energyLines.push(e); continue; }
    }
    if (/bono social|\bb\.? ?social\b/.test(n) && !/descuento|dto\.?|deducci/.test(n) && (hasUnit('eur') || hasUnit('eur/dia'))) { if (take('bonoSocial', line, n)) bonoLines.push(parsePerDayLine(toks)); continue; }
    if (/alquiler/.test(n) && hasUnit('eur')) { if (take('meterRent', line, n)) rentLines.push(parsePerDayLine(toks)); continue; }
    if (/impuesto( especial)?( sobre)?( la)? electricidad|impuesto electrico|\biee\b/.test(n) && hasUnit('eur')) { if (take('ie', line, n)) addTax(ieLines, parseTaxLine(toks)); continue; }
    if (/\b(iva|igic|ipsi)\b/.test(n) && hasUnit('pct') && hasUnit('eur') && !/sin iva|precios? (con|sin)/.test(n)) { if (take('iva', line, n)) addTax(ivaLines, { ...parseTaxLine(toks), tax: /igic/.test(n) ? 'IGIC' : /ipsi/.test(n) ? 'IPSI' : 'IVA' }); continue; }
    // other cost lines of the bill: discounts, management fees, SNOEE contribution, optional services
    if (hasUnit('eur') && !isInfo && !/^total|impuesto|iva\b|peaje|cargos?\b|coste de|destino/.test(n)) {
      const amount = lastEur(toks).value;
      const label = line.replace(/\s*[-−]?\s*[\d.]+,\d{2}\s*(€|eur)\s*$/i, '').replace(/[\s:(]+$/, '').trim();
      if (DISCOUNT_RE.test(n)) { if (take('discount', line, n)) discountLines.push({ label, amount: -Math.abs(amount) }); continue; }
      if (SNOEE_RE.test(n) || (FEE_RE.test(n) && !SERVICE_RE.test(n))) { if (take('fee', line, n)) feeLines.push({ label, amount }); continue; }
      if (SERVICE_RE.test(n)) { if (take('service', line, n)) serviceLines.push({ label, amount }); continue; }
    }
  }

  // ---- aggregate ------------------------------------------------------------
  const aggPower = (period) => {
    const ls = powerLines.filter((l) => l.period === period);
    if (!ls.length) return null;
    const days = sum(ls.map((l) => l.days)), amount = sum(ls.map((l) => l.amount));
    const kw = ls.find((l) => l.kw !== null)?.kw ?? null;
    const printed = ls[0].price ?? null;
    const effective = kw && days ? amount / kw / days : null;
    // one line: keep the unit price printed on the bill when it reproduces the billed amount (otherwise the unit was
    // misread – e.g. €/kW·mes – and the effective price is safer); several lines (price change mid-period): weighted average
    let price = printed ?? effective;
    if (ls.length > 1) price = effective ?? printed;
    else if (printed != null && effective != null && Math.abs(r2(kw * printed * days) - r2(amount)) > 0.011) price = effective;
    return { kw, price, days: days || null, amount: r2(amount), lines: ls.length };
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
  // the TOTAL of the bill: among the candidates the one that equals the sum of the concepts read (when all are
  // there); otherwise the preferred label, left-most figure, largest amount
  const iePre = ieLines.length ? r2(sum(ieLines.map((l) => l.amount))) : null;
  const ivaPre = ivaLines.length ? r2(sum(ivaLines.map((l) => l.amount))) : null;
  const componentsSum = energyLines.length && powerLines.length && iePre !== null && ivaPre !== null
    ? r2(sum(powerLines.map((l) => l.amount)) + sum(Object.values(byPeriod).map((v) => v.amount)) + sum(bonoLines.map((l) => l.amount)) + sum(rentLines.map((l) => l.amount)) + iePre + ivaPre + sum(discountLines.map((l) => l.amount)) + sum(feeLines.map((l) => l.amount)) + sum(serviceLines.filter((l) => l.invoice !== 'services').map((l) => l.amount)))
    : null;
  totalCands.sort((a, b) => b.pref - a.pref || a.pos - b.pos || b.amount - a.amount);
  const matching = componentsSum !== null ? totalCands.find((c) => Math.abs(c.amount - componentsSum) <= 0.05) : null;
  const total = matching ? matching.amount : totalCands.length ? totalCands[0].amount : null;

  const period = findPeriod(rawLines);
  const days = p1?.days || bonoSocial?.days || meterRent?.days || (period ? daysBetween(period.start, period.end) : null);
  // "B. Social Orden TED/634/2026 0,77 €" prints the amount only: the regulated €/día reproduces it (31 × 0,024688 = 0,77)
  if (bonoSocial && bonoSocial.days === null && days) bonoSocial.days = days;
  const postalCode = findPostalCode(rawLines);

  const power = contracted || (p1 ? { p1: p1.kw, p2: p2?.kw ?? p1.kw } : null);
  const readingsSum = sum(Object.values(readings));
  const consumption = { punta: readings.punta ?? null, llano: readings.llano ?? null, valle: readings.valle ?? null };
  if (!single) for (const k of ['punta', 'llano', 'valle']) if (byPeriod[k]) consumption[k] = byPeriod[k].kwh;
  const supplier = detectSupplierES(text);
  if (regulated && !supplier.supplierCode) supplier.supplierCode = 'PVPC';
  const discountAmount = r2(sum(discountLines.map((l) => l.amount)));
  const feeAmount = r2(sum(feeLines.map((l) => l.amount)));
  const serviceAmount = r2(sum(serviceLines.map((l) => l.amount)));
  const svcLines = serviceLines.filter((l) => l.invoice === 'services');
  const servicesInvoice = svcLines.length || svc.total !== null || svc.iva !== null
    ? { lines: svcLines, amount: r2(sum(svcLines.map((l) => l.amount))), iva: svc.iva, total: svc.total }
    : null;
  if (totalToPay === null && servicesInvoice && total !== null && servicesInvoice.total !== null) totalToPay = r2(total + servicesInvoice.total);
  if (totalToPay !== null && total !== null && Math.abs(totalToPay - total) < 0.005) totalToPay = null;   // single invoice: nothing to add

  // cross-check against the section subtotals printed on the bill
  const powerAmount = r2((p1?.amount || 0) + (p2?.amount || 0));
  const off = (a, b) => a !== undefined && b !== null && Math.abs(a - b) > 0.02;
  if (off(subtotals.potencia, powerAmount) && powerLines.length) warnings.push(`El subtotal "Potencia" de la factura (${fmt(subtotals.potencia)} €) no coincide con la suma de las líneas de potencia leídas (${fmt(powerAmount)} €); revise los valores.`);
  if (off(subtotals.energia, r2(energyAmount + (subtotals.descuentos === undefined ? discountAmount : 0))) && off(subtotals.energia, energyAmount) && energyLines.length) warnings.push(`El subtotal "Energía" de la factura (${fmt(subtotals.energia)} €) no coincide con la suma de las líneas de energía leídas (${fmt(energyAmount)} €); revise los valores.`);
  if (off(subtotals.impuestos, r2((ie?.amount || 0) + (iva?.amount || 0))) && ie && iva) warnings.push(`El subtotal "Impuestos" de la factura (${fmt(subtotals.impuestos)} €) no coincide con impuesto eléctrico + IVA leídos (${fmt(r2(ie.amount + iva.amount))} €).`);
  const otrosBase = r2((bonoSocial?.amount || 0) + (meterRent?.amount || 0) + feeAmount);
  const otrosRead = r2(otrosBase + sum(serviceLines.filter((l) => l.invoice !== 'services').map((l) => l.amount)));
  if (off(subtotals.otros, otrosRead) && off(subtotals.varios, otrosRead) && off(subtotals.otros, otrosBase) && off(subtotals.varios, otrosBase) && (bonoSocial || meterRent)) warnings.push(`El subtotal "Otros conceptos" de la factura (${fmt(subtotals.otros ?? subtotals.varios)} €) no coincide con bono social + alquiler + cuotas leídos (${fmt(otrosRead)} €); revise los valores.`);
  if (duplicatesSkipped) warnings.push(`Se han ignorado ${duplicatesSkipped} líneas repetidas (la factura incluye una copia del detalle).`);
  if (discountLines.length) warnings.push(`Descuentos de su tarifa actual encontrados: ${discountLines.map((l) => `${l.label} (${fmt(l.amount)} €)`).join('; ')}. Se incluyen en la reconstrucción de su factura.`);
  if (serviceLines.length) warnings.push(`Servicios adicionales encontrados: ${serviceLines.map((l) => `${l.label} (${fmt(l.amount)} €)`).join('; ')}. No forman parte de la tarifa eléctrica: se tienen en cuenta en la comprobación del total pero no en la comparación.`);
  if (servicesInvoice) warnings.push(`El documento incluye una factura de servicios aparte de la de electricidad${servicesInvoice.total !== null ? ` (${fmt(servicesInvoice.total)} € con IVA)` : ''}${totalToPay !== null ? `; total a pagar ${fmt(totalToPay)} € = electricidad ${fmt(total)} € + servicios ${fmt(servicesInvoice.total ?? r2(totalToPay - total))} €` : ''}.`);

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
    supplier: supplier.supplier, supplierCode: supplier.supplierCode, contractName, regulated, postalCode,
    period, days, power,
    powerTerm: { p1, p2, amount: powerAmount },
    energy: { kwh: energyKwh || null, single, byPeriod, amount: energyAmount || null, price: single ? byPeriod.single.price : null, readings: readingsSum ? readings : null, consumption },
    bonoSocial, meterRent, ie, iva, total, totalToPay, servicesInvoice,
    discounts: discountLines, fees: feeLines, services: serviceLines, discountAmount, feeAmount, serviceAmount,
    subtotals, duplicatesSkipped,
    items, warnings,
  };
}
const fmt = (v) => (v === null || v === undefined) ? '—' : v.toFixed(2).replace('.', ',');
