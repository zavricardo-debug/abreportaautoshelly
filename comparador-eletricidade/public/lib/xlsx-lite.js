// Minimal, dependency-free reader for .xlsx workbooks (Office Open XML): enough to read the
// consumption exports of E-Redes (PT), Datadis / distributors (ES) or a sheet saved from Excel.
//
//   readXlsxRows(arrayBuffer)  -> { rows: any[][], sheet: string, sheets: string[] }
//   sheetRowsToCsv(rows)       -> string  (";"-separated text; serial dates/times rendered as text)
//   isZip(buf) / isOle(buf)    -> quick signature checks (.xlsx is a zip; legacy .xls is an OLE file)
//
// Everything runs in the browser (and in Node for the tests): a small inflate (RFC 1951) decoder,
// a ZIP central-directory walker and regex-based parsing of sharedStrings.xml / sheetN.xml.
// Only the first worksheet is returned. Cell values: numbers stay numbers (dates are Excel serial
// numbers, times are fractions of a day), strings are decoded, booleans become 0/1.

/* ------------------------------------------------------------------ signatures */
export function isZip(buf) { const b = new Uint8Array(buf, 0, 4); return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07); }
export function isOle(buf) { const b = new Uint8Array(buf, 0, 8); return b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1; }

/* ------------------------------------------------------------------ inflate (RFC 1951) */
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function buildHuffman(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(17);
  for (let i = 1; i < 16; i++) offs[i + 1] = offs[i] + count[i];
  const symbol = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const lit = new Array(288);
  for (let i = 0; i < 144; i++) lit[i] = 8;
  for (let i = 144; i < 256; i++) lit[i] = 9;
  for (let i = 256; i < 280; i++) lit[i] = 7;
  for (let i = 280; i < 288; i++) lit[i] = 8;
  FIXED = { lit: buildHuffman(lit), dist: buildHuffman(new Array(30).fill(5)) };
  return FIXED;
}

/** Decompress a raw DEFLATE stream. `hint` = expected output size (from the ZIP directory). */
export function inflateRaw(src, hint = 0) {
  let pos = 0, bitBuf = 0, bitCnt = 0;
  let out = new Uint8Array(hint > 0 ? hint + 16 : Math.max(4096, src.length * 4));
  let outLen = 0;
  const grow = (need) => {
    if (outLen + need <= out.length) return;
    let n = out.length * 2; while (n < outLen + need) n *= 2;
    const o = new Uint8Array(n); o.set(out.subarray(0, outLen)); out = o;
  };
  const bits = (n) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: fim inesperado dos dados');
      bitBuf |= src[pos++] << bitCnt; bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n; bitCnt -= n;
    return v;
  };
  const decode = (h) => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new Error('inflate: código Huffman inválido');
  };
  const inflateBlock = (lit, dist) => {
    for (;;) {
      const sym = decode(lit);
      if (sym < 256) { grow(1); out[outLen++] = sym; continue; }
      if (sym === 256) return;
      const li = sym - 257;
      if (li >= 29) throw new Error('inflate: símbolo de comprimento inválido');
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist);
      if (di >= 30) throw new Error('inflate: símbolo de distância inválido');
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (d > outLen) throw new Error('inflate: distância fora do buffer');
      grow(len);
      let from = outLen - d;
      for (let i = 0; i < len; i++) out[outLen++] = out[from++];
    }
  };
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0; // discard the padding bits up to the byte boundary
      if (pos + 4 > src.length) throw new Error('inflate: bloco armazenado truncado');
      const len = src[pos] | (src[pos + 1] << 8); pos += 4;
      if (pos + len > src.length) throw new Error('inflate: bloco armazenado truncado');
      grow(len); out.set(src.subarray(pos, pos + len), outLen); outLen += len; pos += len;
    } else if (type === 1) {
      const f = fixedTables(); inflateBlock(f.lit, f.dist);
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = buildHuffman(cl);
      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const sym = decode(clh);
        if (sym < 16) lengths.push(sym);
        else if (sym === 16) { if (!lengths.length) throw new Error('inflate: repetição sem comprimento anterior'); const prev = lengths[lengths.length - 1]; for (let r = 3 + bits(2); r > 0; r--) lengths.push(prev); }
        else if (sym === 17) { for (let r = 3 + bits(3); r > 0; r--) lengths.push(0); }
        else { for (let r = 11 + bits(7); r > 0; r--) lengths.push(0); }
      }
      inflateBlock(buildHuffman(lengths.slice(0, hlit)), buildHuffman(lengths.slice(hlit, hlit + hdist)));
    } else throw new Error('inflate: tipo de bloco inválido');
  } while (!last);
  return out.subarray(0, outLen);
}

