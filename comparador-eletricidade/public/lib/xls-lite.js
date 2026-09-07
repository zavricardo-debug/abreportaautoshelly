// Minimal, dependency-free reader for legacy Excel 97-2003 workbooks (.xls = BIFF8 records inside an
// OLE2 compound file; BIFF5/7 from Excel 5/95 is read too) and for the "fake" .xls files that many web
// portals export – an HTML table or a SpreadsheetML 2003 XML document with an .xls extension.
//
//   readXlsRows(arrayBuffer)  -> { rows: any[][], sheet: string, sheets: string[] }   (OLE2 / BIFF)
//   tableTextToRows(text)     -> any[][] | null                                         (HTML / XML tables)
//
// Same conventions as xlsx-lite.js: numbers stay numbers (dates are Excel serial numbers, times are
// fractions of a day), strings are decoded, booleans become 0/1; only the first worksheet is returned.
// Everything runs in the browser (and in Node for the tests).

/* ------------------------------------------------------------------ OLE2 compound file */
const ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;

/** Parse the OLE2 container: directory entries + a reader for any stream (regular FAT or mini stream). */
function oleStreams(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const secSize = 1 << dv.getUint16(30, true), miniSize = 1 << dv.getUint16(32, true);
  const nFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true) || 4096;
  const miniFatStart = dv.getUint32(60, true), nMiniFat = dv.getUint32(64, true);
  let difat = dv.getUint32(68, true); const nDifat = dv.getUint32(72, true);
  const secOff = (s) => (s + 1) * secSize;
  const maxSect = Math.max(0, Math.floor((buf.byteLength - secSize) / secSize));
  const perSec = secSize / 4;
  // FAT sector list: first 109 entries live in the header, the rest in DIFAT sectors
  const fatSects = [];
  for (let i = 0; i < 109 && fatSects.length < nFat; i++) { const s = dv.getUint32(76 + i * 4, true); if (s < maxSect) fatSects.push(s); }
  for (let n = 0; n < nDifat && difat < maxSect && fatSects.length < nFat; n++) {
    const base = secOff(difat);
    for (let i = 0; i < perSec - 1 && fatSects.length < nFat; i++) { const s = dv.getUint32(base + i * 4, true); if (s < maxSect) fatSects.push(s); }
    difat = dv.getUint32(base + (perSec - 1) * 4, true);
  }
  const fat = new Uint32Array(fatSects.length * perSec);
  fatSects.forEach((s, i) => { const base = secOff(s); for (let j = 0; j < perSec && base + j * 4 + 4 <= buf.byteLength; j++) fat[i * perSec + j] = dv.getUint32(base + j * 4, true); });
  const chain = (start, table) => {
    const out = []; const seen = new Set(); let s = start;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < table.length && !seen.has(s)) { out.push(s); seen.add(s); s = table[s]; }
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat);
    const out = new Uint8Array(size ?? secs.length * secSize); let p = 0;
    for (const s of secs) { const off = secOff(s); if (off >= u8.length || p >= out.length) break; const n = Math.min(secSize, out.length - p, u8.length - off); out.set(u8.subarray(off, off + n), p); p += n; }
    return out;
  };
  // directory entries (128 bytes each)
  const dir = readChain(dirStart);
  const entries = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const d = new DataView(dir.buffer, dir.byteOffset + off, 128);
    const type = d.getUint8(66); if (!type) continue;
    const nameLen = Math.min(d.getUint16(64, true), 64);
    let name = ''; for (let i = 0; i + 1 < nameLen; i += 2) { const c = d.getUint16(i, true); if (c) name += String.fromCharCode(c); }
    entries.push({ name, type, start: d.getUint32(116, true), size: d.getUint32(120, true) });
  }
  const root = entries.find((e) => e.type === 5) || entries[0];
  let mini = null, miniFat = null;
  const readStream = (e) => {
    if (e === root || e.size >= miniCutoff) return readChain(e.start, e.size);
    if (!mini) { // small streams live in the mini stream (root entry), addressed by the mini FAT
      mini = readChain(root.start, root.size);
      const mf = readChain(miniFatStart, nMiniFat * secSize);
      miniFat = new Uint32Array(mf.buffer, 0, Math.floor(mf.length / 4));
    }
    const out = new Uint8Array(e.size); let p = 0;
    for (const s of chain(e.start, miniFat)) { const off = s * miniSize; if (off >= mini.length || p >= out.length) break; const n = Math.min(miniSize, out.length - p, mini.length - off); out.set(mini.subarray(off, off + n), p); p += n; }
    return out;
  };
  return { entries, readStream };
}

