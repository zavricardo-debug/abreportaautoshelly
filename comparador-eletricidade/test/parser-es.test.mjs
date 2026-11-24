import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInvoiceTextES, detectCountry } from '../public/lib/parser-es.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('detectCountry tells Spanish and Portuguese bills apart', () => {
  assert.equal(detectCountry(fixture('endesa-es-2026.txt')).country, 'ES');
  assert.equal(detectCountry(fixture('endesa-2020.txt')).country, 'PT');
  assert.equal(detectCountry('Termo de Energia (Real) 157 kWh 0,166823 € 26,19 € IVA 6%').country, 'PT');
  assert.equal(detectCountry('Potencia P1 4,6 kW x 0,11 Eur/kW x 30 días Impuesto electricidad IVA normal 21 %').country, 'ES');
});

test('parses the Endesa (Libre Endesa, 2.0TD) bill: every cost line', () => {
  const r = parseInvoiceTextES(fixture('endesa-es-2026.txt'));
  assert.equal(r.country, 'ES');
  assert.equal(r.supplier, 'Endesa');
  assert.equal(r.supplierCode, 'ENDESA');
  assert.equal(r.contractName, 'Libre Endesa');
  assert.equal(r.regulated, false);
  assert.deepEqual(r.period, { start: '2026-07-19', end: '2026-08-19' });
  assert.equal(r.days, 31);
  assert.deepEqual(r.power, { p1: 4.6, p2: 4.6 });

  // Potencia P1 (Punta-Llano) 4,600 kW x 0,117686 Eur/kW x 31 días = 16,78 €
  assert.equal(r.powerTerm.p1.kw, 4.6);
  assert.equal(r.powerTerm.p1.days, 31);
  close(r.powerTerm.p1.price, 0.117686);              // unit price exactly as printed on the bill (reproduces 16,78 €)
  assert.equal(r.powerTerm.p1.amount, 16.78);
  // Pot. P3 4,600 kW x 0,041554 Eur/kW x 31 días = 5,93 €
  assert.equal(r.powerTerm.p2.kw, 4.6);
  close(r.powerTerm.p2.price, 0.041554);
  assert.equal(r.powerTerm.p2.amount, 5.93);
  assert.equal(r.powerTerm.amount, 22.71);

  // Consumo 277,224 kWh x 0,167283 Eur/kWh = 46,37 €
  assert.equal(r.energy.single, true);
  assert.equal(r.energy.kwh, 277.224);
  close(r.energy.price, 0.167283);
  assert.equal(r.energy.amount, 46.37);
  assert.deepEqual(r.energy.readings, { punta: 97, llano: 60, valle: 119 });

  // Financiación Bono Social 31 días x 0,024688 Eur/día = 0,77 €
  assert.deepEqual(r.bonoSocial, { days: 31, price: 0.024688, amount: 0.77 });
  // Alquiler del contador (31 días x 0,026774 Eur/día) = 0,83 €
  assert.deepEqual(r.meterRent, { days: 31, price: 0.026774, amount: 0.83 });
  // Impuesto electricidad (69,85 Eur X 5,1126963 %) = 3,57 €
  assert.equal(r.ie.base, 69.85);
  close(r.ie.rate, 0.051126963);
  assert.equal(r.ie.amount, 3.57);
  // IVA normal 21 % s/ 74,25 = 15,59 €
  assert.equal(r.iva.tax, 'IVA');
  assert.equal(r.iva.rate, 0.21);
  assert.equal(r.iva.base, 74.25);
  assert.equal(r.iva.amount, 15.59);
  // TOTAL 89,84 €
  assert.equal(r.total, 89.84);

  assert.deepEqual(r.items.map((i) => i.id), ['power', 'power', 'energy', 'bonoSocial', 'meterRent', 'ie', 'iva']);
  assert.deepEqual(r.warnings, []);
});

