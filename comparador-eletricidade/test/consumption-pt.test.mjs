// Portuguese consumption curve (E-Redes "diagrama de carga"): ERSE schedules, Excel/CSV parsing, slicing, shares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { periodPT, periodFor, isSummerTime, parseConsumptionPT, sliceCurvePT, kwhForOption, shareForOption, shiftToVazio, csvToRows } from '../public/lib/consumption-pt.js';
import { readXlsxRows, sheetRowsToCsv, inflateRaw, isZip, isOle } from '../public/lib/xlsx-lite.js';
import { parseConsumptionCSV } from '../public/lib/consumption-es.js';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ab = (file) => { const b = readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const SAMPLE_XLSX = resolve(__dirname, '../public/samples/consumos-eredes-exemplo.xlsx');
const SAMPLE_CSV = resolve(__dirname, '../public/samples/consumos-eredes-exemplo.csv');
const M = (h, m = 0) => h * 60 + m;

test('ERSE schedules – ciclo diário (same every day, differs by legal time)', () => {
  const winter = new Date(2026, 0, 14); // Wednesday, January
  const summer = new Date(2026, 6, 15); // Wednesday, July
  assert.equal(isSummerTime(winter), false);
  assert.equal(isSummerTime(summer), true);
  assert.equal(isSummerTime(new Date(2026, 2, 29)), true, 'last Sunday of March 2026 starts summer time');
  assert.equal(isSummerTime(new Date(2026, 2, 28)), false);
  assert.equal(isSummerTime(new Date(2026, 9, 24)), true);
  assert.equal(isSummerTime(new Date(2026, 9, 25)), false, 'last Sunday of October 2026 back to winter');
  // vazio 22-08 all year, any day of the week
  for (const d of [winter, summer, new Date(2026, 6, 18), new Date(2026, 6, 19)]) {
    assert.equal(periodPT(d, M(23), { cycle: 'diario' }), 'vazio');
    assert.equal(periodPT(d, M(7, 45), { cycle: 'diario' }), 'vazio');
    assert.equal(periodPT(d, M(8), { cycle: 'diario' }), 'cheias');
    assert.equal(periodPT(d, M(21, 45), { cycle: 'diario' }), 'cheias');
  }
  // winter ponta 09:00-10:30 / 18:00-20:30 ; summer ponta 10:30-13:00 / 19:30-21:00
  assert.equal(periodPT(winter, M(9), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(winter, M(10, 15), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(winter, M(10, 30), { cycle: 'diario' }), 'cheias');
  assert.equal(periodPT(winter, M(18), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(winter, M(20, 30), { cycle: 'diario' }), 'cheias');
  assert.equal(periodPT(summer, M(9), { cycle: 'diario' }), 'cheias');
  assert.equal(periodPT(summer, M(10, 30), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(summer, M(12, 45), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(summer, M(13), { cycle: 'diario' }), 'cheias');
  assert.equal(periodPT(summer, M(19, 30), { cycle: 'diario' }), 'ponta');
  assert.equal(periodPT(summer, M(21), { cycle: 'diario' }), 'cheias');
  // bi-horário: fora de vazio 08-22
  assert.equal(periodPT(summer, M(12), { cycle: 'diario', option: 2 }), 'foraVazio');
  assert.equal(periodPT(summer, M(3), { cycle: 'diario', option: 2 }), 'vazio');
  assert.equal(periodPT(summer, M(3), { cycle: 'diario', option: 1 }), 'simples');
});

test('ERSE schedules – ciclo semanal (weekdays / Saturday / Sunday, winter / summer)', () => {
  const wWed = new Date(2026, 0, 14), wSat = new Date(2026, 0, 17), wSun = new Date(2026, 0, 18);
  const sWed = new Date(2026, 6, 15), sSat = new Date(2026, 6, 18), sSun = new Date(2026, 6, 19);
  const o = { cycle: 'semanal' };
  // weekdays: vazio 00-07
  for (const d of [wWed, sWed]) { assert.equal(periodPT(d, M(6, 45), o), 'vazio'); assert.equal(periodPT(d, M(7), o), 'cheias'); assert.equal(periodPT(d, M(23, 45), o), 'cheias'); }
  // winter weekday ponta 09:30-12:00 and 18:30-21:00
  assert.equal(periodPT(wWed, M(9, 15), o), 'cheias');
  assert.equal(periodPT(wWed, M(9, 30), o), 'ponta');
  assert.equal(periodPT(wWed, M(11, 45), o), 'ponta');
  assert.equal(periodPT(wWed, M(12), o), 'cheias');
  assert.equal(periodPT(wWed, M(18, 30), o), 'ponta');
  assert.equal(periodPT(wWed, M(21), o), 'cheias');
  // summer weekday ponta 09:15-12:15 only
  assert.equal(periodPT(sWed, M(9, 15), o), 'ponta');
  assert.equal(periodPT(sWed, M(12), o), 'ponta');
  assert.equal(periodPT(sWed, M(12, 15), o), 'cheias');
  assert.equal(periodPT(sWed, M(19), o), 'cheias');
  // Saturdays: no ponta; winter cheias 09:30-13:00 / 18:30-22:00, summer 09:00-14:00 / 20:00-22:00
  assert.equal(periodPT(wSat, M(9, 30), o), 'cheias');
  assert.equal(periodPT(wSat, M(13), o), 'vazio');
  assert.equal(periodPT(wSat, M(18, 30), o), 'cheias');
  assert.equal(periodPT(wSat, M(22), o), 'vazio');
  assert.equal(periodPT(sSat, M(9), o), 'cheias');
  assert.equal(periodPT(sSat, M(14), o), 'vazio');
  assert.equal(periodPT(sSat, M(20), o), 'cheias');
  assert.equal(periodPT(sSat, M(8, 45), o), 'vazio');
  // Sundays: all vazio
  for (const d of [wSun, sSun]) for (const m of [0, M(10), M(19, 30), M(23, 45)]) assert.equal(periodPT(d, m, o), 'vazio');
  assert.equal(periodFor({ season: 'inverno', dayType: 'sabado', minute: M(10), cycle: 'semanal', option: 2 }), 'foraVazio');
});

test('xlsx-lite: inflate + ZIP + sheet parsing (shared strings, inline strings, numbers)', () => {
  // inflate round-trip on compressible + random-ish data (dynamic + fixed Huffman blocks)
  const txt = Buffer.from(('Data;Hora;Consumo registado, Ativa (kW)\n' + '2026/07/30;00:15;0.236\n'.repeat(500)));
  assert.equal(Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(txt, { level: 9 })), txt.length)).toString(), txt.toString());
  const rnd = Buffer.alloc(5000); let s = 7; for (let i = 0; i < rnd.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; rnd[i] = s >>> 16; }
  assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(rnd, { level: 1 })))), rnd);
  assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(deflateRawSync(rnd, { level: 0 })))), rnd, 'stored blocks');
  // workbook written by our sample generator (shared strings)
  const buf = ab(SAMPLE_XLSX);
  assert.ok(isZip(buf) && !isOle(buf));
  const { rows, sheet, sheets } = readXlsxRows(buf);
  assert.equal(sheet, 'Consumos'); assert.deepEqual(sheets, ['Consumos']);
  assert.deepEqual(rows[5], ['Data', 'Hora', 'Consumo registado, Ativa (kW)', 'Estado']);
  assert.equal(rows[6][0], '2026/07/30'); assert.equal(rows[6][1], '00:15'); assert.equal(typeof rows[6][2], 'number');
  assert.equal(rows.length - 6, 38 * 96);
  // workbook written by openpyxl (inline strings, empty rows, formulas)
  const r2 = readXlsxRows(ab(resolve(__dirname, 'fixtures/eredes-3dias.xlsx'))).rows;
  assert.deepEqual(r2[4], ['Data', 'Hora', 'Consumo registado, Ativa (kW)', 'Injeção registada, Ativa (kW)', 'Estado']);
  assert.deepEqual(r2[3], []);
  assert.equal(r2[5][4], 'Real');
  // Excel serial dates / times are rendered for the Spanish CSV parser
  const dat = readXlsxRows(ab(resolve(__dirname, 'fixtures/datadis-ejemplo.xlsx'))).rows;
  const csv = sheetRowsToCsv(dat);
  assert.match(csv.split('\n')[1], /^ES0031;2026-07-19;1;0\.5;R$/);
  const es = parseConsumptionCSV(csv);
  assert.equal(es.format, 'Datadis / CNMC'); assert.equal(es.days, 2); assert.equal(es.totalKwh, 11.2);
  assert.throws(() => readXlsxRows(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer), /não é um \.xlsx/);
});

