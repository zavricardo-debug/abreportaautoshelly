import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate, simulateAll, baselinePrices, offerPrices, nearestStandardPower, RULES_2026 } from '../public/lib/simulator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const close = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('nearestStandardPower snaps to the ERSE power steps', () => {
  assert.equal(nearestStandardPower(3.45), 3.45);
  assert.equal(nearestStandardPower(3.5), 3.45);
  assert.equal(nearestStandardPower(6.8), 6.9);
  assert.equal(nearestStandardPower(null), null);
});

test('reproduces the Endesa sample invoice (3,45 kVA, simples, 157 kWh, 31 days)', () => {
  // prices after the 5 % digital discount, as printed on the sample
  const form = { option: 1, energyPrice: [24.88 / 157], powerPrice: 4.46 / 31, tarPrice: 0.1718 };
  const sim = simulate({ power: 3.45, option: 1, days: 31, kwh: [157] }, baselinePrices(form));
  close(sim.energy.amount, 24.88);
  close(sim.powerTerm.tarAmount, 5.33);
  close(sim.powerTerm.supplierAmount, 4.46);
  close(sim.cav, 2.9);
  close(sim.dgeg, 0.07);
  close(sim.iec, 0.16);
  // 157 kWh in 31 days is below 206,7 kWh -> all energy at 6 %
  assert.equal(sim.energy.reducedShare, 1);
  close(sim.base6, 24.88 + 5.33 + 2.9);
  close(sim.base23, 4.46 + 0.07 + 0.16);
  close(sim.iva6, 1.99);
  close(sim.iva23, 1.08);
  close(sim.total, 40.87);
});

test('reproduces the EDP bi-horária sample (6,9 kVA, 413 kWh, 31 days)', () => {
  const form = { option: 2, energyPrice: [0.1935, 0.1119], powerPrice: 0.2344, tarPrice: 0.3436 };
  const sim = simulate({ power: 6.9, option: 2, days: 31, kwh: [245, 168] }, baselinePrices(form));
  close(sim.energy.amount, 66.21);
  close(sim.energy.reducedShare, 200 * 31 / 30 / 413, 1e-9);
  close(sim.powerTerm.amount, 17.92);
  // 6,9 kVA -> TAR fixed at 23 %
  close(sim.base6, 66.21 * sim.energy.reducedShare + 2.9);
  close(sim.iva6, 2.16);
  close(sim.iva23, 11.84);
  close(sim.total, 101.5, 0.03); // the printed bill rounds the kWh split per line
});

test('IVA rules: ≥ 10,35 kVA everything at 23 %, large family 300 kWh', () => {
  const big = simulate({ power: 10.35, option: 1, days: 30, kwh: [150] }, { tf: 0.7, energy: [0.16] });
  assert.equal(big.energy.reducedShare, 0);
  close(big.base6, big.cav);
  const fam = simulate({ power: 6.9, option: 1, days: 30, kwh: [300], largeFamily: true }, { tf: 0.5, energy: [0.16] });
  assert.equal(fam.energy.reducedShare, 1);
  const noFam = simulate({ power: 6.9, option: 1, days: 30, kwh: [300] }, { tf: 0.5, energy: [0.16] });
  close(noFam.energy.reducedShare, 200 / 300, 1e-9);
  assert.ok(noFam.total > fam.total);
});

test('extras: services, refunds and new-client discount are pro-rated per day', () => {
  const profile = { power: 6.9, option: 1, days: 365, kwh: [3000] };
  const prices = { tf: 0.5, energy: [0.16] };
  const plain = simulate(profile, prices);
  const withExtras = simulate(profile, prices, { servicesYear: 60, refundFixedYear: 45, newClientDiscountYear: 30 });
  close(withExtras.total, plain.total + 60 - 45 - 30);
  const pctRefund = simulate(profile, prices, { refundPctEnergy: 0.1 });
  close(pctRefund.energy.amount, 3000 * 0.16 * 0.9);
});

test('social tariff: IEC exempt', () => {
  const s = simulate({ power: 3.45, option: 1, days: 30, kwh: [100], socialTariff: true }, { tf: 0.2, energy: [0.15] });
  assert.equal(s.iec, 0);
});

const datasetPath = resolve(__dirname, '../public/data/ofertas.json');
test('dataset: simulateAll ranks offers and finds the regulated tariff', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, () => {
  const ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
  assert.ok(ds.offers.length > 500);
  const profile = { power: 3.45, option: 1, days: 31, kwh: [157] };
  const all = simulateAll(ds, profile, { currentSupplierCode: 'END' });
  assert.ok(all.length > 300, `only ${all.length} offers priced`);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].sim.total <= all[i].sim.total, 'sorted by total');
  const tur = all.find((x) => x.offer.id === 'TUR');
  assert.ok(tur, 'regulated tariff present');
  assert.deepEqual(offerPrices(tur.offer, profile), { tf: 0.1917, energy: [0.1654] });
  close(tur.sim.total, 37.29);
  // Endesa offers never get the new-client discount when Endesa is the current supplier
  const end = all.filter((x) => x.offer.supplierCode === 'END');
  assert.ok(end.length > 0);
  assert.ok(end.every((x) => x.isCurrentSupplier && x.sim.extras.newClientDiscount === 0));
  // no NaN totals
  assert.ok(all.every((x) => Number.isFinite(x.sim.total)));
});

test('dataset: tri-horária and 10,35 kVA rows exist', { skip: !existsSync(datasetPath) && 'run npm run data:build first' }, () => {
  const ds = JSON.parse(readFileSync(datasetPath, 'utf8'));
  const tri = simulateAll(ds, { power: 10.35, option: 3, days: 30, kwh: [200, 300, 200] });
  assert.ok(tri.length > 50);
  assert.ok(tri.every((x) => x.prices.energy.length === 3));
  assert.ok(tri.every((x) => x.sim.energy.reducedShare === 0));
});

test('RULES_2026 sanity', () => {
  assert.equal(RULES_2026.tarFixedPerDay[3.45], 0.1718);
  assert.equal(RULES_2026.tarFixedPerDay[6.9], 0.3436);
  assert.equal(RULES_2026.cavPerMonth, 2.85);
  assert.equal(RULES_2026.dgegPerMonth, 0.07);
  assert.equal(RULES_2026.iecPerKwh, 0.001);
});