/* ------------------------------------------------------------------ ZIP */
/** List the entries of a ZIP archive from its central directory: name -> { method, csize, usize, offset }. */
export function zipEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65536); i--) {
    if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x05 && u8[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ficheiro ZIP/XLSX inválido (diretório central em falta)');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder('utf-8');
  for (let i = 0; i < total && p + 46 <= u8.length; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    entries.set(name, { method, csize, usize, offset });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

/** Extract one entry as Uint8Array. */
export function zipRead(buf, entry) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) throw new Error('entrada ZIP corrompida');
  const nlen = dv.getUint16(entry.offset + 26, true), xlen = dv.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nlen + xlen;
  const data = u8.subarray(start, start + entry.csize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data, entry.usize);
  throw new Error(`método de compressão ZIP não suportado (${entry.method})`);
}

/* ------------------------------------------------------------------ XML helpers */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}
const attr = (s, name) => { const m = s.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? m[1] : null; };
const textOf = (xml) => { let t = ''; const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g; let m; while ((m = re.exec(xml))) t += m[1] ?? ''; return decodeXml(t); };
export function colIndex(ref) { let n = 0; for (const ch of ref) { const c = ch.charCodeAt(0); if (c >= 65 && c <= 90) n = n * 26 + (c - 64); else if (c >= 97 && c <= 122) n = n * 26 + (c - 96); else break; } return n - 1; }

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g; let m;
  while ((m = re.exec(xml))) out.push(m[1] ? textOf(m[1]) : '');
  return out;
}

function parseSheet(xml, sst) {
  const rows = [];
  const rowRe = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = attr(rm[1], 'r');
    const rowIdx = rAttr ? +rAttr - 1 : rows.length;
    const cells = [];
    let cm, col = 0;
    cellRe.lastIndex = 0;
    const body = rm[2] || '';
    while ((cm = cellRe.exec(body))) {
      const a = cm[1], inner = cm[2] || '';
      const ref = attr(a, 'r'); if (ref) col = colIndex(ref);
      const t = attr(a, 't');
      let v = null;
      if (t === 'inlineStr') v = textOf(inner);
      else {
        const vm = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (vm) {
          const raw = decodeXml(vm[1]);
          if (t === 's') v = sst[+raw] ?? '';
          else if (t === 'str' || t === 'd' || t === 'e') v = raw;
          else if (t === 'b') v = raw === '1' ? 1 : 0;
          else { const n = Number(raw); v = Number.isFinite(n) ? n : raw; }
        }
      }
      cells[col] = v;
      col++;
    }
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = cells.length ? Array.from(cells, (c) => (c === undefined ? null : c)) : [];
  }
  return rows;
}

/**
 * Read the first worksheet of an .xlsx file.
 * @param {ArrayBuffer} buf
 * @returns {{ rows: any[][], sheet: string, sheets: string[] }}
 */
