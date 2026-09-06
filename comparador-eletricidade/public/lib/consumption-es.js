// Hourly consumption curve (curva de carga) of a Spanish supply point, as exported by the
// distributors' customer areas and by Datadis (CSV), classified into the 2.0TD periods
// (punta / llano / valle) so the energy line of every tariff can be simulated with the
// REAL consumption of each hour instead of the estimated split of the bill.
//
// Supported files (all ";" or "," separated, es-ES or en numbers, optional header):
//   Datadis / CNMC facturaluz       CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion
//   e-distribución (Endesa)         CUPS;Fecha;Hora;AE_kWh;AS_KWh;AE_AUTOCONS_kWh;REAL/ESTIMADO
//   i-DE (Iberdrola)                CUPS;FECHA-HORA;INV / VER;CONSUMO Wh;GENERACION Wh
//   UFD (Naturgy) / Viesgo / others  Fecha;Hora;Consumo (kWh)  – any file with date, hour and consumption columns
//   Quarter-hourly files (Fecha, Hora 1..96 or HH:MM, kWh/Wh) are aggregated to hours.
//
// 2.0TD calendar (CNMC Circular 3/2020, art. 7.3): Monday-Friday punta 10-14 h and 18-22 h,
// llano 8-10 h, 14-18 h and 22-24 h, valle 0-8 h; Saturdays, Sundays, 6 January and the fixed-date
// national holidays are valle all day. Ceuta and Melilla: punta 11-15 h / 19-23 h, llano 8-11, 15-19, 23-24.
// The distributors' "Hora" column is 1..24 and means the hour ENDING at that value (hour 1 = 00:00-01:00).

export const PERIODS = ['punta', 'llano', 'valle'];

/** Fixed-date national holidays that are valle 24 h (Circular 3/2020: "el 6 de enero y los festivos de ámbito nacional no sustituibles de fecha fija"). */
export const HOLIDAYS_MMDD = ['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'];

/** Period of a given local date/hour under the 2.0TD calendar. `hourStart` is 0..23 (hour beginning). */
export function period20TD(date, hourStart, { ceutaMelilla = false } = {}) {
  const dow = date.getDay(); // 0 Sunday … 6 Saturday
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (dow === 0 || dow === 6 || HOLIDAYS_MMDD.includes(mmdd)) return 'valle';
  const h = hourStart;
  if (h < 8) return 'valle';
  if (ceutaMelilla) {
    if ((h >= 11 && h < 15) || (h >= 19 && h < 23)) return 'punta';
    return 'llano';
  }
  if ((h >= 10 && h < 14) || (h >= 18 && h < 22)) return 'punta';
  return 'llano';
}

/* ------------------------------------------------------------------ CSV parsing */
const num = (s) => {
  if (s === undefined || s === null) return null;
  let t = String(s).trim().replace(/"/g, '').replace(/\s+/g, '');
  if (!t || /^-+$/.test(t)) return null;
  if (/,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');   // 1.234,567 / 0,143
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');   // 1.234 (thousands)
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const strip = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function detectSeparator(lines) {
  const sample = lines.slice(0, 5).join('\n');
  const counts = { ';': (sample.match(/;/g) || []).length, ',': (sample.match(/,/g) || []).length, '\t': (sample.match(/\t/g) || []).length };
  if (counts['\t'] > 0 && counts['\t'] >= counts[';']) return '\t';
  if (counts[';'] > 0) return ';';
  return ',';
}
const splitLine = (line, sep) => line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));

/** Parse "DD/MM/YYYY", "YYYY-MM-DD", "YYYY/MM/DD", "DD-MM-YYYY" (optionally followed by a time). */
function parseDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::(\d{2}))?)?/);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2})(?::(\d{2}))?)?/);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1], h: m[4] !== undefined ? +m[4] : null, mi: m[5] !== undefined ? +m[5] : null };
  return null;
}
/** Hour column: "1".."24" (hour ending), "00:00".."23:00" (hour starting), "0".."23" when a 0 appears (hour starting), or 1..96 quarter-hours. */
function parseHourToken(s) {
  if (s === undefined || s === null || s === '') return null;
  const t = String(s).trim();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (m) return { kind: 'clock', h: +m[1], mi: +m[2] };
  m = t.match(/^(\d{1,3})$/);
  if (m) return { kind: 'index', v: +m[1] };
  return null;
}

