// Cost model for a Spanish domestic electricity bill (peaje de acceso 2.0TD, ≤ 15 kW).
//
// Given the profile read from the bill (days, contracted power P1/P2, kWh per period)
// and the unit prices of an offer, it rebuilds the bill line by line exactly the way
// the comercializadoras print it:
//
//   Potencia P1 (punta)         kW × €/kW·día × días
//   Potencia P2 (valle)         kW × €/kW·día × días
//   Energía punta/llano/valle   kWh × €/kWh          (or a single price for all hours)
//   Cuota de gestión            €/día or €/mes       (indexed offers only)
//   Financiación Bono Social    días × 0,024688 €/día (regulated, identical for every offer)
//   Alquiler del contador       días × €/día         (regulated, identical for every offer – no IE)
//   Impuesto electricidad       5,11269632 % × (potencia + energía + gestión + bono social)
//   IVA 21 %                    × (all of the above + alquiler)
//
// Sources: Ley 38/1992 art. 99 (IEE 5,11269632 %, mínimo 1 €/MWh), Ley 37/1992 (IVA 21 %),
// Orden TED (financiación bono social 2026), CNMC Circular 3/2020 (peajes 2.0TD),
// RD 1164/2001 (alquiler equipos de medida).

export const RULES_ES_2026 = {
  year: 2026,
  iva: 0.21,
  ieRate: 0.0511269632,
  ieMinPerKwh: 0.001,              // importe mínimo del impuesto: 1 €/MWh
  bonoSocialPerDay: 0.024688,      // coste fijo por cliente (comercialización) – financiación bono social
  meterRentPerDay: 0.026774,       // contador monofásico digital ≈ 0,81 €/mes
  peajesPowerP1: 0.075903,         // peajes + cargos potencia 2.0TD 2026 (€/kW·día) – informative
  peajesPowerP2: 0.001987,
  defaultSplit: { punta: 0.30, llano: 0.26, valle: 0.44 },   // typical 2.0TD household profile
};

export const PERIODS_ES = ['punta', 'llano', 'valle'];
export const PERIOD_LABELS_ES = { punta: 'Punta', llano: 'Llano', valle: 'Valle', single: 'Precio único 24 h' };

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);

/** Split a total consumption into punta/llano/valle using the readings of the bill (if any) or the default profile. */
export function splitConsumption(totalKwh, readings, split = RULES_ES_2026.defaultSplit) {
  const src = readings && PERIODS_ES.some((k) => readings[k] > 0) ? readings : split;
  const s = sum(PERIODS_ES.map((k) => src[k])) || 1;
  const out = {};
  for (const k of PERIODS_ES) out[k] = (totalKwh || 0) * (src[k] || 0) / s;
  return out;
}

/**
 * @typedef {Object} ProfileES
 * @property {number} days
 * @property {{p1:number,p2:number}} power       contracted power in kW
 * @property {{punta:number,llano:number,valle:number}} kwh
 * @property {number} [meterRentPerDay]          from the bill (pass-through)
 * @property {number} [bonoSocialPerDay]
 * @property {number} [ieRate]
 * @property {number} [ivaRate]
 */
/**
 * @typedef {Object} PricesES
 * @property {{single?:number,punta?:number,llano?:number,valle?:number}} energy  €/kWh sin impuestos
 * @property {{p1:number,p2:number}} power        €/kW·día sin impuestos
 * @property {number} [feePerDay]                 cuota de gestión (indexadas)
 * @property {number} [feePerMonth]
 */

