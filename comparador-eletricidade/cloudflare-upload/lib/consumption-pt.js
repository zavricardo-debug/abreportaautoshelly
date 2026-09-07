// Consumption curve ("diagrama de carga") of a Portuguese supply point – normally the Excel/CSV
// exported from the E-Redes Balcão Digital (Consumos → Consultar consumos detalhados → Exportar),
// but also generic files with a date, an hour and a consumption column (energy meters such as
// Shelly EM, spreadsheets saved as CSV, hourly exports of the supplier's app…).
//
// Every record is normalised to QUARTER-HOURS (the granularity of the ERSE schedules, whose
// boundaries fall on :00, :15, :30 and :45) and classified with the ERSE tariff periods for
// Portugal Continental, both cycles (ciclo diário / ciclo semanal) and both options
// (bi-horário: fora de vazio / vazio · tri-horário: ponta / cheias / vazio), so the invoice can be
// compared with the market using the REAL kWh of each period even when the bill only states the
// total consumption ("simples").
//
// E-Redes format (Balcão Digital, from 2024-01-01): a few title rows, then a header with
// "Data" | "Hora" | "Consumo registado, Ativa (kW)" [| "Injeção registada, Ativa (kW)" …] [| "Estado"],
// one row per 15 minutes, dates "YYYY/MM/DD" (or Excel serials), the hour is the END of the
// quarter ("00:15" = 00:00–00:15, "00:00" = 23:45–24:00 of the previous day) and the value is the
// AVERAGE POWER in kW of that quarter → kWh = kW / 4.
//
// Schedules (ERSE, Regulamento Tarifário – hora legal de Inverno / Verão, Portugal Continental):
//   Ciclo diário  – tri-horário: Vazio 22:00–08:00; Inverno: Ponta 09:00–10:30 e 18:00–20:30,
//                   Cheias 08:00–09:00, 10:30–18:00, 20:30–22:00; Verão: Ponta 10:30–13:00 e 19:30–21:00,
//                   Cheias 08:00–10:30, 13:00–19:30, 21:00–22:00.  Bi-horário: Vazio 22:00–08:00.
//   Ciclo semanal – dias úteis: Vazio 00:00–07:00; Inverno: Ponta 09:30–12:00 e 18:30–21:00, Cheias 07:00–09:30,
//                   12:00–18:30, 21:00–24:00; Verão: Ponta 09:15–12:15, Cheias 07:00–09:15 e 12:15–24:00.
//                   Sábado (sem ponta): Inverno Cheias 09:30–13:00 e 18:30–22:00, Verão Cheias 09:00–14:00 e 20:00–22:00,
//                   restante Vazio. Domingo: Vazio todo o dia. Bi-horário: Fora de vazio = Ponta + Cheias.
//   Feriados não têm tratamento especial em Portugal.

export const CYCLES = { diario: 'Ciclo diário', semanal: 'Ciclo semanal' };
export const TRI_PERIODS = ['ponta', 'cheias', 'vazio'];
export const BI_PERIODS = ['foraVazio', 'vazio'];
export const PERIOD_LABELS_PT = { simples: 'Simples', foraVazio: 'Fora de Vazio', vazio: 'Vazio', ponta: 'Ponta', cheias: 'Cheias' };

// [startMinute, endMinute, period) – tri-horário; bi-horário derives from it (vazio → vazio, rest → foraVazio)
const H = (h, m = 0) => h * 60 + m;
export const SCHEDULES = {
  diario: {
    inverno: { any: [[0, H(8), 'vazio'], [H(8), H(9), 'cheias'], [H(9), H(10, 30), 'ponta'], [H(10, 30), H(18), 'cheias'], [H(18), H(20, 30), 'ponta'], [H(20, 30), H(22), 'cheias'], [H(22), H(24), 'vazio']] },
    verao: { any: [[0, H(8), 'vazio'], [H(8), H(10, 30), 'cheias'], [H(10, 30), H(13), 'ponta'], [H(13), H(19, 30), 'cheias'], [H(19, 30), H(21), 'ponta'], [H(21), H(22), 'cheias'], [H(22), H(24), 'vazio']] },
  },
  semanal: {
    inverno: {
      util: [[0, H(7), 'vazio'], [H(7), H(9, 30), 'cheias'], [H(9, 30), H(12), 'ponta'], [H(12), H(18, 30), 'cheias'], [H(18, 30), H(21), 'ponta'], [H(21), H(24), 'cheias']],
      sabado: [[0, H(9, 30), 'vazio'], [H(9, 30), H(13), 'cheias'], [H(13), H(18, 30), 'vazio'], [H(18, 30), H(22), 'cheias'], [H(22), H(24), 'vazio']],
      domingo: [[0, H(24), 'vazio']],
    },
    verao: {
      util: [[0, H(7), 'vazio'], [H(7), H(9, 15), 'cheias'], [H(9, 15), H(12, 15), 'ponta'], [H(12, 15), H(24), 'cheias']],
      sabado: [[0, H(9), 'vazio'], [H(9), H(14), 'cheias'], [H(14), H(20), 'vazio'], [H(20), H(22), 'cheias'], [H(22), H(24), 'vazio']],
      domingo: [[0, H(24), 'vazio']],
    },
  },
};

