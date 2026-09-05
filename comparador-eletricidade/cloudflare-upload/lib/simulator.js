// Cost model for a Portuguese BTN (low voltage) electricity invoice.
//
// Given a consumption profile (kWh per period, days, contracted power) and the
// unit prices of an offer (€/day for power, €/kWh per period) it reproduces the
// invoice the same way suppliers do:
//
//   Termo de Energia            kWh x €/kWh          IVA 6 % up to 200 kWh/30 days (≤ 6,9 kVA), 23 % above
//   Termo de Potência           dias x €/dia         IVA 23 % (supplier part) ...
//   Termo Fixo Acesso às Redes  dias x €/dia TAR     ... IVA 6 % on the TAR part when ≤ 3,45 kVA, else 23 %
//   Imposto Especial Consumo    kWh x 0,001 €/kWh    IVA 23 %
//   Taxa Exploração DGEG        meses x 0,07 €/mês   IVA 23 %
//   Contribuição Audiovisual    meses x 2,85 €/mês   IVA 6 %
//
// Sources: Código do IVA Lista I verbas 2.33 / 2.38 (Lei 38/2024), Portaria 320-D/2011 (IEC),
// DGEG DL 4/93, Lei 30/2003 (CAV), ERSE tarifas de acesso às redes 2026.

export const RULES_2026 = {
  year: 2026,
  ivaNormal: 0.23,
  ivaReduced: 0.06,
  ivaReducedEnergyKwhPer30Days: 200,      // Lei 38/2024 (300 for large families)
  ivaReducedEnergyKwhLargeFamily: 300,
  ivaReducedEnergyMaxPower: 6.9,          // kVA
  ivaReducedTarMaxPower: 3.45,            // kVA - fixed TAR component at 6 %
  iecPerKwh: 0.001,
  dgegPerMonth: 0.07,
  cavPerMonth: 2.85,
  // Tarifa de Acesso às Redes 2026 - termo fixo (€/dia) per contracted power (ERSE)
  tarFixedPerDay: {
    1.15: 0.0573, 2.3: 0.1145, 3.45: 0.1718, 4.6: 0.2291, 5.75: 0.2864, 6.9: 0.3436,
    10.35: 0.5154, 13.8: 0.6872, 17.25: 0.8591, 20.7: 1.0309, 27.6: 1.3248, 34.5: 1.656, 41.4: 1.9872,
  },
  // Tarifa de Acesso às Redes 2026 - energy component (€/kWh) - informative only
  tarEnergyPerKwh: { 1: [0.0607], 2: [0.0835, 0.0158], 3: [0.2452, 0.0412, 0.0158] },
};

export const STANDARD_POWERS = [1.15, 2.3, 3.45, 4.6, 5.75, 6.9, 10.35, 13.8, 17.25, 20.7, 27.6, 34.5, 41.4];

export const PERIOD_KEYS = { 1: ['simples'], 2: ['foraVazio', 'vazio'], 3: ['ponta', 'cheias', 'vazio'] };
export const PERIOD_LABELS = { simples: 'Simples', foraVazio: 'Fora de Vazio', vazio: 'Vazio', ponta: 'Ponta', cheias: 'Cheias' };

export function nearestStandardPower(p) {
  if (!p) return null;
  return STANDARD_POWERS.reduce((best, s) => (Math.abs(s - p) < Math.abs(best - p) ? s : best), STANDARD_POWERS[0]);
}

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

/**
 * @typedef {Object} Profile
 * @property {number} power        contracted power (kVA)
 * @property {1|2|3} option        1 simples, 2 bi-horária, 3 tri-horária
 * @property {number} days         billing days
 * @property {number[]} kwh        consumption per period, in PERIOD_KEYS order
 * @property {boolean} [largeFamily]
 * @property {boolean} [socialTariff]  (IEC exempt) - informative
 */

/**
 * @typedef {Object} Prices
 * @property {number} tf           €/day (full power term: supplier + TAR)
 * @property {number[]} energy     €/kWh per period, PERIOD_KEYS order
 */

/**
 * Compute a full invoice for the profile under the given prices.
 * @param {Profile} profile
 * @param {Prices} prices
 * @param {object} [extras]  { servicesYear, refundFixedYear, refundPctFixed, refundPctEnergy, refundPerKwh, newClientDiscountYear }
 * @param {object} [rules]
 */