/* ------------------------------------------------------------------ BIFF records */
const rkView = new DataView(new ArrayBuffer(8));
/** Decode an RK value (30-bit integer or truncated IEEE double, optionally ÷100). */
export function rkValue(v) {
  let x;
  if (v & 2) x = (v | 0) >> 2;
  else { rkView.setUint32(0, 0, true); rkView.setUint32(4, (v & 0xFFFFFFFC) >>> 0, true); x = rkView.getFloat64(0, true); }
  return (v & 1) ? x / 100 : x;
}

const latin1 = (u8, pos, n) => { let t = ''; for (let i = 0; i < n; i++) t += String.fromCharCode(u8[pos + i]); return t; };
const utf16 = (u8, pos, n) => { let t = ''; for (let i = 0; i < n; i++) t += String.fromCharCode(u8[pos + 2 * i] | (u8[pos + 2 * i + 1] << 8)); return t; };

/** XLUnicodeString (BIFF8) or byte string (BIFF5) at pos; lenBytes = size of the character count (1 or 2). */
function readString(u8, pos, lenBytes, biff8) {
  const cch = lenBytes === 1 ? u8[pos] : (u8[pos] | (u8[pos + 1] << 8)); pos += lenBytes;
  if (!biff8) return { text: latin1(u8, pos, cch), next: pos + cch };
  const flags = u8[pos++];
  let cRun = 0, cbExt = 0;
  if (flags & 8) { cRun = u8[pos] | (u8[pos + 1] << 8); pos += 2; }
  if (flags & 4) { cbExt = u8[pos] | (u8[pos + 1] << 8) | (u8[pos + 2] << 16) | (u8[pos + 3] << 24); pos += 4; }
  const text = flags & 1 ? utf16(u8, pos, cch) : latin1(u8, pos, cch);
  pos += (flags & 1 ? 2 : 1) * cch + 4 * cRun + cbExt;
  return { text, next: pos };
}

/** Shared string table: SST data (after its 8-byte header) + CONTINUE chunks -> strings. */
function sstStrings(chunks, unique) {
  let ci = 0, pos = 0;
  const out = [];
  const more = () => { ci++; pos = 0; return ci < chunks.length; };
  const byte = () => { while (pos >= chunks[ci].length) if (!more()) throw new Error('SST truncado'); return chunks[ci][pos++]; };
  const u16 = () => byte() | (byte() << 8);
  for (let n = 0; n < unique; n++) {
    while (ci < chunks.length && pos >= chunks[ci].length) if (!more()) return out;
    if (ci >= chunks.length) return out;
    const cch = u16(); const flags = byte();
    let high = flags & 1; let cRun = 0, cbExt = 0;
    if (flags & 8) cRun = u16();
    if (flags & 4) cbExt = u16() + u16() * 65536;
    let text = '', left = cch;
    while (left > 0) {
      if (pos >= chunks[ci].length) { if (!more()) throw new Error('SST truncado'); high = chunks[ci][pos++] & 1; } // a continued string restarts with its own flags byte
      const c = chunks[ci]; const room = high ? Math.floor((c.length - pos) / 2) : c.length - pos;
      const k = Math.min(left, room);
      if (k <= 0) { pos = c.length; continue; }
      text += high ? utf16(c, pos, k) : latin1(c, pos, k);
      pos += (high ? 2 : 1) * k; left -= k;
    }
    let skip = 4 * cRun + cbExt; // rich-text runs + extended (phonetic) data, may span chunks without a flags byte
    while (skip > 0) { if (pos >= chunks[ci].length) { if (!more()) break; } const k = Math.min(skip, chunks[ci].length - pos); pos += k; skip -= k; }
    out.push(text);
  }
  return out;
}