export function readXlsxRows(buf, { sheetIndex = 0 } = {}) {
  if (sheetIndex === 'all') { // every worksheet: [{ name, rows }]
    const first = readXlsxRows(buf, { sheetIndex: 0 });
    const out = [{ name: first.sheet, rows: first.rows }];
    for (let i = 1; i < first.sheets.length; i++) { try { const r = readXlsxRows(buf, { sheetIndex: i }); out.push({ name: r.sheet, rows: r.rows }); } catch { /* ignore */ } }
    return { rows: first.rows, sheet: first.sheet, sheets: first.sheets, all: out };
  }
  if (isOle(buf)) throw new Error('formato Excel 97-2003 (.xls) – use readXlsRows() de xls-lite.js');
  if (!isZip(buf)) throw new Error('o ficheiro não é um .xlsx válido (não é um pacote ZIP)');
  const entries = zipEntries(buf);
  const text = (name) => { const e = entries.get(name); return e ? new TextDecoder('utf-8').decode(zipRead(buf, e)) : null; };
  const wb = text('xl/workbook.xml');
  if (!wb) {
    if (entries.has('content.xml')) { // OpenDocument spreadsheet (.ods) – LibreOffice
      const all = odsToSheets(text('content.xml'));
      if (!all.length) throw new Error('a folha OpenDocument (.ods) não tem tabelas com dados');
      if (sheetIndex === 'all') return { rows: all[0].rows, sheet: all[0].name, sheets: all.map((x) => x.name), all };
      const sh = all[sheetIndex] || all[0];
      return { rows: sh.rows, sheet: sh.name, sheets: all.map((x) => x.name) };
    }
    throw new Error('xl/workbook.xml em falta – o ficheiro não é um livro Excel (.xlsx)');
  }
  const rels = text('xl/_rels/workbook.xml.rels') || '';
  const relMap = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) { const id = attr(m[1], 'Id'), target = attr(m[1], 'Target'); if (id && target) relMap.set(id, target); }
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attr(m[1], 'name') || `Sheet${sheets.length + 1}`);
    const rid = attr(m[1], 'r:id') || attr(m[1], 'id');
    let target = rid ? relMap.get(rid) : null;
    if (target) target = target.replace(/^\/?(xl\/)?/, 'xl/');
    sheets.push({ name, target });
  }
  const sheet = sheets[sheetIndex] || sheets[0];
  const candidates = sheetIndex > 0 && sheet?.target ? [sheet.target] : [sheet?.target, `xl/worksheets/sheet${sheetIndex + 1}.xml`, ...[...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()];
  const path = candidates.find((c) => c && entries.has(c));
  if (!path) throw new Error('nenhuma folha de cálculo encontrada no ficheiro');
  const sst = parseSharedStrings(text('xl/sharedStrings.xml') || '');
  const rows = parseSheet(text(path), sst);
  return { rows, sheet: sheet?.name || path, sheets: sheets.map((s) => s.name) };
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/* ------------------------------------------------------------------ OpenDocument (.ods) */
/** content.xml of an .ods file -> [{ name, rows }] (dates as Excel serials, times as day fractions, numbers, strings). */
export function odsToSheets(xml) {
  const out = [];
  if (!xml) return out;
  const tableRe = /<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g; let tm;
  while ((tm = tableRe.exec(xml))) {
    const name = decodeXml(attr(tm[1], 'table:name') || `Folha${out.length + 1}`);
    const rows = [];
    const rowRe = /<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g; let rm;
    while ((rm = rowRe.exec(tm[2]))) {
      const rep = Math.min(+(attr(rm[1], 'table:number-rows-repeated') || 1), 1000);
      const cells = [];
      const cellRe = /<table:(covered-table-cell|table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:\1>)/g; let cm;
      while ((cm = cellRe.exec(rm[2] || ''))) {
        const a = cm[2], inner = cm[3] || '';
        const n = +(attr(a, 'table:number-columns-repeated') || 1);
        const type = attr(a, 'office:value-type');
        let v = null;
        if (type === 'float' || type === 'percentage' || type === 'currency') v = Number(attr(a, 'office:value'));
        else if (type === 'boolean') v = attr(a, 'office:boolean-value') === 'true' ? 1 : 0;
        else if (type === 'date') { const d = attr(a, 'office:date-value') || ''; const m = d.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/); if (m) v = (Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - EXCEL_EPOCH) / 86400000; }
        else if (type === 'time') { const t = attr(a, 'office:time-value') || ''; const m = t.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/); if (m) v = ((+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0))) / 86400; }
        else if (type === 'string' || inner) { const ps = [...inner.matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((m) => decodeXml(m[1].replace(/<text:s\b[^>]*\/>/g, ' ').replace(/<[^>]+>/g, ''))); v = ps.join(' ').trim() || null; }
        if (v === null && n > 64) { cells.length += Math.min(n, 1); continue; } // long empty runs (trailing 1000+ empty cells)
        for (let k = 0; k < Math.min(n, 256); k++) cells.push(v);
      }
      while (cells.length && (cells[cells.length - 1] === null || cells[cells.length - 1] === undefined)) cells.pop();
      const isEmpty = !cells.length;
      for (let k = 0; k < (isEmpty ? Math.min(rep, 1) : rep); k++) rows.push(Array.from(cells, (c) => (c === undefined ? null : c)));
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    if (rows.length) out.push({ name, rows });
  }
  return out;
}