/** Rebuild the bill for a profile with the given prices. All amounts rounded to cents like a real bill. */
export function simulateES(profile, prices, rules = RULES_ES_2026) {
  const days = +profile.days || 30;
  const p1kw = +profile.power?.p1 || 0, p2kw = +profile.power?.p2 || p1kw;
  const kwh = { punta: +profile.kwh?.punta || 0, llano: +profile.kwh?.llano || 0, valle: +profile.kwh?.valle || 0 };
  const totalKwh = sum(Object.values(kwh));
  const bonoPerDay = profile.bonoSocialPerDay ?? rules.bonoSocialPerDay;
  const rentPerDay = profile.meterRentPerDay ?? rules.meterRentPerDay;
  const ieRate = profile.ieRate ?? rules.ieRate;
  const ivaRate = profile.ivaRate ?? rules.iva;

  const lines = [];
  const powerP1 = r2(p1kw * (+prices.power?.p1 || 0) * days);
  const powerP2 = r2(p2kw * (+prices.power?.p2 || 0) * days);
  lines.push({ id: 'power_p1', group: 'power', label: 'Potencia P1 (punta-llano)', qty: p1kw, unit: 'kW', days, price: +prices.power?.p1 || 0, priceUnit: '€/kW·día', amount: powerP1 });
  lines.push({ id: 'power_p2', group: 'power', label: 'Potencia P2 (valle)', qty: p2kw, unit: 'kW', days, price: +prices.power?.p2 || 0, priceUnit: '€/kW·día', amount: powerP2 });

  const single = prices.energy?.single != null && prices.energy.punta == null;
  const energyLines = [];
  if (single) {
    energyLines.push({ id: 'energy_single', group: 'energy', period: 'single', label: 'Energía (precio único)', qty: totalKwh, unit: 'kWh', price: +prices.energy.single, priceUnit: '€/kWh', amount: r2(totalKwh * +prices.energy.single) });
  } else {
    for (const k of PERIODS_ES) {
      const price = +(prices.energy?.[k] ?? prices.energy?.single ?? 0);
      energyLines.push({ id: `energy_${k}`, group: 'energy', period: k, label: `Energía ${PERIOD_LABELS_ES[k].toLowerCase()}`, qty: kwh[k], unit: 'kWh', price, priceUnit: '€/kWh', amount: r2(kwh[k] * price) });
    }
  }
  lines.push(...energyLines);
  const energyAmount = r2(sum(energyLines.map((l) => l.amount)));

  let fee = 0;
  if (prices.feePerDay) fee = r2(prices.feePerDay * days);
  else if (prices.feePerMonth) fee = r2(prices.feePerMonth * days * 12 / 365);
  if (fee) lines.push({ id: 'fee', group: 'fee', label: 'Cuota de gestión', qty: days, unit: 'días', price: prices.feePerDay || prices.feePerMonth, priceUnit: prices.feePerDay ? '€/día' : '€/mes', amount: fee });
  // some suppliers bill regulated extras per kWh in a separate line (e.g. Repsol: SNOEE 0,00266 €/kWh)
  let extra = 0;
  if (prices.extraPerKwh) { extra = r2(prices.extraPerKwh * totalKwh); lines.push({ id: 'extra', group: 'fee', label: prices.extraLabel || 'Otros conceptos regulados', qty: totalKwh, unit: 'kWh', price: prices.extraPerKwh, priceUnit: '€/kWh', amount: extra }); }

  const bonoSocial = r2(bonoPerDay * days);
  const meterRent = r2(rentPerDay * days);
  lines.push({ id: 'bono_social', group: 'regulated', label: 'Financiación Bono Social', qty: days, unit: 'días', price: bonoPerDay, priceUnit: '€/día', amount: bonoSocial });
  lines.push({ id: 'meter_rent', group: 'regulated', label: 'Alquiler del contador', qty: days, unit: 'días', price: rentPerDay, priceUnit: '€/día', amount: meterRent });

  const powerAmount = r2(powerP1 + powerP2);
  const ieBase = r2(powerAmount + energyAmount + fee + extra + bonoSocial);
  const ie = r2(Math.max(ieBase * ieRate, totalKwh * rules.ieMinPerKwh));
  lines.push({ id: 'ie', group: 'tax', label: 'Impuesto electricidad', qty: ieBase, unit: '€', price: ieRate * 100, priceUnit: '%', amount: ie });
  const ivaBase = r2(ieBase + ie + meterRent);
  const iva = r2(ivaBase * ivaRate);
  lines.push({ id: 'iva', group: 'tax', label: `IVA ${Math.round(ivaRate * 100)} %`, qty: ivaBase, unit: '€', price: ivaRate * 100, priceUnit: '%', amount: iva });
  const total = r2(ivaBase + iva);
  lines.push({ id: 'total', group: 'total', label: 'TOTAL', amount: total });

  return {
    days, totalKwh, kwh, power: { p1: p1kw, p2: p2kw }, single,
    lines, powerP1, powerP2, powerAmount, energyAmount, fee, extra, bonoSocial, meterRent, ieBase, ie, ivaBase, iva, total,
    totalPerYear: r2(total * 365 / days),
    avgEnergyPrice: totalKwh ? energyAmount / totalKwh : null,
    avgPowerPerDay: days ? powerAmount / days : null,
  };
}