test('E-Redes Excel: 15-min average power (kW) → kWh, hour = end of the quarter, both cycles, slicing to the invoice period', () => {
  const { rows } = readXlsxRows(ab(SAMPLE_XLSX));
  const c = parseConsumptionPT(rows, { source: 'Excel' });
  assert.match(c.format, /E-Redes/);
  assert.equal(c.unit, 'kW'); assert.equal(c.step, 15); assert.equal(c.endConv, true);
  assert.equal(c.days, 38); assert.equal(c.start, '2026-07-30'); assert.equal(c.end, '2026-09-05');
  assert.equal(c.quarters.length, 38 * 96); assert.equal(c.missingQuarters, 0);
  // kWh = sum(kW)/4
  const sumKw = rows.slice(6).reduce((a, r) => a + (typeof r[2] === 'number' ? r[2] : 0), 0);
  assert.ok(Math.abs(c.totalKwh - sumKw / 4) < 0.01, `${c.totalKwh} vs ${sumKw / 4}`);
  // first quarter is 00:00-00:15 of 30/07 (row "00:15"), last is 23:45 of 05/09 (row "2026/09/06 00:00")
  assert.deepEqual([c.quarters[0].day, c.quarters[0].min], ['2026-07-30', 0]);
  assert.deepEqual([c.quarters.at(-1).day, c.quarters.at(-1).min], ['2026-09-05', 1425]);
  assert.ok(Math.abs(c.quarters[0].kwh - rows[6][2] / 4) < 1e-9);
  // shares add up; summer file -> semanal has few ponta hours (09:15-12:15 weekdays only)
  for (const cy of ['diario', 'semanal']) {
    assert.ok(Math.abs(c.share[cy][3].ponta + c.share[cy][3].cheias + c.share[cy][3].vazio - 1) < 1e-9);
    assert.ok(Math.abs(c.share[cy][2].foraVazio - c.share[cy][3].ponta - c.share[cy][3].cheias) < 1e-9);
    assert.ok(Math.abs(c.split[cy][3].ponta + c.split[cy][3].cheias + c.split[cy][3].vazio - c.totalKwh) < 0.01);
  }
  assert.ok(c.share.semanal[3].ponta < c.share.diario[3].ponta);
  assert.ok(c.share.diario[2].vazio > 0.2 && c.share.diario[2].vazio < 0.4, `vazio ${c.share.diario[2].vazio}`);
  assert.equal(c.season, 'verao'); assert.equal(c.seasonDays.verao, 38);
  assert.deepEqual(c.dayCounts, { util: 27, sabado: 6, domingo: 5 });
  assert.ok(c.maxPower && c.maxPower.kw > 2 && /^\d\d:\d\d$/.test(c.maxPower.time));
  assert.ok(c.warnings.some((w) => /kW/.test(w)) && c.warnings.some((w) => /fim do intervalo/.test(w)));
  assert.equal(c.profileQ.util.length, 96); assert.equal(c.profile.util.length, 24);
  assert.ok(Math.abs(c.profileQ.util.reduce((a, b) => a + b, 0) - c.profile.util.reduce((a, b) => a + b, 0)) < 1e-9);
  // slice to the sample invoice period (03/08 → 02/09 = 31 days)
  const sl = sliceCurvePT(c, '2026-08-03', '2026-09-02');
  assert.equal(sl.days, 31); assert.equal(sl.start, '2026-08-03'); assert.equal(sl.end, '2026-09-02');
  assert.ok(sl.totalKwh < c.totalKwh);
  assert.equal(sliceCurvePT(c, '2027-01-01', '2027-02-01'), null);
  // kWh per option: real kWh or the invoice total split with the real shares
  assert.deepEqual(kwhForOption(sl, 'diario', 1), [sl.totalKwh]);
  const tri = kwhForOption(sl, 'diario', 3, 413);
  assert.ok(Math.abs(tri[0] + tri[1] + tri[2] - 413) < 0.01);
  assert.ok(Math.abs(tri[2] / 413 - sl.share.diario[3].vazio) < 1e-3);
  assert.deepEqual(shareForOption(sl, 'semanal', 2).map((x) => +x.toFixed(6)), [sl.share.semanal[2].foraVazio, sl.share.semanal[2].vazio].map((x) => +x.toFixed(6)));
  // what-if: move 25 % of fora de vazio / ponta+cheias to vazio
  assert.deepEqual(shiftToVazio([100, 50], 2, 0.25), [75, 75]);
  assert.deepEqual(shiftToVazio([40, 60, 50], 3, 0.5), [20, 30, 100]);
  assert.deepEqual(shiftToVazio([150], 1, 0.5), [150]);
  // the CSV twin of the sample gives the same numbers
  const c2 = parseConsumptionPT(readFileSync(SAMPLE_CSV, 'utf8'));
  assert.equal(c2.totalKwh, c.totalKwh); assert.equal(c2.days, 38); assert.deepEqual(c2.split, c.split);
});