/** Last Sunday of a month (local calendar date at midnight). */
function lastSunday(year, month /* 0-11 */) {
  const d = new Date(year, month + 1, 0); // last day of month
  d.setDate(d.getDate() - d.getDay());
  return d;
}
/** Portuguese legal summer time (hora legal de Verão): from the last Sunday of March to the last Sunday of October. Day granularity. */
export function isSummerTime(date) {
  const y = date.getFullYear();
  const t = new Date(y, date.getMonth(), date.getDate()).getTime();
  return t >= lastSunday(y, 2).getTime() && t < lastSunday(y, 9).getTime();
}
export function seasonOf(date) { return isSummerTime(date) ? 'verao' : 'inverno'; }
export function dayTypeOf(date) { const d = date.getDay(); return d === 0 ? 'domingo' : d === 6 ? 'sabado' : 'util'; }

/**
 * Tariff period of a quarter-hour. `minute` = minute of the day at which the interval STARTS (0..1439).
 * @returns {'ponta'|'cheias'|'vazio'} for option 3, {'foraVazio'|'vazio'} for option 2, 'simples' for option 1.
 */
export function periodPT(date, minute, { cycle = 'diario', option = 3 } = {}) {
  return periodFor({ season: seasonOf(date), dayType: dayTypeOf(date), minute, cycle, option });
}
/** Same as periodPT but from the abstract calendar attributes (used for legends/charts). */
export function periodFor({ season = 'inverno', dayType = 'util', minute = 0, cycle = 'diario', option = 3 }) {
  if (+option === 1) return 'simples';
  const table = SCHEDULES[cycle] || SCHEDULES.diario;
  const bySeason = table[season] || table.inverno;
  const ranges = bySeason.any || bySeason[dayType] || bySeason.util;
  const m = ((minute % 1440) + 1440) % 1440;
  let p = 'vazio';
  for (const [a, b, per] of ranges) if (m >= a && m < b) { p = per; break; }
  if (+option === 2) return p === 'vazio' ? 'vazio' : 'foraVazio';
  return p;
}

/* ------------------------------------------------------------------ parsing helpers */
const strip = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const num = (s) => {
  if (s === undefined || s === null || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  let t = String(s).trim().replace(/"/g, '').replace(/\s+/g, '').replace(/kwh?$|wh$/i, '');
  if (!t || /^-+$/.test(t)) return null;
  if (/,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const p2 = (n) => String(n).padStart(2, '0');
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function detectSeparator(lines) {
  const sample = lines.slice(0, 30).join('\n');
  const c = { ';': (sample.match(/;/g) || []).length, ',': (sample.match(/,/g) || []).length, '\t': (sample.match(/\t/g) || []).length };
  if (c['\t'] > 0 && c['\t'] >= c[';'] && c['\t'] >= c[',']) return '\t';
  if (c[';'] > 0 && c[';'] >= c[','] / 3) return ';';
  return ',';
}
function splitCsvLine(line, sep) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
/** CSV text -> rows of strings. */
export function csvToRows(text) {
  const raw = String(text).replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !/^#/.test(l));
  const sep = detectSeparator(lines);
  return lines.map((l) => splitCsvLine(l, sep));
}

/** Date cell -> { y, mo, d, min (minute of day or null), utc } */
function parseDateCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    const dt = new Date(EXCEL_EPOCH + Math.round(v * 86400000));
    const min = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), min: (v % 1) > 1e-9 ? min : null, utc: false };
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], min: m[4] !== undefined ? +m[4] * 60 + +m[5] : null, utc: /z/i.test(m[7] || '') || /^[+-]00:?00$/.test(m[7] || '') };
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (m) return { y: +m[3], mo: +m[2], d: +m[1], min: m[4] !== undefined ? +m[4] * 60 + +m[5] : null, utc: false };
  return null;
}
/**
 * Hour cell -> { min } (minute of day 0..1440) or { index } for 1..24 / 1..96 integer indexes.
 * `fractional` = the column holds Excel time fractions (0.0104 = 00:15), so integers 0/1 mean 00:00/24:00 instead of indexes.
 */
