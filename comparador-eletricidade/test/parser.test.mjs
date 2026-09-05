import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInvoiceText, ptNumber } from '../public/lib/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test('ptNumber handles Portuguese and plain formats', () => {
  assert.equal(ptNumber('0,166823'), 0.166823);
  assert.equal(ptNumber('1.234,56'), 1234.56);
  assert.equal(ptNumber('-5,24'), -5.24);
  assert.equal(ptNumber('3.45'), 3.45);      // kVA annotation "(3.45 kVA)"
  assert.equal(ptNumber('12.345'), 12345);   // meter reading with thousands separator
  assert.equal(ptNumber('157'), 157);
  assert.equal(ptNumber('26,19 €'), 26.19);
  assert.equal(ptNumber(''), null);
});

test('parses an Endesa simples invoice (2020 layout)', () => {
  const r = parseInvoiceText(fixture('endesa-2020.txt'));
  assert.equal(r.supplier, 'Endesa');
  assert.deepEqual(r.period, { start: '2020-06-01', end: '2020-07-01' });
  assert.equal(r.billedDays, 31);
  assert.equal(r.power, 3.45);
  assert.equal(r.option, 1);

  // Termo de Energia (Real)
  assert.equal(r.energy.kwh, 157);
  close(r.energy.byPeriod.simples.price, 0.166823);
  close(r.energy.amount, 26.19);
  close(r.energy.total, 20.95);
  close(r.energy.discount, -5.24);

  // Termo de Potência
  assert.equal(r.power_term.qty, 31);
  close(r.power_term.price, 0.0514);
  close(r.power_term.total, 1.25);
  assert.equal(r.power_term.kva, 3.45);
  assert.equal(r.power_term.iva, 23);

  // Termo Fixo Acesso às Redes
  assert.equal(r.tar.qty, 31);
  close(r.tar.price, 0.148);
  close(r.tar.total, 3.65);
  assert.equal(r.tar.iva, 6);
  close(r.powerPerDay, 0.1994);

  // Taxas
  close(r.cav.qty, 1.0164); close(r.cav.price, 2.85); close(r.cav.total, 2.9);
  close(r.dgeg.qty, 1.0164); close(r.dgeg.price, 0.07); close(r.dgeg.total, 0.07);
  assert.equal(r.iec.qty, 157); close(r.iec.price, 0.001); close(r.iec.total, 0.16);

  // Totais / IVA
  close(r.totals.energyTotal, 25.85);
  close(r.totals.taxesTotal, 8.68);
  close(r.totals.invoiceTotal, 34.53);
  close(r.totals.iva23Base, 22.43); close(r.totals.iva23, 5.16);
  close(r.totals.iva6Base, 6.55); close(r.totals.iva6, 0.39);

  assert.equal(r.items.length, 6, 'exactly the 6 billing lines');
  assert.ok(r.warnings.some((w) => /descontos comerciais/.test(w)));
});

test('parses the generated Endesa sample (pdf.js extraction)', () => {
  const r = parseInvoiceText(fixture('endesa-sample-extracted.txt'));
  assert.equal(r.supplier, 'Endesa');
  assert.equal(r.power, 3.45);
  assert.equal(r.option, 1);
  assert.equal(r.billedDays, 31);
  assert.equal(r.days, 31, 'period 03 ago a 02 set is 31 billed days (inclusive)');
  assert.equal(r.energy.kwh, 157);
  close(r.energy.byPeriod.simples.effectivePrice, 24.88 / 157);
  close(r.power_term.price, 0.1514);
  close(r.power_term.effectivePrice, 4.46 / 31);
  close(r.tar.price, 0.1718);
  close(r.cav.total, 2.9);
  close(r.dgeg.total, 0.07);
  close(r.iec.total, 0.16);
  // "TOTAL DA FATURA DE LUZ" wins over "TOTAL A PAGAR" (which includes a credit note)
  close(r.totals.invoiceTotal, 40.87);
  // the meter readings ("12.345 kWh"), the "Mecanismo DL 33/2022" and the footnote "0,0607 €/kWh" must not create lines
  assert.deepEqual(r.items.map((i) => i.id), ['energy', 'power', 'tar', 'cav', 'dgeg', 'iec']);
});

test('parses a bi-horária invoice with energy lines split by IVA tier', () => {
  const r = parseInvoiceText(fixture('edp-bihoraria-extracted.txt'));
  assert.equal(r.supplier, 'EDP Comercial');
  assert.equal(r.option, 2);
  assert.equal(r.power, 6.9);
  assert.deepEqual(r.period, { start: '2026-08-05', end: '2026-09-04' });
  assert.equal(r.days, 31);
  assert.equal(r.billedDays, 31);
  assert.deepEqual(Object.keys(r.energy.byPeriod).sort(), ['foraVazio', 'vazio']);
  close(r.energy.byPeriod.foraVazio.kwh, 245);
  close(r.energy.byPeriod.vazio.kwh, 168);
  close(r.energy.byPeriod.foraVazio.price, 0.1935);
  close(r.energy.byPeriod.vazio.price, 0.1119);
  assert.equal(r.energy.kwh, 413);
  close(r.power_term.price, 0.2344);
  close(r.tar.price, 0.3436);
  assert.equal(r.tar.iva, 23);
  close(r.iec.total, 0.41);
  close(r.totals.invoiceTotal, 101.5);
  close(r.totals.iva6, 2.16);
  close(r.totals.iva23, 11.84);
});

test('handles missing lines gracefully', () => {
  const r = parseInvoiceText('Fatura de eletricidade\nNada de útil aqui 12,00 €\n');
  assert.equal(r.items.length, 0);
  assert.equal(r.energy.kwh, null);
  assert.equal(r.power_term, null);
  assert.ok(r.warnings.length >= 2);
});

test('label variants used by other suppliers are recognised', () => {
  const txt = [
    'Período de faturação: 01/07/2026 - 31/07/2026',
    'Potência contratada 6,9 kVA · Tarifa bi-horária',
    'Energia Ativa Fora de Vazio 300 kWh 0,1800 € 54,00 € 23%',
    'Energia Ativa Vazio 200 kWh 0,1000 € 20,00 € 23%',
    'Potência contratada 6,9 kVA 31 dias 0,5000 € 15,50 € 23%',
    'Contribuição para o Audiovisual 1,0192 meses 2,85 € 2,90 € 6%',
    'Taxa de Exploração DGEG 1,0192 meses 0,07 € 0,07 € 23%',
    'Imposto Especial de Consumo (Estimado) 500 kWh 0,001 € 0,50 € 23%',
    'Total a pagar 120,00 €',
  ].join('\n');
  const r = parseInvoiceText(txt);
  assert.equal(r.option, 2);
  assert.equal(r.power, 6.9);
  assert.equal(r.days, 31);
  assert.equal(r.energy.kwh, 500);
  close(r.energy.byPeriod.foraVazio.price, 0.18);
  close(r.energy.byPeriod.vazio.price, 0.1);
  assert.equal(r.power_term.qty, 31);
  close(r.power_term.price, 0.5);
  assert.equal(r.tar, null, 'no separate TAR line -> power price is all-in');
  close(r.cav.total, 2.9);
  close(r.dgeg.total, 0.07);
  close(r.iec.total, 0.5);
  close(r.totals.invoiceTotal, 120);
});