test('E-Redes Excel variants: title rows + injection + Estado column, Excel serial dates/times, totals row', () => {
  const c = parseConsumptionPT(readXlsxRows(ab(resolve(__dirname, 'fixtures/eredes-3dias.xlsx'))).rows);
  assert.equal(c.days, 3); assert.equal(c.start, '2026-07-01'); assert.equal(c.end, '2026-07-03');
  assert.equal(c.quarters.length, 288); assert.equal(c.missingQuarters, 0);
  assert.ok(c.estimatedShare > 0.05 && c.estimatedShare < 0.2, 'Estado = Estimado rows are flagged');
  assert.ok(!c.warnings.some((w) => /não interpretadas/.test(w)), `no bad-row warning for the title/total rows: ${c.warnings}`);
  assert.equal(c.exportKwh, 0);
  const s = parseConsumptionPT(readXlsxRows(ab(resolve(__dirname, 'fixtures/eredes-datas-serial.xlsx'))).rows);
  assert.equal(s.days, 2); assert.equal(s.start, '2026-01-05'); assert.equal(s.totalKwh, 48, '1 kW flat × 48 h');
  assert.equal(s.step, 15); assert.equal(s.endConv, true);
  assert.deepEqual(s.split.diario[3], { ponta: 8, cheias: 20, vazio: 20 }, 'winter diário: 4 h ponta, 10 h cheias, 10 h vazio per day');
  assert.deepEqual(s.split.semanal[3], { ponta: 10, cheias: 24, vazio: 14 }, 'winter semanal weekdays (Mon+Tue): 5 h ponta, 12 h cheias, 7 h vazio per day');
});