function parseHourCell(v, fractional = false) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (fractional && v >= 0 && v <= 1.0000001) return { min: Math.round(v * 1440) };
    if (!fractional && v > 0 && v < 1) return { min: Math.round(v * 1440) };
    if (Number.isInteger(v) && v >= 0 && v <= 96) return { index: v };
    if (v > 1 && v < 24) return { min: Math.round(v * 60) }; // 9.5 = 09:30
    return null;
  }
  const raw = String(v).trim();
  // interval "00:00-01:00" / "0-1" / "00h - 01h" / "de 00:00 a 01:00" (Endesa área de clientes, ES) -> the interval START
  let m = raw.match(/^(?:de\s+)?(\d{1,2})(?:[:h.](\d{2}))?\s*h?\s*(?:[-–—]|\ba\b|\bto\b)\s*(\d{1,2})(?:[:h.](\d{2}))?\s*h?$/i);
  if (m) return { min: +m[1] * 60 + (m[2] ? +m[2] : 0), range: true };
  const t = raw.replace(/h/i, ':');
  m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return { min: +m[1] * 60 + +m[2] };
  m = t.match(/^(\d{1,2}):$/);
  if (m) return { min: +m[1] * 60 };
  m = t.match(/^(\d{1,3})$/);
  if (m) return { index: +m[1] };
  return null;
}