test('parses a 3-period bill with yearly power prices and long dates (Iberdrola-like layout)', () => {
  const text = `Iberdrola Clientes, S.A.U. Factura de electricidad
Periodo de facturación: del 1 de julio de 2026 al 31 de julio de 2026 (30 días)
Potencia contratada punta 3,45 kW valle 3,45 kW
Término de potencia punta 3,45 kW x 30 días x 34,187694 €/kW año 9,69 €
Término de potencia valle 3,45 kW x 30 días x 1,143132 €/kW año 0,32 €
Energía punta 80 kWh x 0,194000 €/kWh 15,52 €
Energía llano 70 kWh x 0,136000 €/kWh 9,52 €
Energía valle 120 kWh x 0,099990 €/kWh 12,00 €
Financiación del bono social 30 días x 0,024688 €/día 0,74 €
Alquiler de equipos de medida 30 días x 0,026774 €/día 0,80 €
Impuesto especial sobre la electricidad 5,11269632 % s/ 47,79 € 2,44 €
IVA 21 % s/ 51,03 € 10,72 €
TOTAL IMPORTE FACTURA 61,75 €`;
  const r = parseInvoiceTextES(text);
  assert.equal(r.supplier, 'Iberdrola');
  assert.deepEqual(r.period, { start: '2026-07-01', end: '2026-07-31' });
  assert.deepEqual(r.power, { p1: 3.45, p2: 3.45 });
  assert.equal(r.powerTerm.p1.days, 30);
  close(r.powerTerm.p1.price, 34.187694 / 365);       // yearly €/kW converted to €/kW·día (reproduces 9,69 €)
  assert.equal(r.powerTerm.p2.amount, 0.32);
  assert.equal(r.energy.single, false);
  assert.equal(r.energy.kwh, 270);
  close(r.energy.byPeriod.punta.price, 0.194);
  close(r.energy.byPeriod.llano.price, 0.136);
  close(r.energy.byPeriod.valle.price, 0.09999);
  assert.equal(r.energy.amount, 37.04);
  assert.deepEqual(r.energy.consumption, { punta: 80, llano: 70, valle: 120 });
  assert.equal(r.bonoSocial.amount, 0.74);
  assert.equal(r.meterRent.amount, 0.8);
  assert.equal(r.ie.amount, 2.44);
  assert.equal(r.iva.amount, 10.72);
  assert.equal(r.total, 61.75);
  assert.deepEqual(r.warnings, []);
});

