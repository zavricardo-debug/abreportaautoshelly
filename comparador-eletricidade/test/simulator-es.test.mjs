import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateES, simulateAllES, splitConsumption, compareLinesES, cnmcLink, offerApplicableES, RULES_ES_2026 } from '../public/lib/simulator-es.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const datasetPath = resolve(__dirname, '../public/data/ofertas-es.json');
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

// The user's real bill (Endesa, Libre Endesa, 19/07/2026 – 19/08/2026)
const bill = {
  profile: { days: 31, power: { p1: 4.6, p2: 4.6 }, kwh: splitConsumption(277.224, { punta: 97, llano: 60, valle: 119 }), meterRentPerDay: 0.026774 },
  prices: { energy: { single: 0.167283 }, power: { p1: 0.117686, p2: 0.041554 } },
};

test('rebuilds the Endesa bill to the cent (89,84 €)', () => {
  const s = simulateES(bill.profile, bill.prices);
  assert.equal(s.powerP1, 16.78);
  assert.equal(s.powerP2, 5.93);
  assert.equal(s.energyAmount, 46.37);
  assert.equal(s.bonoSocial, 0.77);
  assert.equal(s.meterRent, 0.83);
  assert.equal(s.ieBase, 69.85);      // potencia + energía + bono social (alquiler excluido)
  assert.equal(s.ie, 3.57);
  assert.equal(s.ivaBase, 74.25);     // + impuesto + alquiler
  assert.equal(s.iva, 15.59);
  assert.equal(s.total, 89.84);
  assert.deepEqual(s.lines.map((l) => l.id), ['power_p1', 'power_p2', 'energy_single', 'bono_social', 'meter_rent', 'ie', 'iva', 'total']);
});

test('splitConsumption follows the readings, else the default 2.0TD profile', () => {
  const k = splitConsumption(277.224, { punta: 97, llano: 60, valle: 119 });
  close(k.punta + k.llano + k.valle, 277.224);
  close(k.punta / k.valle, 97 / 119);
  const d = splitConsumption(100, null);
  close(d.punta, 30); close(d.llano, 26); close(d.valle, 44);
});

test('3-period offer, indexed fee and per-kWh extras are billed in the right tax base', () => {
  const s3 = simulateES(bill.profile, { energy: { punta: 0.2, llano: 0.15, valle: 0.1 }, power: { p1: 0.1, p2: 0.05 } });
  assert.equal(s3.single, false);
  assert.equal(s3.lines.filter((l) => l.group === 'energy').length, 3);
  close(s3.energyAmount, Math.round((bill.profile.kwh.punta * 0.2) * 100) / 100 + Math.round((bill.profile.kwh.llano * 0.15) * 100) / 100 + Math.round((bill.profile.kwh.valle * 0.1) * 100) / 100, 0.011);
  const idx = simulateES(bill.profile, { energy: { single: 0.2 }, power: { p1: 0.076, p2: 0.002 }, feePerDay: 0.123, extraPerKwh: 0.00266, extraLabel: 'SNOEE' });
  assert.equal(idx.fee, 3.81);
  assert.equal(idx.extra, 0.74);
  assert.ok(idx.lines.some((l) => l.id === 'fee') && idx.lines.some((l) => l.id === 'extra' && l.label === 'SNOEE'));
  // IE base includes fee + extra + bono social, not the meter rent
  close(idx.ieBase, idx.powerAmount + idx.energyAmount + idx.fee + idx.extra + idx.bonoSocial, 0.006);
  close(idx.ivaBase, idx.ieBase + idx.ie + idx.meterRent, 0.006);
  // minimum IE of 1 €/MWh applies when the rate gives less
  const tiny = simulateES({ days: 30, power: { p1: 1, p2: 1 }, kwh: { punta: 0, llano: 0, valle: 1000 } }, { energy: { single: 0.001 }, power: { p1: 0, p2: 0 } });
  assert.equal(tiny.ie, 1);
});