/* ------------------------------------------------------------------ Excel serial dates */
/** Excel serial number -> { y, mo, d, h, mi } (UTC parts; Excel serials have no timezone). */
export function serialToDate(n) {
  const ms = Math.round(n * 86400000);
  const dt = new Date(EXCEL_EPOCH + ms);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes() };
}
const p2 = (n) => String(n).padStart(2, '0');
/**
 * Render a numeric cell as text the CSV parsers understand, guided by the column header.
 * `timeCol` = the column holds Excel time fractions (so 0 → 00:00 and 1 → 24:00 instead of hour indexes).
 */
export function cellToText(v, header = '', timeCol = false) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'number') return String(v);
  const h = String(header).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const isDateCol = /fecha|data|date|dia\b/.test(h) && !/hora|hour/.test(h.replace(/fecha[ _-]?hora|data[ _-]?hora/, ''));
  const isDateTimeCol = /fecha[ _-]?hora|data[ _-]?hora|datetime|timestamp/.test(h);
  const isHourCol = /^hora|^hour|^time|periodo horario/.test(h);
  if ((isDateCol || isDateTimeCol) && v > 20000 && v < 80000) {
    const d = serialToDate(v);
    const frac = v - Math.floor(v);
    return isDateTimeCol || frac > 1e-6 ? `${d.y}-${p2(d.mo)}-${p2(d.d)} ${p2(d.h)}:${p2(d.mi)}` : `${d.y}-${p2(d.mo)}-${p2(d.d)}`;
  }
  if ((isHourCol || timeCol) && v >= 0 && v <= 1.0000001 && (timeCol || !Number.isInteger(v))) { const mins = Math.round(v * 1440); return `${p2(Math.floor(mins / 60))}:${p2(mins % 60)}`; }
  return String(v);
}

/** Convert sheet rows to a ";"-separated CSV text (header-aware rendering of dates/times). */
export function sheetRowsToCsv(rows, { headerRow = null } = {}) {
  // header = first row (within 60) with ≥ 2 column names that look like date / hour / consumption headers; metadata rows such as
  // "CUPS: | ES00…" or "Fecha inicio: | 18/04/2026" (Endesa área de clientes) are skipped. Fallback: first row with ≥ 2 texts.
  const KEY = /fecha|data|date|\bdia\b|hora|hour|time|consumo|kwh|\bwh\b|energ|cups|periodo|metodo|obtencion|estado|potencia/;
  const looksHeader = (r) => r && !r.some((c) => typeof c === 'number' && c > 20000 && c < 80000) && r.filter((c) => typeof c === 'string' && KEY.test(c.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()) && !/\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(c)).length >= 2;
  const firstTexts = rows.findIndex((r) => r && r.filter((c) => typeof c === 'string' && c.trim()).length >= 2);
  const keyed = rows.slice(0, 60).findIndex(looksHeader);
  const hIdx = headerRow ?? (keyed >= 0 ? keyed : firstTexts);
  const headers = hIdx >= 0 ? rows[hIdx].map((c) => (c === null || c === undefined ? '' : String(c))) : [];
  // columns made of Excel time fractions (0 < v < 1) – e.g. "Hora" 00:15 … 23:45 – so their 0 / 1 values are 00:00 / 24:00
  const timeCols = new Set();
  headers.forEach((hd, j) => {
    const h = String(hd).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (!/^hora|^hour|^time|periodo horario|intervalo/.test(h)) return; // only hour-like columns (kWh values 0.5 are not times)
    if (rows.some((r, i) => i !== hIdx && typeof r?.[j] === 'number' && r[j] > 0 && r[j] < 1 && !Number.isInteger(r[j] * 24) )) timeCols.add(j);
    else if (rows.some((r, i) => i !== hIdx && typeof r?.[j] === 'number' && r[j] > 0 && r[j] < 1)) timeCols.add(j);
  });
  const lines = [];
  rows.forEach((r, i) => {
    if (!r || !r.length || r.every((c) => c === null || c === undefined || c === '')) return;
    lines.push(r.map((c, j) => (i === hIdx ? String(c ?? '') : cellToText(c, headers[j], timeCols.has(j))).replace(/;/g, ',').replace(/\r?\n/g, ' ')).join(';'));
  });
  return lines.join('\n');
}