const HEAD = {
  datetime: [/^data ?\/? ?hora/, /^date ?\/? ?time/, /^datetime/, /^timestamp/, /^fecha[ _-]?hora/, /^data e hora/, /^data[_ ]?hora/, /^hora e data/],
  date: [/^data$/, /^date$/, /^fecha$/, /^dia$/, /^data \(/, /^date \(/, /^data de leitura/, /^dia$/],
  hour: [/^hora$/, /^hour$/, /^time$/, /^hora legal/, /^hora \(/, /^periodo horario$/, /^intervalo$/, /^quarto/],
  consumption: [
    /consumo registado/, /consumo medido na ic/, /consumo fornecido a ic/, /consumo simulado/, /consumo \(kwh\)|consumo\(kwh\)/, /consumo \(kw\)/, /consumo_kwh/, /^consumo/,
    /energia ativa consumida|energia ativa \(kwh\)|^energia ativa/, /active energy(?! returned)/, /^energy wh$/, /^energia \(kwh\)|^energia$/, /^ae[ _-]?kwh$/, /^kwh$/, /\bkwh\b/, /^wh$/, /^consumption/, /^import/, /^total wh|^total_act/,
  ],
  injection: [/injec|injeç/, /returned/, /devolvid/, /exportad|^export/, /excedente/, /^as[ _-]?kwh$/, /vertid/, /producao|produção/],
  status: [/^estado$/, /^metodo/, /^tipo$/, /real ?\/ ?estim/, /^origem/, /^qualidade/, /^status$/],
};
const findCol = (headers, res, skip = new Set()) => { for (const re of res) { const i = headers.findIndex((h, j) => !skip.has(j) && re.test(h)); if (i >= 0) return i; } return -1; };

function detectHeader(rows) {
  const limit = Math.min(60, rows.length);
  for (let i = 0; i < limit; i++) {
    const r = rows[i]; if (!r) continue;
    const hs = r.map(strip);
    const texts = hs.filter(Boolean).length;
    if (texts < 2) continue;
    const dt = findCol(hs, HEAD.datetime), d = findCol(hs, HEAD.date), h = findCol(hs, HEAD.hour);
    const c = findCol(hs, HEAD.consumption, new Set([dt, d, h].filter((x) => x >= 0)));
    if ((dt >= 0 || (d >= 0 && h >= 0) || (d >= 0 && c >= 0)) && !hs.some((x) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(x) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/.test(x))) {
      return { idx: i, headers: hs, raw: r.map((x) => String(x ?? '').trim()), dt, d, h, c };
    }
  }
  return null;
}

/** Rows with a date column and ≥ 20 hour-like columns (e.g. "1".."24", "0h".."23h", "00:00".."23:00") -> long format rows, or null. */
function unpivotRows(rows) {
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const r = rows[i]; if (!r || r.length < 20) continue;
    const hs = r.map((c) => strip(c));
    const hourCols = hs.map((h, j) => ({ h, j })).filter(({ h }) => /^(h|hora ?)?\d{1,2}(h|:00|:15|:30|:45)?$/.test(h) || /^\d{1,2}[-–]\d{1,2}h?$/.test(h) || /^\d{1,2}:\d{2}[-–]\d{1,2}:\d{2}$/.test(h));
    if (hourCols.length < 20) continue;
    const dCol = hs.findIndex((h) => /^data|^date|^fecha|^dia/.test(h));
    if (dCol < 0) continue;
    const label = (h) => { const m = h.match(/^(?:h|hora ?)?(\d{1,2})(?::(\d{2}))?/); return { h: +m[1], mi: m[2] ? +m[2] : null }; };
    const labels = hourCols.map(({ h }) => label(h));
    const quarter = labels.some((l) => l.mi);
    const zeroBased = labels.some((l) => l.h === 0);
    const out = [['data', 'hora', 'consumo (kwh)']];
    for (let k = i + 1; k < rows.length; k++) {
      const row = rows[k]; if (!row) continue;
      const d = parseDateCell(row[dCol]); if (!d) continue;
      const dateTxt = `${d.y}-${p2(d.mo)}-${p2(d.d)}`;
      hourCols.forEach(({ j }, n) => {
        const v = num(row[j]); if (v === null) return;
        const l = labels[n];
        const hourTxt = quarter || l.mi !== null ? `${p2(l.h)}:${p2(l.mi || 0)}` : String(zeroBased ? l.h + 1 : l.h); // 1..24 = hour ending
        out.push([dateTxt, hourTxt, v]);
      });
    }
    if (out.length > 1) return { rows: out, note: 'Ficheiro com uma linha por dia e uma coluna por hora: convertido para o formato hora a hora.' };
  }
  return null;
}

/* ------------------------------------------------------------------ main parser */
/**
 * @param {string|any[][]} input  CSV text or worksheet rows (from xlsx-lite readXlsxRows().rows)
 * @param {object} [opts]  { source: 'e-redes.xlsx' (informative) }
 * @returns {ConsumptionPT}
 */
export function parseConsumptionPT(input, opts = {}) {
  let rows = typeof input === 'string' ? csvToRows(input) : (input || []);
  if (!rows.length) throw new Error('O ficheiro está vazio.');
  const warnings = [];
  // pivot layout (one row per day, one column per hour or per quarter-hour): flatten to [date, hour, value]
  const pv = unpivotRows(rows);
  if (pv) { rows = pv.rows; warnings.push(pv.note); }
  const hdr = detectHeader(rows);
  let cDate = -1, cHour = -1, cDT = -1, cVal = -1, cInj = -1, cSt = -1, start = 0, headers = [], format = 'genérico';
  if (hdr) {
    ({ d: cDate, h: cHour, dt: cDT, c: cVal } = hdr); headers = hdr.headers; start = hdr.idx + 1;
    const skip = new Set([cDate, cHour, cDT, cVal].filter((x) => x >= 0));
    cInj = findCol(headers, HEAD.injection, skip);
    cSt = findCol(headers, HEAD.status, new Set([...skip, cInj].filter((x) => x >= 0)));
    if (headers.some((x) => /leitura/.test(x)) && !headers.some((x) => /consumo|energia|kwh|\bwh\b/.test(x) && !/leitura/.test(x))) throw new Error('Este ficheiro contém LEITURAS do contador e não o diagrama de carga. No Balcão Digital da E-Redes escolha "Consumos" → "Consultar consumos detalhados" (não "Leituras") e exporte para Excel.');
    if (cVal < 0) { // first numeric-looking column that is not a date/hour/injection/status/money column
      const probe = rows.slice(start, start + 20);
      const money = /precio|preco|preço|coste|custo|cost\b|importe|€|eur\b|tarifa|iva\b/;
      cVal = headers.findIndex((x, j) => !skip.has(j) && j !== cInj && j !== cSt && !money.test(x) && probe.some((r) => num(r?.[j]) !== null));
      if (cVal < 0) cVal = headers.findIndex((x, j) => !skip.has(j) && j !== cInj && j !== cSt && probe.some((r) => num(r?.[j]) !== null));
    }
    if (headers.some((x) => /consumo registado|consumo medido na ic|consumo fornecido/.test(x))) format = 'E-Redes (diagrama de carga)';
    else if (headers.some((x) => /date\/time utc|active energy/.test(x))) format = 'Shelly / contador de energia';
    else if (headers.some((x) => /^cups$|consumo_kwh|ae_kwh/.test(x))) format = 'distribuidora (ES)';
    else if (cDT >= 0 || (cDate >= 0 && cHour >= 0)) format = 'genérico (data, hora, consumo)';
  } else {
    // no header: [date] [hour] value …
    const first = rows.find((r) => r && r.some((c) => parseDateCell(c)));
    if (!first) throw new Error('Não foi possível reconhecer o ficheiro: não encontrámos uma linha de cabeçalho com "Data", "Hora" e "Consumo" nem linhas com datas. Exporte o diagrama de carga a partir do Balcão Digital da E-Redes (Consumos → Consultar consumos detalhados → Exportar).');
    cDate = first.findIndex((c) => parseDateCell(c));
    const dc = parseDateCell(first[cDate]);
    if (dc.min === null) cHour = first.findIndex((c, j) => j !== cDate && parseHourCell(c, typeof c === 'number' && c > 0 && c < 1));
    else cDT = cDate, cDate = -1;
    cVal = first.findIndex((c, j) => j !== cDate && j !== cHour && j !== cDT && num(c) !== null && !(cHour < 0 && /^\d{1,2}$/.test(String(c).trim()) && j === cDate + 1));
    if (cVal < 0) cVal = first.findIndex((c, j) => j !== cDate && j !== cHour && j !== cDT && num(c) !== null);
    format = 'sem cabeçalho';
  }
  if ((cDate < 0 && cDT < 0) || cVal < 0) throw new Error(`Não foi possível identificar as colunas de data/hora e consumo (cabeçalho: ${headers.filter(Boolean).join(' | ') || 'nenhum'}).`);

  const vh = headers[cVal] || '';
  const unit = /\(kw\)|\bkw\b(?!h)/.test(vh) ? 'kW' : /kwh/.test(vh) ? 'kWh' : /\bwh\b|\(wh\)|_wh|energy wh/.test(vh) ? 'Wh' : null;
  const utcHeader = [headers[cDT], headers[cDate], headers[cHour]].some((x) => x && /utc|gmt/.test(x));

  // ---- read records
  const hourFrac = cHour >= 0 && rows.some((r, i) => i >= start && typeof r?.[cHour] === 'number' && r[cHour] > 0 && r[cHour] < 1); // Excel time cells
  const recs = []; let bad = 0, exportRaw = 0, hasZeroTime = false, has24 = false, indexMax = 0, sawIndex = false, sawMin = false;
  for (let i = start; i < rows.length; i++) {
    const r = rows[i]; if (!r || r.length < 2) continue;
    const dc = parseDateCell(cDT >= 0 ? r[cDT] : r[cDate]);
    if (!dc) { if (num(r[cVal]) !== null && r[cDT >= 0 ? cDT : cDate] && !r.some((c) => /^total\b/i.test(String(c ?? '').trim()))) bad++; continue; } // titles / totals / blank rows are not errors
    let min = dc.min, index = null;
    if (cHour >= 0) {
      const hc = parseHourCell(r[cHour], hourFrac);
      if (!hc) { bad++; continue; }
      if (hc.min !== undefined) { min = hc.min; sawMin = true; } else { index = hc.index; sawIndex = true; indexMax = Math.max(indexMax, index); }
    }
    if (min === null && index === null) { bad++; continue; }
    const v = num(r[cVal]);
    if (v === null) { bad++; continue; }
    const stRaw = cSt >= 0 ? strip(r[cSt]) : '';
    const est = stRaw ? /^estim|^e$|^prov/.test(stRaw) : false;
    if (cInj >= 0) exportRaw += num(r[cInj]) || 0;
    if (min === 0) hasZeroTime = true;
    if (min === 1440) has24 = true;
    recs.push({ y: dc.y, mo: dc.mo, d: dc.d, min, index, v, est, utc: dc.utc || utcHeader });
  }
  if (!recs.length) {
    if (cHour < 0 && rows.slice(start).some((r) => r && parseDateCell(cDT >= 0 ? r[cDT] : r[cDate]) && num(r[cVal]) !== null)) throw new Error('O ficheiro tem um registo a cada dia (só data, sem hora) – é necessário o detalhe por hora ou por 15 minutos (diagrama de carga) para separar vazio / cheias / ponta.');
    throw new Error('Não foi encontrada nenhuma linha de consumo válida no ficheiro.');
  }
  if (bad) warnings.push(`${bad} linha(s) não interpretadas foram ignoradas.`);

  // ---- resolve indexes / step / convention
  let step; // minutes
  if (sawIndex && !sawMin) {
    const zeroBased = recs.some((x) => x.index === 0);
    step = indexMax > 48 ? 15 : indexMax > 25 ? 30 : 60;
    for (const x of recs) x.min = (x.index - (zeroBased ? 0 : 1)) * step; // 1..24 = hour ENDING -> start = (i-1)h
  } else {
    // most frequent positive delta between consecutive rows of the same day
    const deltas = new Map();
    for (let i = 1; i < Math.min(recs.length, 800); i++) {
      const a = recs[i - 1], b = recs[i];
      if (a.y === b.y && a.mo === b.mo && a.d === b.d && b.min > a.min) deltas.set(b.min - a.min, (deltas.get(b.min - a.min) || 0) + 1);
    }
    step = [...deltas.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] || 15;
    if (step > 60) throw new Error(`O ficheiro tem um registo a cada ${step >= 1440 ? 'dia' : step + ' minutos'} – é necessário o detalhe por hora ou por 15 minutos (diagrama de carga) para separar vazio / cheias / ponta.`);
    if (![1, 5, 10, 15, 20, 30, 60].includes(step)) step = step < 15 ? 5 : step < 30 ? 15 : step < 60 ? 30 : 60;
  }
  // End-of-interval convention: E-Redes (kW quarters, first time 00:15, includes 00:00 rows) or explicit 24:00 / 1..24 indexes
  const first = recs[0];
  const endConv = sawIndex && !sawMin ? false : (has24 || (unit === 'kW' && step < 60) || (step < 60 && first.min === step && !recs.slice(0, Math.min(recs.length, step ? 1440 / step : 96)).some((x) => x.min === 0 && x.y === first.y && x.mo === first.mo && x.d === first.d) && hasZeroTime));
  if (unit === 'kW') warnings.push(`Valores em kW (potência média de ${step} min) convertidos em energia: kWh = kW × ${step}/60.`);
  if (endConv) warnings.push('A hora de cada registo é o fim do intervalo (00:15 = 00:00–00:15).');

  // ---- to local quarter-hours
  const factor = unit === 'kW' ? step / 60 : unit === 'Wh' ? 1 / 1000 : 1;
  let autoWh = false;
  if (!unit) { const mean = recs.reduce((a, x) => a + x.v, 0) / recs.length; if (mean * (60 / step) > 60) autoWh = true; }
  if (autoWh) warnings.push('Os valores pareciam estar em Wh (média superior a 60 por hora): convertidos em kWh.');
  const quarters = new Map(); // 'YYYY-MM-DD|min' -> {day, min, kwh, est, n}
  const dayCache = new Map();
  const toLocal = (x) => {
    // absolute minutes (local wall clock) of the interval START
    let ms = Date.UTC(x.y, x.mo - 1, x.d) + x.min * 60000; // treat wall-clock as UTC-based arithmetic (no TZ)
    if (endConv) ms -= step * 60000;
    if (x.utc) { const dt = new Date(ms); const local = new Date(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); if (isSummerTime(local)) ms += 3600000; }
    return ms;
  };
  let maxKw = null, maxAt = null;
  for (const x of recs) {
    const kwh = x.v * factor * (autoWh ? 1 / 1000 : 1);
    if (unit === 'kW' && (maxKw === null || x.v > maxKw)) { maxKw = x.v; maxAt = x; }
    const startMs = toLocal(x);
    const n = step >= 15 ? step / 15 : 1;
    for (let k = 0; k < n; k++) {
      const ms = startMs + k * 15 * 60000;
      const dt = new Date(ms);
      const day = `${dt.getUTCFullYear()}-${p2(dt.getUTCMonth() + 1)}-${p2(dt.getUTCDate())}`;
      const min = Math.floor((dt.getUTCHours() * 60 + dt.getUTCMinutes()) / 15) * 15;
      const key = `${day}|${min}`;
      const b = quarters.get(key) || { day, min, kwh: 0, est: false, n: 0 };
      b.kwh += kwh / n; b.est = b.est || x.est; b.n++;
      quarters.set(key, b);
    }
  }
  const qs = [...quarters.values()].sort((a, b) => a.day.localeCompare(b.day) || a.min - b.min);
  const meta = { format: opts.source ? `${format} · ${opts.source}` : format, unit: unit || (autoWh ? 'Wh' : 'kWh'), step, warnings, exportKwh: cInj >= 0 ? Math.round(exportRaw * factor * 1000) / 1000 : 0, hasInjection: cInj >= 0, endConv, utc: recs.some((x) => x.utc) };
  if (meta.exportKwh > 0) warnings.push(`O ficheiro inclui ${meta.exportKwh.toFixed(1)} kWh injetados na rede (autoconsumo) – não entram na comparação.`);
  if (maxKw !== null) meta.maxPower = { kw: maxKw, date: `${maxAt.y}-${p2(maxAt.mo)}-${p2(maxAt.d)}`, time: `${p2(Math.floor(((maxAt.min - (endConv ? step : 0) + 1440) % 1440) / 60))}:${p2(((maxAt.min - (endConv ? step : 0) + 1440) % 1440) % 60)}`, basis: `média ${step} min` };
  else if (step <= 15) { const q = qs.reduce((m, x) => (x.kwh > (m?.kwh ?? -1) ? x : m), null); if (q) meta.maxPower = { kw: Math.round(q.kwh * 4 * 1000) / 1000, date: q.day, time: `${p2(Math.floor(q.min / 60))}:${p2(q.min % 60)}`, basis: 'média 15 min' }; }
  return summarise(qs, meta);
}

/* ------------------------------------------------------------------ aggregation */
function summarise(qs, meta) {
  const dates = new Map(); // day -> { d, season, dayType } (computed once per day: yearly files have 35k rows)
  const dateOf = (day) => { let e = dates.get(day); if (!e) { const [y, m, dd] = day.split('-').map(Number); const d = new Date(y, m - 1, dd); e = { d, season: seasonOf(d), dayType: dayTypeOf(d) }; dates.set(day, e); } return e; };
  const split = { diario: { 2: { foraVazio: 0, vazio: 0 }, 3: { ponta: 0, cheias: 0, vazio: 0 } }, semanal: { 2: { foraVazio: 0, vazio: 0 }, 3: { ponta: 0, cheias: 0, vazio: 0 } } };
  const hoursMap = new Map();
  const prof = { util: Array(24).fill(0), sabado: Array(24).fill(0), domingo: Array(24).fill(0) };
  const profQ = { util: Array(96).fill(0), sabado: Array(96).fill(0), domingo: Array(96).fill(0) };
  const dayKind = new Map(); const seasonDays = { inverno: 0, verao: 0 };
  let total = 0, estKwh = 0;
  for (const q of qs) {
    const { season, dayType } = dateOf(q.day);
    total += q.kwh; if (q.est) estKwh += q.kwh;
    for (const cycle of ['diario', 'semanal']) {
      const p3 = periodFor({ season, dayType, minute: q.min, cycle, option: 3 });
      split[cycle][3][p3] += q.kwh;
      split[cycle][2][p3 === 'vazio' ? 'vazio' : 'foraVazio'] += q.kwh;
    }
    const h = Math.floor(q.min / 60);
    const hk = `${q.day}|${h}`;
    const hb = hoursMap.get(hk) || { date: q.day, hour: h, kwh: 0, estimated: false };
    hb.kwh += q.kwh; hb.estimated = hb.estimated || q.est; hoursMap.set(hk, hb);
    if (!dayKind.has(q.day)) { dayKind.set(q.day, dayType); seasonDays[season]++; }
    prof[dayKind.get(q.day)][h] += q.kwh;
    profQ[dayKind.get(q.day)][q.min / 15] += q.kwh;
  }
  const days = [...dayKind.keys()].sort();
  const counts = { util: 0, sabado: 0, domingo: 0 };
  for (const k of days) counts[dayKind.get(k)]++;
  for (const k of Object.keys(prof)) if (counts[k]) { prof[k] = prof[k].map((v) => v / counts[k]); profQ[k] = profQ[k].map((v) => v / counts[k]); }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const share = {};
  for (const cycle of ['diario', 'semanal']) {
    share[cycle] = {};
    for (const opt of [2, 3]) {
      share[cycle][opt] = {};
      for (const k of Object.keys(split[cycle][opt])) { share[cycle][opt][k] = total ? split[cycle][opt][k] / total : 0; split[cycle][opt][k] = r3(split[cycle][opt][k]); }
    }
  }
  const hours = [...hoursMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour).map((x) => ({ ...x, kwh: r3(x.kwh) }));
  const missing = days.length * 96 - qs.length;
  const warnings = [...meta.warnings];
  if (missing > 96) warnings.push(`Faltam ${missing} quartos de hora no ficheiro (dias incompletos).`);
  if (estKwh > 0) warnings.push(`${Math.round(100 * estKwh / total)} % do consumo provém de valores estimados.`);
  return {
    quarters: qs, hours, days: days.length, dayCounts: counts, start: days[0], end: days[days.length - 1],
    totalKwh: r3(total), split, share, profile: prof, profileQ: profQ, seasonDays, season: seasonDays.verao > seasonDays.inverno ? 'verao' : 'inverno', estimatedShare: total ? estKwh / total : 0,
    format: meta.format, unit: meta.unit, step: meta.step, exportKwh: meta.exportKwh, maxPower: meta.maxPower || null, endConv: meta.endConv, utc: meta.utc,
    missingQuarters: missing, warnings,
  };
}

/** Restrict the curve to a date range (ISO strings; end inclusive unless endExclusive). */
export function sliceCurvePT(curve, startISO, endISO, { endExclusive = false } = {}) {
  if (!curve) return null;
  const qs = curve.quarters.filter((q) => (!startISO || q.day >= startISO) && (!endISO || (endExclusive ? q.day < endISO : q.day <= endISO)));
  if (!qs.length) return null;
  const out = summarise(qs, { format: curve.format, unit: curve.unit, step: curve.step, warnings: curve.warnings.filter((w) => !/^Faltam|estimados/.test(w)), exportKwh: 0, endConv: curve.endConv, utc: curve.utc, maxPower: curve.maxPower && curve.maxPower.date >= (startISO || '') && (endExclusive ? curve.maxPower.date < (endISO || '9') : curve.maxPower.date <= (endISO || '9')) ? curve.maxPower : null });
  return out;
}

/** kWh per period of an option (array in the order of simulator PERIOD_KEYS: [simples] / [foraVazio, vazio] / [ponta, cheias, vazio]). */
export function kwhForOption(curve, cycle, option, totalOverride = null) {
  const opt = +option || 1;
  if (opt === 1) return [totalOverride ?? curve.totalKwh];
  const keys = opt === 2 ? BI_PERIODS : TRI_PERIODS;
  if (totalOverride !== null && totalOverride !== undefined && curve.totalKwh > 0) return keys.map((k) => Math.round(totalOverride * curve.share[cycle][opt][k] * 1000) / 1000);
  return keys.map((k) => curve.split[cycle][opt][k]);
}
export function shareForOption(curve, cycle, option) {
  const opt = +option || 1;
  if (opt === 1) return [1];
  return (opt === 2 ? BI_PERIODS : TRI_PERIODS).map((k) => curve.share[cycle][opt][k]);
}

/**
 * "What if I move consumption to vazio": returns the kWh array (PERIOD_KEYS order) after moving `fraction`
 * of the fora-de-vazio (option 2) or ponta+cheias (option 3) energy into vazio. Option 1 is unchanged.
 */
export function shiftToVazio(kwh, option, fraction) {
  const f = Math.max(0, Math.min(1, fraction || 0));
  const a = (kwh || []).map((v) => Number(v) || 0);
  if (+option === 2 && a.length >= 2) { const mv = a[0] * f; return [a[0] - mv, a[1] + mv]; }
  if (+option === 3 && a.length >= 3) { const mp = a[0] * f, mc = a[1] * f; return [a[0] - mp, a[1] - mc, a[2] + mp + mc]; }
  return a;
}

/** Human-readable schedule of a cycle (for legends/tooltips). */
export function scheduleText(cycle) {
  if (cycle === 'semanal') return 'Ciclo semanal – dias úteis: vazio 00–07 h; Inverno ponta 09:30–12:00 e 18:30–21:00, Verão ponta 09:15–12:15, restante cheias · sábado: Inverno cheias 09:30–13:00 e 18:30–22:00, Verão cheias 09:00–14:00 e 20:00–22:00, restante vazio · domingo: vazio todo o dia. Bi-horário: fora de vazio = ponta + cheias.';
  return 'Ciclo diário (todos os dias): vazio 22–08 h · Inverno ponta 09:00–10:30 e 18:00–20:30, Verão ponta 10:30–13:00 e 19:30–21:00 · restante cheias. Bi-horário: fora de vazio 08–22 h.';
}
export const CALENDAR_TEXT_PT = `${scheduleText('diario')} ${scheduleText('semanal')} Horários da ERSE para Portugal Continental (hora legal).`;
