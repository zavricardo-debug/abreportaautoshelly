// Generates public/samples/consumos-eredes-exemplo.xlsx – a "diagrama de carga" in the layout of the
// E-Redes Balcão Digital export (title rows, then Data | Hora | Consumo registado, Ativa (kW) | Estado,
// one row per 15 minutes, hour = END of the quarter, value = average power in kW) for the billing period
// of the Portuguese sample invoices (03/08/2026 → 02/09/2026 + a few days around) with a realistic
// household profile. Also writes the same data as CSV (consumos-eredes-exemplo.csv).
// Deterministic (seeded).  Usage: npm run samples:eredes
// The .xlsx is written with a tiny zip/xml writer (no dependencies) – stored (uncompressed) entries.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/samples');
mkdirSync(outDir, { recursive: true });

let seed = 20260803;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// relative weights per hour (0..23) – summer household: base load, breakfast, lunch, evening peak, dishwasher at night
const weekday = [0.30, 0.22, 0.20, 0.20, 0.20, 0.22, 0.35, 0.60, 0.70, 0.55, 0.45, 0.50, 0.75, 0.80, 0.55, 0.45, 0.45, 0.55, 0.75, 1.05, 1.35, 1.40, 1.05, 0.55];
const weekend = [0.35, 0.25, 0.20, 0.20, 0.20, 0.22, 0.28, 0.40, 0.65, 0.85, 0.95, 1.00, 1.10, 1.15, 0.95, 0.75, 0.65, 0.65, 0.75, 1.00, 1.25, 1.30, 1.00, 0.55];

const start = new Date(2026, 6, 30); // 30/07/2026 (a few days before the invoice period 03/08 → 02/09)
const days = 38;
const rows = []; // [dateStr, hourStr, kW, estado]
const p2 = (n) => String(n).padStart(2, '0');
const fmtD = (d) => `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
let totalKwh = 0;
for (let d = 0; d < days; d++) {
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
  const dow = date.getDay();
  const prof = dow === 0 || dow === 6 ? weekend : weekday;
  const dayFactor = (d >= 12 && d <= 18 ? 1.2 : 1) * (d === 24 || d === 25 ? 0.5 : 1); // hot week / weekend away
  for (let q = 0; q < 96; q++) {
    const h = Math.floor(q / 4);
    let kw = prof[h] * dayFactor * (0.7 + rnd() * 0.6) * 0.62; // average power in the quarter (kW)
    if (h === 22 && q % 4 < 2 && dow >= 1 && dow <= 5 && rnd() < 0.6) kw += 1.6; // dishwasher 22:00-22:30 some weekdays
    if (h === 1 && q % 4 === 0 && rnd() < 0.35) kw += 2.0;                       // washing machine at night
    if (h === 20 && q % 4 === 1 && rnd() < 0.5) kw += 1.8;                       // oven
    kw = Math.round(kw * 1000) / 1000;
    totalKwh += kw / 4;
    // E-Redes convention: the hour is the END of the quarter; 24:00 is written as 00:00 of the next day
    const endMin = (q + 1) * 15;
    const endDate = endMin === 1440 ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) : date;
    rows.push([fmtD(endDate), `${p2(Math.floor((endMin % 1440) / 60))}:${p2(endMin % 60)}`, kw, rnd() < 0.02 ? 'Estimado' : 'Real']);
  }
}

/* ---------------- CSV */
const csv = ['Data;Hora;Consumo registado, Ativa (kW);Estado', ...rows.map((r) => `${r[0]};${r[1]};${String(r[2]).replace('.', ',')};${r[3]}`)].join('\n') + '\n';
writeFileSync(resolve(outDir, 'consumos-eredes-exemplo.csv'), csv, 'utf8');

/* ---------------- XLSX (minimal OOXML) */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strs = []; const strIdx = new Map();
const sst = (s) => { if (!strIdx.has(s)) { strIdx.set(s, strs.length); strs.push(s); } return strIdx.get(s); };
const colL = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const sheetRows = [
  ['Relatório de Consumos'], ['CPE: PT0002000123456789XY'], [`Período: ${rows[0][0]} a ${rows[rows.length - 1][0]}`], ['Unidade: Potência média (kW) em períodos de 15 minutos – energia (kWh) = kW ÷ 4'], [],
  ['Data', 'Hora', 'Consumo registado, Ativa (kW)', 'Estado'],
  ...rows,
];
let sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
sheetRows.forEach((r, ri) => {
  if (!r.length) return;
  sheetXml += `<row r="${ri + 1}">`;
  r.forEach((v, ci) => {
    const ref = `${colL(ci)}${ri + 1}`;
    if (typeof v === 'number') sheetXml += `<c r="${ref}"><v>${v}</v></c>`;
    else sheetXml += `<c r="${ref}" t="s"><v>${sst(v)}</v></c>`;
  });
  sheetXml += '</row>';
});
sheetXml += '</sheetData></worksheet>';
const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strs.length}" uniqueCount="${strs.length}">${strs.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
const files = {
  '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Consumos" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': sheetXml,
  'xl/sharedStrings.xml': sstXml,
};

// --- zip writer (deflate, CRC32)
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = (u8) => { let c = -1; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const parts = []; const central = []; let offset = 0;
for (const [name, content] of Object.entries(files)) {
  const nameB = Buffer.from(name, 'utf8'); const data = Buffer.from(content, 'utf8'); const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.from([...le32(0x04034b50), ...le16(20), ...le16(0x0800), ...le16(8), ...le16(0), ...le16(0x5000), ...le32(crc), ...le32(comp.length), ...le32(data.length), ...le16(nameB.length), ...le16(0)]);
  parts.push(local, nameB, comp);
  central.push(Buffer.from([...le32(0x02014b50), ...le16(20), ...le16(20), ...le16(0x0800), ...le16(8), ...le16(0), ...le16(0x5000), ...le32(crc), ...le32(comp.length), ...le32(data.length), ...le16(nameB.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset)]), nameB);
  offset += local.length + nameB.length + comp.length;
}
const cd = Buffer.concat(central);
const eocd = Buffer.from([...le32(0x06054b50), ...le16(0), ...le16(0), ...le16(central.length / 2), ...le16(central.length / 2), ...le32(cd.length), ...le32(offset), ...le16(0)]);
const xlsx = Buffer.concat([...parts, cd, eocd]);
writeFileSync(resolve(outDir, 'consumos-eredes-exemplo.xlsx'), xlsx);
console.log(`wrote consumos-eredes-exemplo.xlsx (${xlsx.length} bytes) and .csv – ${rows.length} quarter-hours, ${days} days, ${totalKwh.toFixed(1)} kWh`);