const COL = {
  date: [/^fecha$/, /^data$/, /^date$/, /^dia$/, /^fecha[ _-]?hora$/, /^fecha[ _-]?y[ _-]?hora$/, /^datetime$/, /^fecha lectura/, /^periodo/],
  hour: [/^hora$/, /^hour$/, /^periodo horario$/, /^franja/, /^intervalo/, /^tramo/],
  kwh: [/consumo/, /^ae[ _-]?kwh$/, /^ae$/, /^energia[ _-]?activa/, /^activa/, /^energia$/, /kwh/, /^wh$/, /^consumption/, /^import/],
  export: [/^as[ _-]?kwh$/, /vertid/, /excedent/, /generaci/, /^export/],
  method: [/metodo/, /real\s*\/\s*estimad/, /^tipo$/, /obtencion/, /^estimad/, /^calidad/],
};
const findCol = (headers, res) => headers.findIndex((h) => res.some((re) => re.test(h)));

/**
 * @param {string} text CSV content
 * @returns {{ hours: Array<{date:string,hour:number,kwh:number,period:string,estimated:boolean}>, days:number, totalKwh:number,
 *   byPeriod:{punta:number,llano:number,valle:number}, share:{punta:number,llano:number,valle:number}, start:string, end:string,
 *   cups:string|null, format:string, warnings:string[], estimatedShare:number, exportKwh:number, missingHours:number,
 *   profile:{ weekday:number[], weekend:number[] } }}
 */