export function simulate(profile, prices, extras = {}, rules = RULES_2026) {
  const days = Math.max(1, profile.days || 30);
  const months = days / (365 / 12);
  const keys = PERIOD_KEYS[profile.option] || PERIOD_KEYS[1];
  const kwh = keys.map((_, i) => Math.max(0, Number(profile.kwh?.[i]) || 0));
  const totalKwh = kwh.reduce((a, b) => a + b, 0);
  const power = profile.power || 6.9;
  const tarDay = rules.tarFixedPerDay[power] ?? rules.tarFixedPerDay[nearestStandardPower(power)] ?? 0;

  // --- Energy ---
  const energyLines = keys.map((k, i) => {
    const unit = Number(prices.energy?.[i]);
    const p = Number.isFinite(unit) ? unit : Number(prices.energy?.[0]) || 0;
    return { period: k, kwh: kwh[i], unitPrice: p, amount: kwh[i] * p };
  });
  let energyAmount = energyLines.reduce((a, l) => a + l.amount, 0);
  // refunds expressed per kWh / % of energy term (ERSE "Reembolsos")
  const refundEnergy = (extras.refundPctEnergy || 0) * energyAmount + (extras.refundPerKwh || 0) * totalKwh;
  energyAmount -= refundEnergy;

  // IVA split for energy: 6 % share = min(1, limit / totalKwh) applied proportionally to all periods
  let energyReducedShare = 0;
  if (power <= rules.ivaReducedEnergyMaxPower + 1e-9 && totalKwh > 0) {
    const limitPer30 = profile.largeFamily ? rules.ivaReducedEnergyKwhLargeFamily : rules.ivaReducedEnergyKwhPer30Days;
    const limit = limitPer30 * days / 30;
    energyReducedShare = Math.min(1, limit / totalKwh);
  }
  const energyBase6 = energyAmount * energyReducedShare;
  const energyBase23 = energyAmount - energyBase6;

  // --- Power (potência) ---
  const tf = Number(prices.tf) || 0;
  let powerAmount = tf * days;
  const refundFixed = (extras.refundPctFixed || 0) * powerAmount;
  powerAmount -= refundFixed;
  const tarAmount = Math.min(powerAmount, tarDay * days);
  const supplierPowerAmount = powerAmount - tarAmount;
  const tarReduced = power <= rules.ivaReducedTarMaxPower + 1e-9;
  const powerBase6 = tarReduced ? tarAmount : 0;
  const powerBase23 = tarReduced ? supplierPowerAmount : powerAmount;

  // --- Taxes ---
  const iec = profile.socialTariff ? 0 : totalKwh * rules.iecPerKwh;
  const dgeg = rules.dgegPerMonth * months;
  const cav = rules.cavPerMonth * months;

  const base6 = energyBase6 + powerBase6 + cav;
  const base23 = energyBase23 + powerBase23 + iec + dgeg;
  const iva6 = base6 * rules.ivaReduced;
  const iva23 = base23 * rules.ivaNormal;

  const subtotal = base6 + base23;
  let total = subtotal + iva6 + iva23;

  // --- Extras (already with IVA, per year -> pro-rata for the period) ---
  const share = days / 365;
  const services = (extras.servicesYear || 0) * share;
  const refundFixedYear = (extras.refundFixedYear || 0) * share;
  const newClient = (extras.newClientDiscountYear || 0) * share;
  total += services - refundFixedYear - newClient;

  return {
    days, months, power, option: profile.option, totalKwh, tarDay,
    energy: { lines: energyLines, amount: r2(energyAmount), base6: r2(energyBase6), base23: r2(energyBase23), reducedShare: energyReducedShare, refund: r2(refundEnergy) },
    powerTerm: { unitPrice: tf, supplierPerDay: Math.max(0, tf - tarDay), tarPerDay: tarDay, amount: r2(powerAmount), supplierAmount: r2(supplierPowerAmount), tarAmount: r2(tarAmount), refund: r2(refundFixed) },
    iec: r2(iec), dgeg: r2(dgeg), cav: r2(cav),
    base6: r2(base6), base23: r2(base23), iva6: r2(iva6), iva23: r2(iva23), iva: r2(iva6 + iva23),
    subtotal: r2(subtotal),
    extras: { services: r2(services), refundFixedYear: r2(refundFixedYear), newClientDiscount: r2(newClient) },
    total: r2(total),
    totalPerYear: r2(total * 365 / days),
    avgEnergyPrice: totalKwh ? energyAmount / totalKwh : 0,
  };
}

/** Pick the price row of an offer for the profile. Returns null if the offer has no such row. */
export function offerPrices(offer, profile) {
  const p = offer.prices?.[`${profile.power}|${profile.option}`];
  if (!p || !Number.isFinite(p.tf) || !Number.isFinite(p.p1)) return null;
  const energy = profile.option === 1 ? [p.p1] : profile.option === 2 ? [p.p1, p.p2] : [p.p1, p.p2, p.p3];
  if (energy.some((v) => !Number.isFinite(v))) return null;
  return { tf: p.tf, energy };
}

/**
 * Simulate every offer of the dataset for the given profile.
 * @param {object} dataset  public/data/ofertas.json
 * @param {Profile} profile
 * @param {object} opts  { includeExtras (refunds/discounts), includeNewClientDiscount, currentSupplierCode }
 */
export function simulateAll(dataset, profile, opts = {}) {
  const out = [];
  for (const offer of dataset.offers) {
    const prices = offerPrices(offer, profile);
    if (!prices) continue;
    const isCurrentSupplier = opts.currentSupplierCode && offer.supplierCode === opts.currentSupplierCode;
    const extras = {
      servicesYear: offer.servicesCostYear,
      refundFixedYear: opts.includeExtras === false ? 0 : offer.refundFixedYear,
      refundPctFixed: opts.includeExtras === false ? 0 : offer.refundPctFixed,
      refundPctEnergy: opts.includeExtras === false ? 0 : offer.refundPctEnergy,
      refundPerKwh: opts.includeExtras === false ? 0 : offer.refundPerKwh,
      newClientDiscountYear: opts.includeNewClientDiscount === false || isCurrentSupplier ? 0 : offer.newClientDiscountYear,
    };
    const sim = simulate(profile, prices, extras);
    out.push({ offer, prices, sim, isCurrentSupplier });
  }
  out.sort((a, b) => a.sim.total - b.sim.total);
  return out;
}

/** Build the user's own price set (baseline) from the parsed invoice / form. */
export function baselinePrices(form) {
  const energy = (PERIOD_KEYS[form.option] || PERIOD_KEYS[1]).map((k, i) => Number(form.energyPrice?.[i]) || 0);
  return { tf: (Number(form.powerPrice) || 0) + (Number(form.tarPrice) || 0), energy };
}
