// Invoice text parser for Portuguese electricity bills (Endesa, EDP, Iberdrola,
// Galp, Goldenergy, Repsol, SU Eletricidade, ...). Works on the raw text extracted
// from the PDF (pdf.js) - line based, tolerant to layout differences.
//
// It extracts the billing lines the user asked for:
//   - Termo de Energia (Real)        -> kWh, €/kWh, €
//   - Termo de Potência              -> dias, €/dia, €, kVA
//   - Termo Fixo Acesso às Redes     -> dias, €/dia, €
//   - Contribuição Audiovisual       -> meses, €/mês, €
//   - Taxa Exploração DGEG           -> meses, €/mês, €
//   - Imposto Especial Consumo (Real)-> kWh, €/kWh, €
// plus period, potência contratada, tariff option, totals, IVA and supplier.

const MONTHS = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
  janeiro: 1, fevereiro: 2, março: 3, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7,
  agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

export function stripAccents(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function norm(s) {
  return stripAccents(String(s)).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Parse a Portuguese formatted number: "1.234,5678" -> 1234.5678, "-5,24" -> -5.24, "3.45" -> 3.45 */
export function ptNumber(s) {
  if (s === undefined || s === null) return null;
  let t = String(s).trim().replace(/[€%]/g, '').replace(/\s+/g, '');
  if (!t) return null;
  const neg = /^-|-$/.test(t) || /^\(.*\)$/.test(t);
  t = t.replace(/[()\-+]/g, '');
  if (/,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');          // 1.234,56 / 26,19
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');        // 1.234 (PT thousands)
  else t = t.replace(/,/g, '');                                            // 3.45 / 157 / 0.1668
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// A number token: optional sign, digits with optional "." / " " thousands groups and "," decimals,
// or a plain decimal with "." (3.45). Must be delimited (not part of a date, a code like DL-4/93 or a word).
const NUM = String.raw`-?\d+(?:[.\s]\d{3})*(?:,\d+)?|-?\d+\.\d+`;
const NUM_RE = new RegExp(String.raw`(?<![\w/.,\-])(${NUM})(?![\w/]|[.,]\d)\s*(kWh|kVA|kW|dias?|meses|m[eê]s|€\s*/\s*kWh|€\s*/\s*dia|€\s*/\s*m[eê]s|€|%)?`, 'gi');

/** All numeric tokens found in a line, in order, with their parsed values. */
function numbersIn(line) {
  const out = [];
  NUM_RE.lastIndex = 0;
  let m;
  while ((m = NUM_RE.exec(line))) {
    const v = ptNumber(m[1]);
    if (v === null) continue;
    const unit = stripAccents((m[2] || '').toLowerCase()).replace(/\s/g, '');
    out.push({ raw: m[1], value: v, unit, index: m.index });
  }
  return out;
}

/** Remove the footnote formula lines ("** 30 x 0,1234/dia", "Desconto ... x 6,00%") */
function isFootnote(line) {
  const n = norm(line);
  return /^\*+/.test(line.trim()) || /^(desconto|\(\w\)|\*|\d{2} \w{3} a \d{2} \w{3}$)/.test(n) ||
    /^\d{2} \w{3}( \d{4})? a \d{2} \w{3}( \d{4})?$/.test(n);
}

// Line descriptors: id, matcher on normalised text, expected quantity unit.
const LINE_DEFS = [
  { id: 'energy', label: 'Termo de Energia (Real)', unit: 'kwh',
    test: (n) => !/reativa|^total|^iva/.test(n) && (/termo de energia|termo variavel|termo de consumo/.test(n) || /^consumo de energia/.test(n) || /^energia( ativa| consumida)?( \(?(real|estimad\w*)\)?)?( -)?( (simples|fora de vazio|fora vazio|vazio|ponta|cheias?))?( \(?(real|estimad\w*)\)?)?( \d|$)/.test(n)),
    subtype: (n) => /vazio/.test(n) && !/fora/.test(n) ? 'vazio' : /fora de vazio|fora vazio/.test(n) ? 'foraVazio' : /ponta/.test(n) ? 'ponta' : /cheia/.test(n) ? 'cheias' : 'simples',
    estimated: (n) => /estimad/.test(n) },
  { id: 'power', label: 'Termo de Potência', unit: 'dias',
    test: (n) => /termo de potencia|termo fixo(?! (de )?acesso)|termo tarifario fixo/.test(n) && !/acesso as redes/.test(n),
    // "Potência contratada 3,45 kVA 31 dias x ..." style lines only count when they carry a day quantity
    weakTest: (n) => /potencia contratada|^potencia\b/.test(n) && !/acesso as redes/.test(n) && /\d\s*dias?\b/.test(n) },
  { id: 'tar', label: 'Termo Fixo Acesso às Redes', unit: 'dias',
    test: (n) => /acesso as redes/.test(n) && !/^tarifa de acesso|total|inclui|componente|aprovad/.test(n) && /\d\s*dias?\b|termo/.test(n) },
  { id: 'cav', label: 'Contribuição Audiovisual', unit: 'meses',
    test: (n) => /contribuicao (para o )?audiovisual|\bcav\b/.test(n) },
  { id: 'dgeg', label: 'Taxa Exploração DGEG', unit: 'meses',
    test: (n) => /dgeg|taxa de exploracao|taxa exploracao/.test(n) },
  { id: 'iec', label: 'Imposto Especial Consumo (Real)', unit: 'kwh',
    test: (n) => /imposto especial|\biec\b/.test(n),
    estimated: (n) => /estimad/.test(n) },
];

/**
 * Parse one billing line given its text plus (optionally) the following footnote
 * line(s) that often contain "30 x 0,1234/dia". Returns {qty, price, amount, discount, total, iva}.
 */
function parseLineNumbers(line, unitHint) {
  const nums = numbersIn(line);
  const res = { qty: null, price: null, amount: null, discount: null, total: null, iva: null };
  if (!nums.length) return res;

  // Remove numbers that are part of a kVA annotation "(3.45 kVA)" -> keep as power
  const kva = nums.find((x) => x.unit === 'kva');
  if (kva) res.kva = kva.value;
  let rest = nums.filter((x) => x.unit !== 'kva');

  // IVA rate at the end "23%" / "6%"
  const pct = rest.filter((x) => x.unit === '%');
  if (pct.length) { res.iva = pct[pct.length - 1].value; rest = rest.filter((x) => x.unit !== '%'); }

  const withUnit = (u) => rest.find((x) => x.unit === u || (u === 'dias' && x.unit === 'dia') || (u === 'meses' && x.unit === 'mes'));
  const q = withUnit(unitHint);
  if (q) { res.qty = q.value; rest = rest.filter((x) => x !== q); }
  else if (rest.length >= 3) { res.qty = rest[0].value; rest = rest.slice(1); }

  // Now typical order: price, amount, [discount], total
  const euros = rest.filter((x) => x.unit === '€' || x.unit === '' || x.unit === '€/kwh' || x.unit === '€/dia' || x.unit === '€/mes');
  if (euros.length >= 1) res.price = euros[0].value;
  if (euros.length === 2) { res.amount = euros[1].value; res.total = euros[1].value; }
  if (euros.length === 3) { res.amount = euros[1].value; res.total = euros[2].value; }
  if (euros.length >= 4) { res.amount = euros[1].value; res.discount = euros[2].value; res.total = euros[euros.length - 1].value; }

  // Some layouts print only "qty price total" -> already handled (2 euros); if price > total swap
  if (res.price !== null && res.amount === null && res.total === null && euros.length === 1) {
    res.total = res.price; res.price = null;
  }
  // Sanity: unit price should be small (< 5 €) - if not, maybe qty was missing
  if (res.price !== null && res.price > 5 && res.qty === null && euros.length >= 2) {
    res.qty = res.price; res.price = euros[1].value; res.amount = euros[2]?.value ?? null; res.total = euros[euros.length - 1].value;
  }
  // Derive price from qty/amount when the layout omits it
  if (res.price === null && res.qty && res.amount) res.price = res.amount / res.qty;
  if (res.amount === null && res.qty && res.price !== null) res.amount = +(res.qty * res.price).toFixed(2);
  if (res.total === null && res.amount !== null) res.total = res.amount + (res.discount || 0);
  return res;
}

function findPeriod(text) {
  const n = stripAccents(text);
  // "Período de Faturação: 01 jun 2020 a 01 jul 2020" / "de 01-06-2020 a 30-06-2020" / "01/06/2020 - 30/06/2020"
  const reTxt = /(\d{1,2})\s*(?:de\s*)?([a-z]{3,9})\.?\s*(?:de\s*)?(\d{4})?\s*(?:a|ate|-|–)\s*(\d{1,2})\s*(?:de\s*)?([a-z]{3,9})\.?\s*(?:de\s*)?(\d{4})/i;
  const reNum = /(\d{2})[\/.-](\d{2})[\/.-](\d{4})\s*(?:a|ate|-|–)\s*(\d{2})[\/.-](\d{2})[\/.-](\d{4})/i;
  let m = reTxt.exec(n);
  if (m) {
    const m1 = MONTHS[m[2].toLowerCase()], m2 = MONTHS[m[5].toLowerCase()];
    if (m1 && m2) {
      const y2 = +m[6], y1 = m[3] ? +m[3] : (m1 > m2 ? y2 - 1 : y2);
      return { start: iso(y1, m1, +m[1]), end: iso(y2, m2, +m[4]) };
    }
  }
  m = reNum.exec(n);
  if (m) return { start: iso(+m[3], +m[2], +m[1]), end: iso(+m[6], +m[5], +m[4]) };
  return null;
}

function iso(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }

function daysBetween(a, b) {
  const ms = Date.parse(b) - Date.parse(a);
  return Math.round(ms / 86400000);
}

function detectSupplier(text) {
  const n = norm(text);
  const table = [
    ['Endesa', /endesa/], ['EDP Comercial', /edp comercial|\bedp\b/], ['Iberdrola', /iberdrola/],
    ['Galp', /\bgalp\b/], ['Goldenergy', /goldenergy|gold energy/], ['Repsol', /repsol/],
    ['SU Eletricidade', /su eletricidade|servico universal/], ['Plenitude', /plenitude|eni\b/],
    ['MEO Energia', /meo energia/], ['Coopérnico', /coopernico/], ['Luzboa', /luzboa/],
    ['Audax', /audax/], ['Ibelectra', /ibelectra/], ['Muon', /\bmuon\b/], ['YesEnergy', /yesenergy/],
    ['Alfa Energia', /alfa energia|alfaenergia/], ['EZU', /\bezu\b/], ['G9 Energy', /g9 energy/],
  ];
  for (const [name, re] of table) if (re.test(n)) return name;
  return null;
}

function detectPower(text, lines) {
  const n = stripAccents(text);
  const cands = [];
  const re = /(\d{1,2}[.,]\d{1,2})\s*kva/gi;
  let m;
  while ((m = re.exec(n))) cands.push(ptNumber(m[1]));
  const std = [1.15, 2.3, 3.45, 4.6, 5.75, 6.9, 10.35, 13.8, 17.25, 20.7, 27.6, 34.5, 41.4];
  const good = cands.filter((v) => std.some((s) => Math.abs(s - v) < 0.01));
  if (!good.length) return null;
  // most frequent
  const freq = new Map();
  for (const v of good) freq.set(v, (freq.get(v) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function detectOption(text) {
  const n = norm(text);
  if (/tri-?horari/.test(n)) return 3;
  if (/bi-?horari/.test(n)) return 2;
  if (/simples/.test(n)) return 1;
  return null;
}

function detectTotals(text, lines) {
  const out = {};
  const rank = { invoiceTotal: 0 };
  for (const line of lines) {
    const n = norm(line);
    const nums = numbersIn(line).filter((x) => x.unit === '€' || x.unit === '');
    if (!nums.length) continue;
    const last = nums[nums.length - 1].value;
    // Invoice total: prefer the electricity invoice total over the amount to pay (which may include credit notes / other services)
    let r = 0;
    if (/total (da )?fatura (de )?(luz|eletricidade|electricidade)/.test(n)) r = 3;
    else if (/total (da )?fatura\b/.test(n)) r = 2;
    else if (/total a pagar|valor a pagar|total a debitar|importancia a pagar|montante a pagar/.test(n)) r = 1;
    if (r && r > rank.invoiceTotal) { out.invoiceTotal = last; rank.invoiceTotal = r; continue; }
    if (/total luz \(consumo\)|total luz|total eletricidade|total energia|total electricidade/.test(n) && out.energyTotal === undefined) out.energyTotal = last;
    else if (/total taxas e impostos|total (de )?impostos e taxas/.test(n) && out.taxesTotal === undefined) out.taxesTotal = last;
    else if (/^(\(?[a-z]\)? ?)?(total )?iva (a |\()?23 ?%/.test(n) && nums.length >= 1 && out.iva23 === undefined) { if (nums.length >= 2) out.iva23Base = nums[0].value; out.iva23 = last; }
    else if (/^(\(?[a-z]\)? ?)?(total )?iva (a |\()?6 ?%/.test(n) && nums.length >= 1 && out.iva6 === undefined) { if (nums.length >= 2) out.iva6Base = nums[0].value; out.iva6 = last; }
  }
  return out;
}

/**
 * Main entry point.
 * @param {string} text  full text of the PDF (pages joined with \n)
 * @returns {ParsedInvoice}
 */
export function parseInvoiceText(text) {
  const rawLines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines = [];
  // Merge footnote formula lines ("** 30 x 0,1480/dia") into the previous billing line
  for (const l of rawLines) {
    const prev = lines[lines.length - 1];
    if (prev && /^\*+\s*[\d.,]+\s*(x|×)\s*[\d.,]+/.test(l)) { lines[lines.length - 1] = prev + ' ' + l; continue; }
    lines.push(l);
  }

  const items = [];
  const warnings = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = norm(line);
    if (isFootnote(line) || /^total\b/.test(n)) continue;
    const def = LINE_DEFS.find((d) => d.test(n) || (d.weakTest && d.weakTest(n)));
    if (!def) continue;
    let nums = parseLineNumbers(line, def.unit);
    // If quantity missing, look into the next line(s) for "30 x 0,1480" footnotes or the value block
    if (nums.qty === null || nums.total === null) {
      const next = lines[i + 1] || '';
      const foot = /(\d[\d.,]*)\s*(?:x|×)\s*(\d[\d.,]*)/i.exec(next);
      if (foot) {
        nums.qty = nums.qty ?? ptNumber(foot[1]);
        nums.price = nums.price ?? ptNumber(foot[2]);
      } else if (!numbersIn(line).length && numbersIn(next).length) {
        nums = parseLineNumbers(line + ' ' + next, def.unit);
        i++;
      }
    }
    if (nums.qty === null && nums.total === null) continue;
    if (['energy', 'power', 'tar'].includes(def.id) && nums.qty === null) continue;
    if (def.unit === 'dias' && nums.qty !== null && (nums.qty < 1 || nums.qty > 400)) continue;
    if (def.unit === 'meses' && nums.qty !== null && nums.qty > 24) continue;
    if (def.unit === 'kwh' && nums.qty !== null && nums.qty > 200000) continue;
    const item = {
      id: def.id,
      label: line.replace(/\s\*\*.*$/, '').replace(/\s\d.*$/, '').trim() || def.label,
      subtype: def.subtype ? def.subtype(n) : undefined,
      estimated: def.estimated ? def.estimated(n) : false,
      qty: nums.qty, unit: def.unit === 'kwh' ? 'kWh' : def.unit,
      price: nums.price, amount: nums.amount, discount: nums.discount, total: nums.total, iva: nums.iva,
      kva: nums.kva, raw: line,
    };
    items.push(item);
  }

  // Aggregate
  const period = findPeriod(text);
  // Suppliers bill both the first and the last day ("01 jun a 01 jul" = 31 dias)
  const days = period ? daysBetween(period.start, period.end) + 1 : null;
  const power = detectPower(text, lines) ?? items.find((x) => x.kva)?.kva ?? null;
  const optionTxt = detectOption(text);

  const energyItems = items.filter((x) => x.id === 'energy');
  const energy = {
    kwh: sum(energyItems.map((x) => x.qty)),
    amount: sum(energyItems.map((x) => x.amount)),
    total: sum(energyItems.map((x) => x.total)),
    discount: sum(energyItems.map((x) => x.discount)),
    byPeriod: {},
    hasEstimated: energyItems.some((x) => x.estimated),
  };
  for (const it of energyItems) {
    const k = it.subtype || 'simples';
    const cur = energy.byPeriod[k] || { kwh: 0, amount: 0, total: 0, price: null, effectivePrice: null };
    cur.kwh += it.qty || 0; cur.amount += it.amount || 0; cur.total += it.total || 0;
    if (it.price !== null) cur.price = it.price;
    if (cur.kwh && cur.total) cur.effectivePrice = cur.total / cur.kwh;
    energy.byPeriod[k] = cur;
  }
  const discountTotal = sum(items.filter((x) => ['energy', 'power', 'tar'].includes(x.id)).map((x) => x.discount));
  if (discountTotal) warnings.push(`A fatura inclui descontos comerciais (${discountTotal.toFixed(2).replace('.', ',')} € em energia/potência). Usámos os preços efetivos após desconto; se o desconto for temporário, a sua fatura futura será mais alta.`);
  const periods = Object.keys(energy.byPeriod);
  const option = optionTxt || (periods.includes('ponta') ? 3 : periods.includes('vazio') ? 2 : 1);
  if (energy.kwh && energy.amount) energy.avgPrice = energy.amount / energy.kwh;

  const powerItem = items.find((x) => x.id === 'power' && x.qty) || items.find((x) => x.id === 'power');
  const tarItem = items.find((x) => x.id === 'tar' && x.qty) || items.find((x) => x.id === 'tar');
  const cavItem = items.find((x) => x.id === 'cav');
  const dgegItem = items.find((x) => x.id === 'dgeg');
  const iecItems = items.filter((x) => x.id === 'iec');

  const billedDays = powerItem?.qty || tarItem?.qty || days;
  const powerPerDay = (powerItem?.price || 0) + (tarItem?.price || 0);

  const totals = detectTotals(text, lines);
  const supplier = detectSupplier(text);

  if (!energyItems.length) warnings.push('Não foi encontrada a linha "Termo de Energia" – verifique os valores manualmente.');
  if (!powerItem) warnings.push('Não foi encontrada a linha "Termo de Potência".');
  if (!period) warnings.push('Não foi possível determinar o período de faturação.');
  if (!power) warnings.push('Não foi possível determinar a potência contratada (kVA).');

  return {
    supplier, period, days, billedDays, power, option,
    energy,
    power_term: powerItem ? pick(powerItem) : null,
    tar: tarItem ? pick(tarItem) : null,
    cav: cavItem ? pick(cavItem) : null,
    dgeg: dgegItem ? pick(dgegItem) : null,
    iec: iecItems.length ? { qty: sum(iecItems.map((x) => x.qty)), price: iecItems[0].price, total: sum(iecItems.map((x) => x.total)), iva: iecItems[0].iva } : null,
    powerPerDay,
    powerPerDayEffective: (powerItem ? effectivePrice(powerItem) || 0 : 0) + (tarItem ? effectivePrice(tarItem) || 0 : 0),
    discountTotal,
    totals,
    items,
    warnings,
  };
}

function pick(it) {
  return { label: it.label, qty: it.qty, unit: it.unit, price: it.price, effectivePrice: effectivePrice(it), amount: it.amount, discount: it.discount, total: it.total, iva: it.iva, kva: it.kva };
}

/** Unit price actually paid (after the "Desconto" column), falling back to the printed price. */
function effectivePrice(it) {
  if (it.qty && it.total !== null && it.total !== undefined && Number.isFinite(it.total)) return it.total / it.qty;
  return it.price;
}

function sum(arr) {
  const v = arr.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return v.length ? +v.reduce((a, b) => a + b, 0).toFixed(6) : null;
}
