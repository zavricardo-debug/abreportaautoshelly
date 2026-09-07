import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConsumptionCSV, period20TD, sliceCurve, applyShare, shiftToValle, energyCostES, HOLIDAYS_MMDD } from '../public/lib/consumption-es.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const d = (iso) => { const [y, m, dd] = iso.split('-').map(Number); return new Date(y, m - 1, dd); };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('2.0TD calendar: weekday periods, weekends and national holidays are valle, Ceuta/Melilla shifted', () => {
  const mon = d('2026-07-20');
  const expected = ['valle', 'valle', 'valle', 'valle', 'valle', 'valle', 'valle', 'valle', 'llano', 'llano', 'punta', 'punta', 'punta', 'punta', 'llano', 'llano', 'llano', 'llano', 'punta', 'punta', 'punta', 'punta', 'llano', 'llano'];
  assert.deepEqual(Array.from({ length: 24 }, (_, h) => period20TD(mon, h)), expected);
  assert.equal(period20TD(d('2026-07-25'), 12), 'valle');      // Saturday
  assert.equal(period20TD(d('2026-07-26'), 20), 'valle');      // Sunday
  assert.equal(period20TD(d('2026-08-15'), 12), 'valle');      // Asunción (Saturday anyway)
  assert.equal(period20TD(d('2026-10-12'), 12), 'valle');      // Fiesta Nacional (Monday)
  assert.equal(period20TD(d('2026-01-06'), 12), 'valle');      // Reyes (Tuesday)
  assert.equal(period20TD(d('2026-12-08'), 19), 'valle');      // Inmaculada (Tuesday)
  assert.equal(period20TD(d('2026-04-03'), 12), 'punta');      // Viernes Santo: not a fixed-date holiday -> normal Friday
  assert.equal(HOLIDAYS_MMDD.length, 9);
  assert.equal(period20TD(mon, 10, { ceutaMelilla: true }), 'llano');
  assert.equal(period20TD(mon, 11, { ceutaMelilla: true }), 'punta');
  assert.equal(period20TD(mon, 22, { ceutaMelilla: true }), 'punta');
  assert.equal(period20TD(mon, 23, { ceutaMelilla: true }), 'llano');
});

test('Datadis / CNMC format (hour 1..24 = hour ending): one weekday + one Saturday', () => {
  let csv = 'CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion\n';
  for (const day of ['20/07/2026', '25/07/2026']) for (let h = 1; h <= 24; h++) csv += `ES0031000000000000AB;${day};${h};1,000;R\n`;
  const c = parseConsumptionCSV(csv);
  assert.equal(c.format, 'Datadis / CNMC');
  assert.equal(c.cups, 'ES0031000000000000AB');
  assert.equal(c.days, 2);
  assert.equal(c.totalKwh, 48);
  assert.deepEqual(c.byPeriod, { punta: 8, llano: 8, valle: 32 });
  close(c.share.valle, 32 / 48);
  assert.deepEqual(c.warnings, []);
  assert.equal(c.start, '2026-07-20'); assert.equal(c.end, '2026-07-25');
  assert.equal(c.weekdays, 1); assert.equal(c.weekendDays, 1);
  // hour 1 (00-01) is valle, hour 11 (10-11) is punta on the Monday
  assert.equal(c.hours[0].period, 'valle'); assert.equal(c.hours[10].period, 'punta');
});

test('e-distribución format with exports and estimated readings', () => {
  let csv = 'CUPS;Fecha;Hora;AE_kWh;AS_KWh;AE_AUTOCONS_kWh;REAL/ESTIMADO\n';
  for (let h = 1; h <= 24; h++) csv += `ES0031;21/07/2026;${h};0,500;${h > 10 && h < 16 ? '1,2' : '0'};;${h > 20 ? 'E' : 'R'}\n`;
  const c = parseConsumptionCSV(csv);
  assert.equal(c.format, 'e-distribución');
  assert.equal(c.totalKwh, 12);
  assert.deepEqual(c.byPeriod, { punta: 4, llano: 4, valle: 4 });
  assert.equal(c.exportKwh, 6);
  close(c.estimatedShare, 2 / 12);
  assert.ok(c.warnings.some((w) => /excedentes/.test(w)));
  assert.ok(c.warnings.some((w) => /estimadas/.test(w)));
});