export function parseConsumptionCSV(text, { ceutaMelilla = false } = {}) {
  const raw = String(text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^#/.test(l));
  const warnings = [];
  if (!lines.length) throw new Error('El fichero está vacío.');
  const sep = detectSeparator(lines);
  // i-DE / Naturgy sometimes prepend "CUPS: ES00…" or a title row: find the header row (first row with a date-like or hour-like column name)
  let headerIdx = lines.findIndex((l) => { const s = strip(l); return /fecha|data|date|hora|consumo|kwh/.test(s) && !/^cups\s*:/.test(s); });
  let headers = null;
  let start = 0;
  if (headerIdx >= 0 && headerIdx < 5) {
    const cells = splitLine(lines[headerIdx], sep).map(strip);
    // it's a header only if the cells are not data (no numbers/dates)
    if (!cells.some((c) => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(c) || /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(c))) { headers = cells; start = headerIdx + 1; }
  }
  let cDate, cHour, cKwh, cExp, cMet, cups = null, format = 'genérico';
  if (headers) {
    cDate = findCol(headers, COL.date); cHour = findCol(headers, COL.hour); cKwh = findCol(headers, COL.kwh); cExp = findCol(headers, COL.export); cMet = findCol(headers, COL.method);
    // "CONSUMO Wh" (i-DE) and a header that includes the unit
    if (headers.some((h) => /^consumo[ _-]?kwh$/.test(h)) && headers.some((h) => /^metodo/.test(h))) format = 'Datadis / CNMC';
    else if (headers.some((h) => /^ae[ _-]?kwh$/.test(h))) format = 'e-distribución';
    else if (headers.some((h) => /^fecha[ _-]?hora$/.test(h)) && headers.some((h) => /wh$/.test(h))) format = 'i-DE';
    else if (headers.some((h) => /^cups$/.test(h))) format = 'distribuidora';
    if (cKwh < 0) { cKwh = headers.findIndex((h, i) => i !== cDate && i !== cHour && /kwh|wh|consum|energ/.test(h)); }
  } else {
    // no header: guess by content of the first data row -> [CUPS?] date hour kwh …
    const cells = splitLine(lines[0], sep);
    cDate = cells.findIndex((c) => parseDate(c));
    cHour = cells.findIndex((c, i) => i > cDate && parseHourToken(c));
    cKwh = cells.findIndex((c, i) => i > Math.max(cDate, cHour) && num(c) !== null && !/^\d{1,2}$/.test(c.trim()));
    if (cKwh < 0) cKwh = cells.findIndex((c, i) => i > Math.max(cDate, cHour) && num(c) !== null);
    cExp = -1; cMet = cells.findIndex((c) => /^[RE]$/i.test(c.trim()));
    format = 'sin cabecera';
  }
  if (cDate < 0 || cKwh < 0) throw new Error(`No se reconocen las columnas del fichero (cabecera: ${headers ? headers.join(' | ') : 'ninguna'}). Se necesitan fecha, hora y consumo (kWh).`);

  const unitIsWh = headers ? /(^|[^k])wh\b/.test(headers[cKwh]) && !/kwh/.test(headers[cKwh]) : false;
  const buckets = new Map(); // key YYYY-MM-DD|H -> { kwh, est, n }
  let exportKwh = 0, rows = 0, bad = 0, quarter = false, maxIndex = 0, zeroBased = false;
  const parsed = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i], sep);
    if (cells.length < 2) continue;
    const dt = parseDate(cells[cDate]);
    if (!dt) { bad++; continue; }
    const ht = cHour >= 0 ? parseHourToken(cells[cHour]) : null;
    const kwhRaw = num(cells[cKwh]);
    if (kwhRaw === null) { bad++; continue; }
    if (!cups && headers && headers.includes('cups')) cups = cells[headers.indexOf('cups')] || null;
    const est = cMet >= 0 ? /^e/i.test(cells[cMet] || '') : false;
    if (cExp >= 0) exportKwh += num(cells[cExp]) || 0;
    parsed.push({ dt, ht, kwh: unitIsWh ? kwhRaw / 1000 : kwhRaw, est });
    if (ht?.kind === 'index') { maxIndex = Math.max(maxIndex, ht.v); if (ht.v === 0) zeroBased = true; }
    rows++;
  }
  if (!rows) throw new Error('No se ha encontrado ninguna fila de consumo válida en el fichero.');
  // "HH:MM" tokens: distributors (i-DE) print the hour ENDING the interval (01:00 … 24:00); a 24:00 (or 24 in the date/time) reveals it
  const clockEnding = parsed.some((p) => (p.ht?.kind === 'clock' && p.ht.h === 24) || p.dt.h === 24);
  // sub-hourly files: index 1..96 (quarters) / 1..48 (half hours) or clock tokens with minutes (00:15, 00:30 …).
  // Index 25 on a single day is the extra hour of the October DST change, still hourly.
  const minuteSet = new Set(parsed.map((p) => p.ht?.kind === 'clock' ? p.ht.mi % 60 : p.ht ? null : (p.dt.mi ?? null)).filter((v) => v !== null));
  const stepMin = minuteSet.size > 1 ? Math.round(60 / minuteSet.size) : 60;
  quarter = maxIndex > 25 || stepMin < 60;
  if (quarter) warnings.push('Fichero cuartohorario: los consumos se han agregado por horas.');
  if (unitIsWh) warnings.push('Consumos en Wh convertidos a kWh.');
  const autoWh = !unitIsWh && parsed.length && parsed.reduce((a, p) => a + p.kwh, 0) / parsed.length > 50;
  if (autoWh) { for (const p of parsed) p.kwh /= 1000; warnings.push('Los valores parecían estar en Wh (media > 50 por hora): convertidos a kWh.'); }

  const fromClock = (hh, mm) => { // clock token -> hour beginning 0..23 (interval END convention when a 24:xx appears)
    const total = hh * 60 + (mm || 0);
    const startMin = clockEnding ? total - stepMin : total;
    return Math.floor((((startMin % 1440) + 1440) % 1440) / 60);
  };
  for (const p of parsed) {
    let h; // hour beginning 0..23
    if (p.ht?.kind === 'clock') h = fromClock(p.ht.h, p.ht.mi);
    else if (p.ht?.kind === 'index') {
      const v = p.ht.v - (zeroBased ? 0 : 1);
      if (maxIndex > 25) h = Math.min(23, Math.floor(v / (maxIndex > 50 ? 4 : 2))); // 96 quarters or 48 half-hours per day
      else h = Math.min(23, Math.max(0, v));                                            // 1..24 = hour ending -> starting hour = v-1 (25 = DST extra hour)
    } else if (p.dt.h !== null) h = fromClock(p.dt.h, p.dt.mi);
    else { bad++; continue; }
    const day = `${p.dt.y}-${String(p.dt.mo).padStart(2, '0')}-${String(p.dt.d).padStart(2, '0')}`;
    const key = `${day}|${h}`;
    const b = buckets.get(key) || { day, h, kwh: 0, est: false, n: 0 };
    b.kwh += p.kwh; b.est = b.est || p.est; b.n++;
    buckets.set(key, b);
  }
  if (bad) warnings.push(`${bad} filas no se han podido interpretar y se han ignorado.`);

  const hours = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day) || a.h - b.h).map((b) => {
    const [y, mo, d] = b.day.split('-').map(Number);
    const date = new Date(y, mo - 1, d);
    return { date: b.day, hour: b.h, kwh: Math.round(b.kwh * 1e6) / 1e6, period: period20TD(date, b.h, { ceutaMelilla }), estimated: b.est };
  });
  const dayset = [...new Set(hours.map((x) => x.date))];
  const byPeriod = { punta: 0, llano: 0, valle: 0 };
  let estKwh = 0;
  for (const x of hours) { byPeriod[x.period] += x.kwh; if (x.estimated) estKwh += x.kwh; }
  const totalKwh = byPeriod.punta + byPeriod.llano + byPeriod.valle;
  const share = {}; for (const k of PERIODS) share[k] = totalKwh ? byPeriod[k] / totalKwh : 0;
  const missingHours = dayset.length * 24 - hours.length; // DST days give ±1, fine
  if (missingHours > 24) warnings.push(`Faltan ${missingHours} horas en el fichero (días incompletos).`);
  if (estKwh > 0) warnings.push(`${Math.round(100 * estKwh / totalKwh)} % del consumo procede de lecturas estimadas.`);
  if (exportKwh > 0) warnings.push(`El fichero incluye ${exportKwh.toFixed(1)} kWh de excedentes vertidos a la red (no se tienen en cuenta en la comparación).`);

  // average daily profile (kWh per hour) for weekdays and weekends/holidays – used for the chart
  const prof = { weekday: Array(24).fill(0), weekend: Array(24).fill(0) }, cnt = { weekday: 0, weekend: 0 };
  const dayKind = new Map();
  for (const x of hours) {
    if (!dayKind.has(x.date)) { const [y, mo, d] = x.date.split('-').map(Number); const dt = new Date(y, mo - 1, d); dayKind.set(x.date, period20TD(dt, 12, { ceutaMelilla }) === 'valle' ? 'weekend' : 'weekday'); }
    prof[dayKind.get(x.date)][x.hour] += x.kwh;
  }
  for (const k of dayset) cnt[dayKind.get(k)]++;
  for (const kind of ['weekday', 'weekend']) if (cnt[kind]) prof[kind] = prof[kind].map((v) => v / cnt[kind]);

  return {
    hours, days: dayset.length, totalKwh: Math.round(totalKwh * 1000) / 1000, byPeriod: Object.fromEntries(PERIODS.map((k) => [k, Math.round(byPeriod[k] * 1000) / 1000])), share,
    start: dayset[0], end: dayset[dayset.length - 1], cups, format, warnings, estimatedShare: totalKwh ? estKwh / totalKwh : 0, exportKwh: Math.round(exportKwh * 1000) / 1000,
    missingHours, profile: prof, weekdays: cnt.weekday, weekendDays: cnt.weekend,
    maxHour: hours.reduce((m, x) => (x.kwh > (m?.kwh ?? -1) ? x : m), null),
  };
}