const BUILTIN_DATE_FMT = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const isDateFormat = (code) => /[dmyhs]/i.test(String(code).replace(/"[^"]*"|\\.|\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, ''));

/**
 * Read the first worksheet of a legacy .xls workbook (BIFF8, or BIFF5/7).
 * @param {ArrayBuffer} buf
 * @returns {{ rows: any[][], sheet: string, sheets: string[] }}
 */
export function readXlsRows(buf, { sheetIndex = 0 } = {}) {
  const { entries, readStream } = oleStreams(buf);
  const wbEntry = entries.find((e) => e.type === 2 && /^(workbook|book)$/i.test(e.name));
  if (!wbEntry) throw new Error(`o ficheiro não contém um livro Excel (streams: ${entries.filter((e) => e.type === 2).map((e) => e.name).join(', ') || 'nenhum'})`);
  const s = readStream(wbEntry);
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const u16 = (p) => dv.getUint16(p, true), u32 = (p) => dv.getUint32(p, true);
  // split into records
  const recs = [];
  for (let p = 0; p + 4 <= s.length;) { const type = u16(p); const len = Math.min(u16(p + 2), s.length - p - 4); recs.push({ type, pos: p + 4, len }); p += 4 + len; }
  if (!recs.length || recs[0].type !== 0x0809) throw new Error('livro Excel inválido (registo BOF em falta)');
  const ver = u16(recs[0].pos);
  const biff8 = ver === 0x0600;
  if (!biff8 && ver !== 0x0500) throw new Error(`versão de ficheiro Excel não suportada (BIFF 0x${ver.toString(16)})`);
  const str = (pos, lenBytes) => readString(s, pos, lenBytes, biff8);
  // --- workbook globals: sheet list, shared strings, date system, number formats
  const sheets = []; let sst = []; let date1904 = false;
  const fmtIsDate = new Map(); const xfIsDate = [];
  let i = 0, depth = 0;
  for (; i < recs.length; i++) {
    const r = recs[i];
    if (r.type === 0x0809) { depth++; continue; }
    if (r.type === 0x000A) { if (--depth <= 0) { i++; break; } continue; }
    if (r.type === 0x0085) { const off = u32(r.pos); const kind = s[r.pos + 5] & 0x0F; const name = biff8 ? str(r.pos + 6, 1).text : latin1(s, r.pos + 7, s[r.pos + 6]); sheets.push({ name, off, kind }); }
    else if (r.type === 0x0022) date1904 = u16(r.pos) === 1;
    else if (r.type === 0x041E) { const code = r.len > 3 ? str(r.pos + 2, biff8 ? 2 : 1).text : ''; fmtIsDate.set(u16(r.pos), isDateFormat(code)); }
    else if (r.type === 0x00E0 || r.type === 0x0043) { const ifmt = u16(r.pos + 2); xfIsDate.push(fmtIsDate.has(ifmt) ? fmtIsDate.get(ifmt) : BUILTIN_DATE_FMT.has(ifmt)); }
    else if (r.type === 0x00FC) {
      const unique = u32(r.pos + 4);
      const chunks = [s.subarray(r.pos + 8, r.pos + r.len)];
      let j = i + 1;
      while (j < recs.length && recs[j].type === 0x003C) { chunks.push(s.subarray(recs[j].pos, recs[j].pos + recs[j].len)); j++; }
      sst = sstStrings(chunks, unique); i = j - 1;
    }
  }
  const worksheets = sheets.filter((sh) => sh.kind === 0);
  const target = worksheets[sheetIndex] || worksheets[0] || sheets[0];
  // locate the sheet substream: BOUNDSHEET offset, else the n-th BOF after the globals
  let start = target ? recs.findIndex((r) => r.pos - 4 === target.off && r.type === 0x0809) : -1;
  if (start < 0) { let n = target ? sheets.indexOf(target) : 0; for (let k = i; k < recs.length; k++) if (recs[k].type === 0x0809 && n-- === 0) { start = k; break; } }
  if (start < 0) throw new Error('nenhuma folha de cálculo encontrada no ficheiro');
  // --- cells
  const rows = [];
  const set = (row, col, v, xf) => {
    if (date1904 && typeof v === 'number' && xfIsDate[xf]) v += 1462; // 1904 date system -> 1900 serials
    (rows[row] ||= [])[col] = v;
  };
  for (let k = start, d = 0; k < recs.length; k++) {
    const r = recs[k], t = r.type, p = r.pos;
    if (t === 0x0809) { d++; continue; }
    if (t === 0x000A) { if (--d <= 0) break; continue; }
    if (d !== 1 || r.len < 6) continue; // cells of embedded charts etc. are ignored
    const row = u16(p), col = u16(p + 2), xf = u16(p + 4);
    switch (t) {
      case 0x00FD: set(row, col, sst[u32(p + 6)] ?? '', xf); break; // LABELSST
      case 0x0203: set(row, col, dv.getFloat64(p + 6, true), xf); break; // NUMBER
      case 0x027E: set(row, col, rkValue(u32(p + 6)), xf); break; // RK
      case 0x00BD: { const n = Math.floor((r.len - 6) / 6); for (let q = 0; q < n; q++) set(row, col + q, rkValue(u32(p + 4 + q * 6 + 2)), u16(p + 4 + q * 6)); break; } // MULRK
      case 0x0204: case 0x00D6: set(row, col, str(p + 6, 2).text, xf); break; // LABEL / RSTRING
      case 0x0205: if (s[p + 7] === 0) set(row, col, s[p + 6] ? 1 : 0, xf); break; // BOOLERR (errors skipped)
      case 0x0006: { // FORMULA: cached result
        if (u16(p + 12) === 0xFFFF) {
          const kind = s[p + 6];
          if (kind === 0) { let q = k + 1; while (q < recs.length && (recs[q].type === 0x04BC || recs[q].type === 0x0221 || recs[q].type === 0x0236)) q++; if (recs[q]?.type === 0x0207) set(row, col, str(recs[q].pos, 2).text, xf); }
          else if (kind === 1) set(row, col, s[p + 8] ? 1 : 0, xf);
          else if (kind === 3) set(row, col, '', xf);
        } else set(row, col, dv.getFloat64(p + 6, true), xf);
        break;
      }
      default: break;
    }
  }
  for (let r = 0; r < rows.length; r++) rows[r] = rows[r] ? Array.from(rows[r], (c) => (c === undefined ? null : c)) : [];
  return { rows, sheet: target?.name || 'Sheet1', sheets: sheets.map((sh) => sh.name) };
}

/* ------------------------------------------------------------------ HTML / SpreadsheetML "xls" files */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e[1] === 'x' || e[1] === 'X' ? e.slice(2) : e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10)) : (ENT[e.toLowerCase()] ?? m));
const cellText = (html) => decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Rows of the first table in an HTML document or of the first worksheet of a SpreadsheetML 2003 XML
 * document (both are commonly served as ".xls" by web portals). Returns null when the text is not markup.
 */
