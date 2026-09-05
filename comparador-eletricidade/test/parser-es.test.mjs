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