/** Restrict the curve to a date range (inclusive, ISO strings) – e.g. the billing period of the PDF. */
export function sliceCurve(curve, startISO, endISO, { endExclusive = false, ...opts } = {}) {
  if (!curve) return null;
  const hours = curve.hours.filter((x) => (!startISO || x.date >= startISO) && (!endISO || (endExclusive ? x.date < endISO : x.date <= endISO)));
  if (!hours.length) return null;
  return rebuild(hours, curve, opts);
}
function rebuild(hours, src, { ceutaMelilla = false } = {}) {
  const csv = hours.map((x) => `${x.date};${x.hour + 1};${String(x.kwh).replace('.', ',')};${x.estimated ? 'E' : 'R'}`).join('\n');
  const out = parseConsumptionCSV('Fecha;Hora;Consumo_kWh;Metodo_obtencion\n' + csv, { ceutaMelilla });
  out.cups = src.cups; out.format = src.format; out.warnings = src.warnings.filter((w) => !/Faltan/.test(w));
  return out;
}

/** Scale the curve's period split to a given total (e.g. the kWh billed on the PDF) keeping the real hourly shares. */
export function applyShare(totalKwh, share) {
  const out = {}; for (const k of PERIODS) out[k] = Math.round((totalKwh || 0) * (share[k] || 0) * 1000) / 1000;
  return out;
}

/** Energy cost of the curve with a price set: single price or punta/llano/valle (€/kWh, sin impuestos). */
export function energyCostES(byPeriod, energy) {
  if (!energy) return 0;
  const total = PERIODS.reduce((a, k) => a + (byPeriod[k] || 0), 0);
  if (energy.single != null && energy.punta == null) return total * energy.single;
  return PERIODS.reduce((a, k) => a + (byPeriod[k] || 0) * (energy[k] ?? energy.single ?? 0), 0);
}

/**
 * "What if I shift consumption": move `fraction` of punta (and llano) kWh into valle – used to show how much
 * each tariff would cost if the household adapted its habits (dishwasher / washing machine at night or weekends).
 */
export function shiftToValle(byPeriod, fraction) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const mvP = byPeriod.punta * f, mvL = byPeriod.llano * f;
  return { punta: byPeriod.punta - mvP, llano: byPeriod.llano - mvL, valle: byPeriod.valle + mvP + mvL };
}

/** Text summary of the 2.0TD calendar (for tooltips / help). */
export const CALENDAR_TEXT_ES = 'Punta: lunes a viernes 10–14 h y 18–22 h · Llano: 8–10 h, 14–18 h y 22–24 h · Valle: 0–8 h y las 24 h de sábados, domingos y festivos nacionales (1 y 6 de enero, 1 de mayo, 15 de agosto, 12 de octubre, 1 de noviembre, 6, 8 y 25 de diciembre). Ceuta y Melilla: punta 11–15 h y 19–23 h.';