test('compareLinesES gives the delta of every concept', () => {
  const base = simulateES(bill.profile, bill.prices);
  const other = simulateES(bill.profile, { energy: { single: 0.109 }, power: { p1: 0.093666, p2: 0.093666 } });
  const rows = compareLinesES(base, other);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.power_p1.base, 16.78); assert.equal(by.power_p2.base, 5.93);
  assert.equal(by.energy.base, 46.37);
  assert.equal(by.bono_social.diff, 0); assert.equal(by.meter_rent.diff, 0);
  assert.equal(by.total.other, other.total);
  close(by.total.diff, other.total - base.total, 0.006);
  assert.ok(!('fee' in by), 'fee row hidden when neither side has one');
});

test('cnmcLink annualises the consumption and carries the power', () => {
  const url = new URL(cnmcLink(bill.profile, { postalCode: '28001', periodStart: '2026-07-19' }));
  assert.equal(url.origin + url.pathname, 'https://comparador.cnmc.gob.es/comparador/QRE');
  assert.equal(url.searchParams.get('cp'), '28001');
  assert.equal(url.searchParams.get('pP1'), '4.6');
  assert.equal(url.searchParams.get('pP2'), '4.6');
  assert.equal(url.searchParams.get('caP1'), String(Math.round(bill.profile.kwh.punta * 365 / 31)));
  assert.equal(url.searchParams.get('iniA'), '2026-07-19');
  assert.equal(url.searchParams.get('tc'), 'F0');
});

test('dataset ofertas-es.json is consistent and the market beats the bill', { skip: !existsSync(datasetPath) && 'dataset missing' }, () => {
  const ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
  assert.equal(ds.meta.offers, ds.offers.length);
  assert.equal(ds.meta.suppliers, ds.suppliers.length);
  const codes = new Set(ds.suppliers.map((s) => s.code));
  const ids = new Set();
  for (const o of ds.offers) {
    assert.ok(codes.has(o.supplierCode), `${o.id}: unknown supplier ${o.supplierCode}`);
    assert.ok(!ids.has(o.id), `${o.id} duplicated`); ids.add(o.id);
    assert.ok(o.power.p1 > 0.01 && o.power.p1 < 0.2, `${o.id}: power p1 ${o.power.p1} must be €/kW·día`);
    assert.ok(o.power.p2 >= 0 && o.power.p2 < 0.2, `${o.id}: power p2`);
    const e = o.energy.single ?? o.energy.punta;
    assert.ok(e > 0.05 && e < 0.4, `${o.id}: energy price ${e} must be €/kWh sin impuestos`);
    if (o.energy.punta != null) assert.ok(o.energy.punta >= o.energy.llano && o.energy.llano >= o.energy.valle, `${o.id}: punta ≥ llano ≥ valle`);
    assert.ok(o.source?.url && o.source?.date, `${o.id}: source required`);
    assert.ok(offerApplicableES(o, bill.profile) || o.maxPower < 4.6, `${o.id} should apply to a 4,6 kW / 3.264 kWh-year profile`);
  }
  assert.deepEqual(ds.rules.iva, RULES_ES_2026.iva);
  const res = simulateAllES(ds, bill.profile);
  const base = simulateES(bill.profile, bill.prices);
  assert.ok(res.length >= 15);
  assert.ok(res[0].sim.total < base.total - 10, `best offer ${res[0].offer.id} ${res[0].sim.total} should be clearly cheaper than 89,84`);
  for (let i = 1; i < res.length; i++) assert.ok(res[i - 1].sim.total <= res[i].sim.total, 'sorted by total');
  const promo = res.find((r) => r.offer.after);
  assert.ok(promo.simAfter.total > promo.sim.total, 'post-promo price is higher');
  const noPromo = simulateAllES(ds, bill.profile, { includePromo: false }).find((r) => r.offer.id === promo.offer.id);
  assert.equal(noPromo.sim.total, promo.simAfter.total);
});