test('reports missing lines instead of guessing', () => {
  const r = parseInvoiceTextES('Factura de luz\nPotencia contratada: 4,6 kW\nConsumo 200 kWh x 0,15 €/kWh 30,00 €\nTOTAL 45,00 €');
  assert.equal(r.energy.kwh, 200);
  assert.equal(r.total, 45);
  assert.equal(r.powerTerm.p1, null);
  assert.ok(r.warnings.some((w) => /potencia \(kW/.test(w)));
  assert.ok(r.warnings.some((w) => /Bono Social/.test(w)));
  assert.ok(r.warnings.some((w) => /periodo/.test(w)));
});

test('full multi-page bill: informative lines, section subtotals and the printed copy of the detail do not double count', () => {
  const text = `endesa
FACTURA DE ELECTRICIDAD
Periodo de facturación: del 19/07/2026 a 19/08/2026 (31 días)
RESUMEN DE LA FACTURA
Potencia 22,71 €
Energía 46,37 €
Varios 1,60 €
Impuestos 19,16 €
TOTAL IMPORTE FACTURA 89,84 €
Consumo medio diario 8,94 kWh Coste medio diario 2,90 €
Consumo del periodo: 277 kWh
Consumo anual estimado: 3.300 kWh
Consumo mismo periodo año anterior 301 kWh 52,10 €
Punta 97 kWh 35 %
Llano 60 kWh 22 %
Valle 119 kWh 43 %
Potencia contratada: punta 4,600 kW valle 4,600 kW
DETALLE DE LA FACTURA
P1 (Punta-Llano) 4,600 kW x 0,117686 Eur/kW x 31 días 16,78 €
Pot. P3 4,600 kW x 0,041554 Eur/kW x 31 días 5,93 €
Consumo 277,224 kWh x 0,167283 Eur/kWh 46,37 €
Financiación Bono Social 31 días x 0,024688 Eur/día 0,77 €
Alquiler del contador ( 31 días x 0,026774 Eur/día ) 0,83 €
Impuesto electricidad ( 69,85 Eur X 5,1126963 %) 3,57 €
IVA normal 21 % s/ 74,25 15,59 €
TOTAL 89,84 €
COPIA – DETALLE DE LA FACTURA
P1 (Punta-Llano) 4,600 kW x 0,117686 Eur/kW x 31 días 16,78 €
Pot. P3 4,600 kW x 0,041554 Eur/kW x 31 días 5,93 €
Consumo 277,224 kWh x 0,167283 Eur/kWh 46,37 €
Financiación Bono Social 31 días x 0,024688 Eur/día 0,77 €
Alquiler del contador ( 31 días x 0,026774 Eur/día ) 0,83 €
Impuesto electricidad ( 69,85 Eur X 5,1126963 %) 3,57 €
IVA normal 21 % s/ 74,25 15,59 €
TOTAL 89,84 €`;
  const r = parseInvoiceTextES(text);
  assert.equal(r.days, 31);
  assert.equal(r.powerTerm.amount, 22.71);
  close(r.powerTerm.p1.price, 0.117686);
  assert.equal(r.energy.kwh, 277.224);
  assert.equal(r.energy.amount, 46.37);
  assert.deepEqual(r.energy.readings, { punta: 97, llano: 60, valle: 119 });
  assert.equal(r.bonoSocial.amount, 0.77);
  assert.equal(r.meterRent.amount, 0.83);
  assert.equal(r.ie.amount, 3.57);
  assert.equal(r.iva.amount, 15.59);
  assert.equal(r.total, 89.84);
  assert.deepEqual(r.subtotals, { potencia: 22.71, energia: 46.37, varios: 1.6, impuestos: 19.16 });
  assert.equal(r.duplicatesSkipped, 7);
  assert.deepEqual(r.items.map((i) => i.id), ['power', 'power', 'energy', 'bonoSocial', 'meterRent', 'ie', 'iva']);
  assert.ok(r.warnings.every((w) => /repetidas/.test(w)), r.warnings.join(' | '));
});

test('discounts of the current tariff and optional services are read as separate cost lines', () => {
  const text = `Naturgy Iberia Factura de electricidad
Periodo: 01/06/2026 - 30/06/2026
Potencia contratada: 4,6 kW
Término de potencia punta 4,6 kW x 0,105 €/kW día x 30 días 14,49 €
Término de potencia valle 4,6 kW x 0,045 €/kW día x 30 días 6,21 €
Consumo 300 kWh x 0,150 €/kWh 45,00 €
Descuento 10% en energía -4,50 €
Servicio Mantenimiento Servihogar 5,00 €
Financiación Bono Social 30 días x 0,024688 €/día 0,74 €
Alquiler de equipos de medida 30 días x 0,026774 €/día 0,80 €
Impuesto sobre la electricidad 5,11269632 % s/ 61,94 € 3,17 €
IVA 21 % s/ 70,91 € 14,89 €
TOTAL IMPORTE FACTURA 85,80 €`;
  const r = parseInvoiceTextES(text);
  assert.equal(r.powerTerm.amount, 20.7);
  assert.equal(r.energy.amount, 45);
  assert.deepEqual(r.discounts, [{ label: 'Descuento 10% en energía', amount: -4.5 }]);
  assert.equal(r.discountAmount, -4.5);
  assert.deepEqual(r.services, [{ label: 'Servicio Mantenimiento Servihogar', amount: 5 }]);
  assert.equal(r.serviceAmount, 5);
  assert.equal(r.total, 85.8);
  assert.ok(r.items.some((i) => i.id === 'discount') && r.items.some((i) => i.id === 'service'));
  assert.ok(r.warnings.some((w) => /Descuentos de su tarifa/.test(w)));
  assert.ok(r.warnings.some((w) => /Servicios adicionales/.test(w)));
});

test('figures of a neighbouring column (chart labels, summary box) glued to the end of a detail line do not replace its amount', () => {
  // two-column page: the € labels of the "evolución de sus facturas" chart share the vertical position of the detail lines
  const text = `P1 (Punta-Llano) 4,600 kW x 0,117686 Eur/kW x 31 días........16,78 € 88,10 €
Pot. P3 4,600 kW x 0,041554 Eur/kW x 31 días........5,93 €
Energía 46,37 €.......... 51,02 €
Consumo 277,224 kWh x 0,167283 Eur/kWh........ 46,37 € 46,40 €
Financiación Bono Social 31 días x 0,024688 Eur/día...... 0,77 €
Alquiler del contador ( 31 días x 0,026774 Eur/día )..... 0,83 € 47,23 €
Impuesto electricidad ( 69,85 Eur X 5,1126963 %)...... 3,57 € 47,23 €
IVA normal 21 % s/ 74,25.............. 15,59 € 12,00 €
Periodo 19/07/2026 19/08/2026
Punta 7.161,000 7.258,000 1,00 0,000 97,000 55,10 €
Llano 6.746,000 6.806,000 1,00 0,000 60,000
Valle 11.006,000 11.125,000 1,00 0,000 119,000
TOTAL 89,84 € 91,20 €`;
  const p = parseInvoiceTextES(text);
  assert.equal(p.powerTerm.p1.amount, 16.78);
  assert.equal(p.energy.amount, 46.37);
  assert.equal(p.energy.byPeriod.single.price, 0.167283);
  assert.equal(p.meterRent.amount, 0.83);
  assert.equal(p.bonoSocial.amount, 0.77);
  assert.equal(p.ie.amount, 3.57); assert.equal(p.ie.base, 69.85);
  assert.equal(p.iva.amount, 15.59); assert.equal(p.iva.base, 74.25);
  assert.equal(p.total, 89.84);
  assert.deepEqual(p.energy.readings, { punta: 97, llano: 60, valle: 119 });
  assert.equal(p.subtotals.energia, 46.37);
  assert.ok(!p.warnings.some((w) => /no coincide/.test(w)), p.warnings.join(' | '));
});

test('parses the Gana Energía ("Tarifa 24 horas", 2.0TD) bill template: table layout with plain € prices, P1/P2/P3 labels, SNOEE line, summary box', () => {
  // Layout: "Del 20-10-2026 al 19-11-2026 (Total 31 días) P1: 4,6 kW 0,089434€ 12,75€" (power, price printed as a plain €),
  // "… P1: 65 kWh 0,129000 € 8,38 € P1 De lunes a viernes…" (energy, glossary column glued to the line),
  // "B. Social Orden TED/634/2026 0,77 €", "Aportación Regulada … Eficiencia Energética 0,95 €",
  // "Impuesto Eléctrico" + "5,112696% sobre 72,75x1,00 3,72 €" (heading and figures on separate lines),
  // summary box repeating the taxes, readings "P1 7386,00kWh 7451,00kWh 65,00kWh", "Potencia contratada: P1 4,6kW, P2 4,6kW".
  const r = parseInvoiceTextES(fixture('gana-es-2026.txt'));
  assert.equal(r.country, 'ES');
  assert.equal(r.supplier, 'Gana Energía', 'the distribuidora "EDP - Hidrocantábrico" must not be taken for the comercializadora');
  assert.equal(r.supplierCode, 'GANA');
  assert.equal(r.contractName, 'Tarifa 24 horas');
  assert.equal(r.regulated, false);
  assert.equal(r.postalCode, '33208', 'supply point postal code, not the registered office (46004)');
  assert.deepEqual(r.period, { start: '2026-10-20', end: '2026-11-19' });
  assert.equal(r.days, 31);
  assert.deepEqual(r.power, { p1: 4.6, p2: 4.6 });

  // potencia: 2 × (4,6 kW × 0,089434 €/kW·día × 31 días = 12,75 €)
  assert.equal(r.powerTerm.p1.kw, 4.6); assert.equal(r.powerTerm.p1.days, 31);
  close(r.powerTerm.p1.price, 0.089434); assert.equal(r.powerTerm.p1.amount, 12.75);
  assert.equal(r.powerTerm.p2.kw, 4.6); close(r.powerTerm.p2.price, 0.089434); assert.equal(r.powerTerm.p2.amount, 12.75);
  assert.equal(r.powerTerm.amount, 25.5);

  // energía: P1 65 kWh 8,38 € · P2 72 kWh 9,29 € · P3 216 kWh 27,86 € (all at 0,129000 €/kWh) = 353 kWh, 45,53 €
  assert.equal(r.energy.single, false);
  assert.equal(r.energy.kwh, 353);
  assert.equal(r.energy.amount, 45.53);
  assert.deepEqual(Object.fromEntries(Object.entries(r.energy.byPeriod).map(([k, v]) => [k, [v.kwh, v.amount]])), { punta: [65, 8.38], llano: [72, 9.29], valle: [216, 27.86] });
  for (const k of ['punta', 'llano', 'valle']) close(r.energy.byPeriod[k].price, 0.129);
  assert.deepEqual(r.energy.readings, { punta: 65, llano: 72, valle: 216 });
  assert.deepEqual(r.energy.consumption, { punta: 65, llano: 72, valle: 216 });

  // otros conceptos: B. Social 0,77 € · Alquiler de equipos 31 días 0,83 € · SNOEE 0,95 € (= 2,55 €)
  assert.equal(r.bonoSocial.amount, 0.77); assert.equal(r.bonoSocial.days, 31);
  assert.equal(r.meterRent.amount, 0.83); assert.equal(r.meterRent.days, 31);
  assert.equal(r.fees.length, 1);
  assert.match(r.fees[0].label, /Eficiencia Energética/);
  assert.equal(r.feeAmount, 0.95);
  assert.equal(r.discountAmount, 0); assert.equal(r.serviceAmount, 0);

  // impuestos: IE 5,112696 % sobre 72,75 = 3,72 € · IVA 21 % sobre 77,30 = 16,23 € · total 93,53 €
  assert.equal(r.ie.amount, 3.72); assert.equal(r.ie.base, 72.75); close(r.ie.rate, 0.05112696);
  assert.equal(r.iva.amount, 16.23); assert.equal(r.iva.base, 77.3); assert.equal(r.iva.rate, 0.21); assert.equal(r.iva.tax, 'IVA');
  assert.equal(r.total, 93.53);
  assert.deepEqual(r.subtotals, { potencia: 25.5, energia: 45.53, otros: 2.55, 'base imponible': 77.3 });
  // the summary box ("Impuesto Eléctrico (5,112696%) 3,72€", "IVA (21%) 16,23€") does not double count the taxes
  assert.equal(r.items.filter((i) => i.id === 'ie').length, 2);
  assert.equal(r.items.filter((i) => i.id === 'power').length, 2);
  assert.equal(r.items.filter((i) => i.id === 'energy').length, 3);
  const sum = +(r.powerTerm.amount + r.energy.amount + r.bonoSocial.amount + r.meterRent.amount + r.feeAmount + r.ie.amount + r.iva.amount).toFixed(2);
  assert.equal(sum, 93.53, 'every € of the bill is identified');
  assert.deepEqual(r.warnings, []);
});

test('Gana-style lines in isolation: glued units, price as a plain €, period label before the figure, readings glued to a chart legend', () => {
  const p = parseInvoiceTextES(`Potencia contratada: P1 3,45kW, P2 5,75kW
Del 01-02-2026 al 28-02-2026 (Total 28 días) P1: 3,45 kW 0,089434€ 8,64€
Del 01-02-2026 al 28-02-2026 (Total 28 días) P2: 5,75 kW 0,041554€ 6,69€ Periodos de energía:
Del 01-02-2026 al 28-02-2026 (Total 28 días) P1: 100 kWh 0,150000 € 15,00 € P1 De lunes a viernes: de 10:00h a 14:00
Del 01-02-2026 al 28-02-2026 (Total 28 días) P2: 50 kWh 0,140000 € 7,00 €
Del 01-02-2026 al 28-02-2026 (Total 28 días) P3: 200 kWh 0,100000 € 20,00 € Periodo Llano
B. Social Orden TED/634/2026 0,69 € P3 De lunes a viernes: de 00:00 a 08:00
Alquiler de Equipos del 01-02-2026 al 28-02-2026 28 días 0,75 €
Impuesto Eléctrico La potencia también se divide en
5,112696% sobre 58,02x1,00 2,97 € franjas: P1
IVA
21% sobre Base imponible 61,74€ 12,97 € festivos).
Total importe factura 74,71 €
P1 1000,00kWh 1100,00kWh 100,00kWh
0,85% Alquiler de contador P2 2000,00kWh 2050,00kWh 50,00kWh
P3 3000,00kWh 3200,00kWh 200,00kWh`);
  assert.deepEqual(p.power, { p1: 3.45, p2: 5.75 });
  assert.equal(p.powerTerm.p1.amount, 8.64); close(p.powerTerm.p1.price, 0.089434); assert.equal(p.powerTerm.p1.days, 28);
  assert.equal(p.powerTerm.p2.amount, 6.69); close(p.powerTerm.p2.price, 0.041554);
  assert.deepEqual(Object.fromEntries(Object.entries(p.energy.byPeriod).map(([k, v]) => [k, [v.kwh, v.price, v.amount]])), { punta: [100, 0.15, 15], llano: [50, 0.14, 7], valle: [200, 0.1, 20] });
  assert.deepEqual(p.energy.readings, { punta: 100, llano: 50, valle: 200 });
  assert.equal(p.bonoSocial.amount, 0.69); assert.equal(p.bonoSocial.days, 28);
  assert.equal(p.meterRent.amount, 0.75);
  assert.equal(p.ie.amount, 2.97); assert.equal(p.ie.base, 58.02);
  assert.equal(p.iva.amount, 12.97); assert.equal(p.iva.base, 61.74);
  assert.equal(p.total, 74.71);
  assert.equal(p.days, 28);
});

test('supplier detection: the most mentioned comercializadora wins, the distribuidora is ignored', () => {
  assert.equal(parseInvoiceTextES('Factura Gana Energía\nDistribuidora: EDP - HIDROCANTABRICO DIST. ELECTRICA S.A.U.\nclientes@ganaenergia.com\nTotal 10,00 €').supplierCode, 'GANA');
  assert.equal(parseInvoiceTextES('EDP Comercializadora S.A.U.\nDistribuidora: i-DE Redes Eléctricas Inteligentes (Iberdrola)\nTotal 10,00 €').supplierCode, 'EDP');
  assert.equal(parseInvoiceTextES('Energía XXI Comercializadora de Referencia (grupo Endesa) PVPC\nTotal 10,00 €').supplierCode, 'PVPC');
});

test('Endesa document with a separate "factura de servicios" (Protección 360) and a "resumen total de las facturas": electricity figures stay clean', () => {
  // Real layout: electricity invoice (89,84 €) + services invoice (4,78 € + IVA 1,00 € = 5,78 €) + summary "Total importe a pagar 95,62 €";
  // the readings table is glued to the end of the legal text lines, the chart legend ("> 21,33% Impuestos") to the detail lines.
  const r = parseInvoiceTextES(fixture('endesa-es-2026-servicios.txt'));
  assert.equal(r.supplierCode, 'ENDESA');
  assert.equal(r.contractName, 'Libre Endesa', '"Segmento de cargos: 1" of the same row is not part of the name');
  assert.equal(r.postalCode, '33208');
  assert.deepEqual(r.period, { start: '2026-07-19', end: '2026-08-19' }); assert.equal(r.days, 31);
  assert.deepEqual(r.power, { p1: 4.6, p2: 4.6 });
  assert.equal(r.powerTerm.amount, 22.71); assert.equal(r.energy.amount, 46.37); assert.equal(r.energy.kwh, 277.224);
  assert.equal(r.energy.single, true); close(r.energy.price, 0.167283);
  assert.deepEqual(r.energy.readings, { punta: 97, llano: 60, valle: 119 }, 'readings glued to the legal text are still read');
  assert.equal(r.bonoSocial.amount, 0.77); assert.equal(r.meterRent.amount, 0.83);
  assert.equal(r.ie.amount, 3.57); assert.equal(r.ie.base, 69.85);
  assert.equal(r.iva.amount, 15.59, 'the IVA of the services invoice (1,00 €) is not added to the electricity IVA');
  assert.equal(r.iva.base, 74.25);
  assert.equal(r.total, 89.84, 'total of the electricity invoice');
  assert.equal(r.totalToPay, 95.62, 'grand total of the document');
  assert.deepEqual(r.servicesInvoice, { lines: [{ label: 'Protección 360 Plus', amount: 4.78, invoice: 'services' }], amount: 4.78, iva: 1, total: 5.78 });
  assert.equal(r.serviceAmount, 4.78);
  assert.deepEqual(r.subtotals, { potencia: 22.71, energia: 46.37, otros: 1.6, impuestos: 19.16, varios: 1.6 });
  assert.deepEqual(r.items.map((i) => i.id), ['power', 'power', 'energy', 'bonoSocial', 'meterRent', 'ie', 'iva', 'service', 'servicesIva']);
  assert.ok(!r.warnings.some((w) => /no coincide/.test(w)), r.warnings.join(' | '));
  assert.ok(r.warnings.some((w) => /factura de servicios aparte/.test(w) && /95,62/.test(w)));
  // the anonymised fixture of the same bill without the services pages gives the same electricity figures
  const e = parseInvoiceTextES(fixture('endesa-es-2026.txt'));
  assert.equal(e.total, 89.84); assert.equal(e.totalToPay, null); assert.equal(e.servicesInvoice, null);
});