/** Prices of the user's own bill, as read by the parser (baseline). */
export function baselinePricesES(form) {
  const energy = form.energySingle != null && !form.energyByPeriod ? { single: +form.energySingle } : { punta: +form.energyPrice.punta, llano: +form.energyPrice.llano, valle: +form.energyPrice.valle };
  return { energy, power: { p1: +form.powerPrice.p1, p2: +form.powerPrice.p2 } };
}

/** Prices of an offer, with or without its welcome promotion. */
export function offerPricesES(offer, { includePromo = true } = {}) {
  const src = !includePromo && offer.after ? { ...offer, ...offer.after } : offer;
  return { energy: src.energy, power: src.power, feePerDay: src.feePerDay || 0, feePerMonth: src.feePerMonth || 0, extraPerKwh: src.extraPerKwh || 0, extraLabel: src.extraLabel || null };
}

/** Whether an offer can be contracted with this profile. */
export function offerApplicableES(offer, profile) {
  const maxP = Math.max(profile.power?.p1 || 0, profile.power?.p2 || 0);
  if (offer.maxPower && maxP > offer.maxPower + 1e-9) return false;
  if (offer.minPower && maxP < offer.minPower - 1e-9) return false;
  if (offer.maxKwhYear) {
    const yearly = sum(Object.values(profile.kwh || {})) * 365 / (profile.days || 30);
    if (yearly > offer.maxKwhYear) return false;
  }
  return true;
}

/** Simulate every offer of the dataset for the profile. Sorted by total (cheapest first). */
export function simulateAllES(dataset, profile, { includePromo = true, currentSupplierCode = null } = {}) {
  const out = [];
  for (const offer of dataset.offers || []) {
    if (!offerApplicableES(offer, profile)) continue;
    const prices = offerPricesES(offer, { includePromo });
    const sim = simulateES(profile, prices, dataset.rules || RULES_ES_2026);
    const simAfter = offer.after ? simulateES(profile, offerPricesES(offer, { includePromo: false }), dataset.rules || RULES_ES_2026) : null;
    out.push({ offer, prices, sim, simAfter, isCurrentSupplier: !!currentSupplierCode && offer.supplierCode === currentSupplierCode });
  }
  out.sort((a, b) => a.sim.total - b.sim.total);
  return out;
}

/** Line-by-line comparison between two simulations (same concept ids). */
export function compareLinesES(base, other) {
  const ids = ['power_p1', 'power_p2', 'energy', 'fee', 'extra', 'bono_social', 'meter_rent', 'ie', 'iva', 'total'];
  const amount = (s, id) => id === 'energy' ? s.energyAmount : (s.lines.find((l) => l.id === id)?.amount ?? 0);
  return ids.map((id) => {
    const a = amount(base, id), b = amount(other, id);
    return { id, base: a, other: b, diff: r2(b - a) };
  }).filter((r) => !((r.id === 'fee' || r.id === 'extra') && r.base === 0 && r.other === 0));
}

/** Deep link to the official CNMC comparator with the consumer's data (BOE-A-2022-16989 QR parameters). */
export function cnmcLink(profile, { postalCode = '', periodStart = null, contractType = 'F0' } = {}) {
  const days = profile.days || 30;
  const y = (v) => Math.round((v || 0) * 365 / days);
  const p = new URLSearchParams();
  if (postalCode) p.set('cp', postalCode);
  p.set('pP1', String(profile.power?.p1 ?? ''));
  p.set('pP2', String(profile.power?.p2 ?? profile.power?.p1 ?? ''));
  p.set('caP1', String(y(profile.kwh?.punta)));
  p.set('caP2', String(y(profile.kwh?.llano)));
  p.set('caP3', String(y(profile.kwh?.valle)));
  const start = periodStart ? new Date(periodStart) : new Date(Date.now() - 365 * 86400000);
  p.set('iniA', start.toISOString().slice(0, 10));
  p.set('tc', contractType);
  p.set('finContrato', new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10));
  return `https://comparador.cnmc.gob.es/comparador/QRE?${p.toString()}`;
}