test('i-DE format (FECHA-HORA with hour ending, Wh) and files with clock hours starting at 00:00', () => {
  let csv = 'CUPS;FECHA-HORA;INV / VER;CONSUMO Wh;GENERACION Wh\n';
  for (let h = 1; h <= 24; h++) csv += `ES0021;2026/07/22 ${String(h).padStart(2, '0')}:00;0;${h <= 8 ? 100 : 1000};0\n`;
  let c = parseConsumptionCSV(csv);
  assert.equal(c.format, 'i-DE');
  close(c.totalKwh, 16.8);
  assert.deepEqual(c.byPeriod, { punta: 8, llano: 8, valle: 0.8 });
  assert.ok(c.warnings.some((w) => /Wh convertidos/.test(w)));

  csv = 'Fecha;Hora;Consumo\n';
  for (let h = 0; h < 24; h++) csv += `22/07/2026;${String(h).padStart(2, '0')}:00;${h < 8 ? 0.1 : 1}\n`;
  c = parseConsumptionCSV(csv);
  assert.deepEqual(c.byPeriod, { punta: 8, llano: 8, valle: 0.8 });
});

test('quarter-hourly files (index 1..96 or 00:15 clock) are aggregated to hours; DST 25-hour day accepted', () => {
  let csv = '';
  for (let q = 1; q <= 96; q++) csv += `23/07/2026;${q};${q <= 32 ? 100 : 200}\n`;      // no header, Wh
  let c = parseConsumptionCSV(csv);
  assert.equal(c.format, 'sin cabecera');
  close(c.totalKwh, 16);
  assert.deepEqual(c.byPeriod, { punta: 6.4, llano: 6.4, valle: 3.2 });
  assert.ok(c.warnings.some((w) => /cuartohorario/.test(w)));

  csv = 'CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion\n';
  for (let q = 1; q <= 96; q++) { const m = q * 15; csv += `ES0031;22/07/2026;${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')};${q <= 32 ? '0,025' : '0,250'};R\n`; }
  c = parseConsumptionCSV(csv);
  assert.deepEqual(c.byPeriod, { punta: 8, llano: 8, valle: 0.8 });

  csv = 'Fecha;Hora;Consumo_kWh\n';
  for (let h = 1; h <= 25; h++) csv += `25/10/2026;${h};1\n`;
  c = parseConsumptionCSV(csv);
  assert.equal(c.totalKwh, 25);
  assert.deepEqual(c.byPeriod, { punta: 0, llano: 0, valle: 25 });
});

test('unreadable files raise a clear error', () => {
  assert.throws(() => parseConsumptionCSV(''), /vacío/);
  assert.throws(() => parseConsumptionCSV('Nombre;Apellido\nAna;García'), /No se reconocen las columnas/);
});

test('slice to the billing period, apply real shares to billed kWh, shift to valle, energy cost', () => {
  const csv = 'Fecha;Hora;Consumo_kWh\n' + ['20/07/2026', '21/07/2026', '25/07/2026'].flatMap((dd) => Array.from({ length: 24 }, (_, i) => `${dd};${i + 1};1`)).join('\n');
  const c = parseConsumptionCSV(csv);
  const s = sliceCurve(c, '2026-07-21', '2026-07-26', { endExclusive: true });
  assert.equal(s.days, 2);
  assert.deepEqual(s.byPeriod, { punta: 8, llano: 8, valle: 32 });
  assert.equal(sliceCurve(c, '2026-09-01', '2026-09-30'), null);
  const k = applyShare(277.224, s.share);
  close(k.punta + k.llano + k.valle, 277.224, 2e-3);
  close(k.valle, 277.224 * 32 / 48, 1e-3);
  assert.deepEqual(shiftToValle({ punta: 100, llano: 50, valle: 50 }, 0.5), { punta: 50, llano: 25, valle: 125 });
  close(energyCostES({ punta: 10, llano: 10, valle: 10 }, { single: 0.15 }), 4.5);
  close(energyCostES({ punta: 10, llano: 10, valle: 10 }, { punta: 0.2, llano: 0.1, valle: 0.05 }), 3.5);
});