test('generic CSV files: hourly kWh with HH:MM, 1..24 index, Wh (Shelly UTC export), errors', () => {
  // hourly, hour = start, decimal comma, DD/MM/YYYY
  let csv = 'Data;Hora;Consumo (kWh)\n';
  for (let d = 5; d <= 6; d++) for (let h = 0; h < 24; h++) csv += `0${d}/01/2026;${String(h).padStart(2, '0')}:00;1,0\n`;
  let c = parseConsumptionPT(csv);
  assert.equal(c.step, 60); assert.equal(c.endConv, false); assert.equal(c.totalKwh, 48);
  assert.deepEqual(c.split.diario[3], { ponta: 8, cheias: 20, vazio: 20 });
  // 1..24 hour-ending index (distributor style)
  csv = 'Data;Hora;Consumo_kWh\n';
  for (let d = 5; d <= 6; d++) for (let h = 1; h <= 24; h++) csv += `2026-01-0${d};${h};1\n`;
  c = parseConsumptionPT(csv);
  assert.equal(c.totalKwh, 48); assert.deepEqual(c.split.diario[3], { ponta: 8, cheias: 20, vazio: 20 });
  // Shelly-like export: UTC timestamps in Wh (winter: UTC = local)
  csv = 'Date/time UTC,Active energy Wh,Returned energy Wh\n';
  for (let d = 5; d <= 6; d++) for (let h = 0; h < 24; h++) csv += `2026-01-0${d} ${String(h).padStart(2, '0')}:00,1000,0\n`;
  c = parseConsumptionPT(csv);
  assert.equal(c.unit, 'Wh'); assert.equal(c.totalKwh, 48); assert.match(c.format, /Shelly/);
  assert.deepEqual(c.split.diario[3], { ponta: 8, cheias: 20, vazio: 20 });
  // same in summer: UTC+1 shift moves 23:00Z to 00:00 local next day
  csv = 'Date/time UTC,Active energy Wh,Returned energy Wh\n2026-07-15 21:00,1000,0\n2026-07-15 22:00,1000,0\n';
  c = parseConsumptionPT(csv);
  assert.deepEqual(c.quarters.map((q) => q.min)[0], 22 * 60, '21:00Z = 22:00 local');
  assert.equal(c.split.diario[3].vazio, 2);
  // unusable files
  assert.throws(() => parseConsumptionPT('foo;bar\n1;2\n'), /Não foi possível reconhecer/);
  assert.throws(() => parseConsumptionPT('Data;Consumo (kWh)\n2026-01-05;12\n2026-01-06;11\n'), /a cada dia/);
  assert.throws(() => parseConsumptionPT('Data;Leitura (kWh)\n2026-01-05;12345\n'), /LEITURAS/);
  assert.throws(() => parseConsumptionPT(''), /vazio/);
  assert.equal(csvToRows('a;b\n1;"x;y"\n')[1][1], 'x;y');
});