export function tableTextToRows(text) {
  const t = String(text || '').replace(/^\uFEFF/, '').trimStart();
  if (t[0] !== '<') return null;
  const ssml = /urn:schemas-microsoft-com:office:spreadsheet|<(?:ss:)?Workbook\b/i.test(t.slice(0, 4000));
  let body = t;
  if (ssml) { const m = t.match(/<(?:ss:)?Worksheet\b[\s\S]*?<\/(?:ss:)?Worksheet>/i); if (m) body = m[0]; }
  else { const m = t.match(/<table\b[\s\S]*?<\/table>/i); if (m) body = m[0]; }
  const rowRe = ssml ? /<(?:ss:)?Row\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Row>/gi : /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = ssml ? /<(?:ss:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/gi : /<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi;
  const rows = [];
  for (const rm of body.matchAll(rowRe)) {
    const inner = ssml ? rm[2] : rm[1];
    if (ssml) { const idx = rm[1].match(/ss:Index="(\d+)"/i); if (idx) while (rows.length < +idx[1] - 1) rows.push([]); }
    const cells = []; let col = 0;
    for (const cm of inner.matchAll(cellRe)) {
      const attrs = cm[1] || '', content = cm[2] || '';
      if (ssml) { const idx = attrs.match(/ss:Index="(\d+)"/i); if (idx) col = +idx[1] - 1; }
      let v;
      if (ssml) {
        const dm = content.match(/<(?:ss:)?Data\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Data>/i);
        const type = dm ? (dm[1].match(/(?:ss:)?Type="(\w+)"/i) || [])[1] : '';
        v = dm ? cellText(dm[2]) : '';
        if (/^Number$/i.test(type) && v !== '' && Number.isFinite(Number(v))) v = Number(v);
        else if (/^DateTime$/i.test(type)) v = v.replace('T', ' ').replace(/\.\d+$/, '').replace(/ 00:00:00$/, '');
        else if (/^Boolean$/i.test(type)) v = v === '1' ? 1 : 0;
      } else v = cellText(content);
      cells[col++] = v;
      const span = attrs.match(/(?:colspan|ss:MergeAcross)="?(\d+)/i); if (span) col += +span[1] - (ssml ? 0 : 1);
    }
    rows.push(Array.from(cells, (c) => (c === undefined ? null : c)));
  }
  return rows.some((r) => r.length) ? rows : null;
}