test('sample curve matches the sample invoice: 744 hours, 277,2 kWh, 19/07 → 18/08/2026', { skip: !existsSync(resolve(__dirname, '../public/samples/consumo-horario-ejemplo.csv')) && 'run npm run samples:curve' }, () => {
  const c = parseConsumptionCSV(readFileSync(resolve(__dirname, '../public/samples/consumo-horario-ejemplo.csv'), 'utf8'));
  assert.equal(c.hours.length, 744);
  assert.equal(c.days, 31);
  close(c.totalKwh, 277.224, 0.05);
  assert.equal(c.start, '2026-07-19'); assert.equal(c.end, '2026-08-18');
  assert.ok(c.share.valle > 0.35 && c.share.valle < 0.5, `valle share ${c.share.valle}`);
  assert.deepEqual(c.warnings, []);
});

test('Endesa "área de clientes" export (metadata rows, ISO dates, hour ranges 00:00-01:00, Wh, € columns, Total row): CSV, legacy CSV, .xls and HTML-xls', async () => {
  const { readXlsRows, tableTextToRows } = await import('../public/lib/xls-lite.js');
  const { sheetRowsToCsv } = await import('../public/lib/xlsx-lite.js');
  const expect = (c, label) => {
    assert.equal(c.format, 'Endesa (área de clientes)', label);
    assert.equal(c.cups, 'ES0031600000000000AB0F', label);
    assert.equal(c.days, 3, label);
    assert.equal(c.totalKwh, 72, label);                                    // the € columns are never mistaken for the consumption
    assert.deepEqual(c.byPeriod, { punta: 16, llano: 16, valle: 40 }, label); // Mon + Tue: 8/8/8 each; Saturday 25: 24 valle
    assert.equal(c.start, '2026-07-20'); assert.equal(c.end, '2026-07-25');
    assert.equal(c.hours[0].hour, 0, label);                                // "00:00-01:00" = hour starting at 0 (not hour ending)
    assert.ok(!c.warnings.some((w) => /ignorado/.test(w)), `${label}: ${c.warnings}`); // metadata + Total rows are not "unreadable rows"
  };
  // current export: comma separated, ISO dates, Wh
  const cur = parseConsumptionCSV(readFileSync(resolve(__dirname, 'fixtures/endesa-clientes.csv'), 'utf8'));
  expect(cur, 'csv');
  assert.ok(cur.warnings.some((w) => /Wh convertidos/.test(w)));
  // legacy export: 5 info lines + title, ";" separated, DD/MM/YYYY, hour 0..23, kWh with decimal comma, Windows-1252
  const legacy = parseConsumptionCSV(new TextDecoder('windows-1252').decode(readFileSync(resolve(__dirname, 'fixtures/endesa-clientes-legacy.csv'))));
  expect(legacy, 'legacy');
  assert.deepEqual(legacy.warnings, []);
  // Excel 97-2003 with real date cells and the metadata rows on top
  const x = readFileSync(resolve(__dirname, 'fixtures/endesa-clientes.xls'));
  const xls = readXlsRows(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength));
  assert.equal(xls.sheet, 'Consumo');
  const csvFromXls = sheetRowsToCsv(xls.rows);
  assert.match(csvFromXls.split('\n')[5], /^Fecha;Hora;Consumo \(Wh\)/);        // header row detected below the metadata (blank row dropped)
  assert.match(csvFromXls.split('\n')[6], /^2026-07-20;00:00-01:00;1000;/);     // date serial rendered as a date
  expect(parseConsumptionCSV(csvFromXls), 'xls');
  // HTML table saved as .xls (layout table + data table)
  const all = tableTextToRows(readFileSync(resolve(__dirname, 'fixtures/endesa-clientes-html.xls'), 'utf8'), { all: true });
  expect(parseConsumptionCSV(sheetRowsToCsv(all[0].rows)), 'html');
  // hour-range spellings and a "Precio" column placed BEFORE the consumption
  const odd = 'Fecha;Precio (€/kWh);Hora;Consumo\n20/07/2026;0,20;de 00:00 a 01:00;2\n20/07/2026;0,20;01h - 02h;2\n20/07/2026;0,20;2-3;2\n20/07/2026;0,20;3 h;2';
  const o = parseConsumptionCSV(odd);
  assert.equal(o.totalKwh, 8);
  assert.deepEqual(o.hours.map((h) => h.hour), [0, 1, 2, 3]);
});
