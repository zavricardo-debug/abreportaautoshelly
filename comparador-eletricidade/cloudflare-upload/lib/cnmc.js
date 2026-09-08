// Official CNMC comparator (https://comparador.cnmc.gob.es) – pure functions shared by the browser
// (public/app-cnmc.js: live market query through the /api/cnmc/ proxy) and by scripts/update-cnmc-offers.mjs
// (offline snapshot written to public/data/ofertas-es.json).
//
// The comparator's web app calls an undocumented JSON API (no auth; it rejects requests that carry a browser
// Origin header, hence the proxy – cloudflare/_worker.js in production, server.mjs locally):
//   GET api/publico/ofertas/electricidad?<profile>          -> every registered 2.0TD offer + its annual cost
//   GET api/publico/oferta?idOferta&idHistorico&<profile>   -> detail: cost breakdown + conditions of one offer
//
// The API never publishes unit prices, but its calculator is exactly linear in the profile (checked on real
// offers to the cent – see test/cnmc.test.mjs):
//   total = IVA( IE( F + P1·pp1 + P2·pp2 + Σ kWh_i·e_i ) + equipo de medida )
// so SIX list calls with engineered profiles give, for EVERY offer at once, the six unknowns of each contract year
// (F fixed €/año, pp1/pp2 €/kW·año, e1/e2/e3 €/kWh). See DERIVATION_LISTS + solveYear(). Year 1 (welcome
// promotions) and year 2 (plain prices) are solved separately. Rounding of the published totals (cents) limits
// the precision to ≈ ±0,02 €/kW·año and ≈ ±0,00001 €/kWh – less than one cent on a monthly bill.
export const CNMC_SITE = 'https://comparador.cnmc.gob.es';
export const CNMC_API = 'https://comparador.cnmc.gob.es/api/publico/';
export const CNMC_PROXY = 'api/cnmc/';                 // relative to the site root
export const BONO_PER_DAY = 0.024688;                  // financiación bono social 2026 (Orden TED/634/2026)
export const CNMC_METER_PER_YEAR = 9.72;               // "Equipo de medida" the CNMC adds to every offer (0,81 €/mes)
export const CNMC_IE = 0.0511269632;
export const CNMC_IVA = 0.21;
export const DEFAULT_PERFIL = 13;                      // hourly consumption profile "estándar 2.0TD" of the comparator
export const DEFAULT_CP = '28001';

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const r6 = (x) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;

/** Annualise a billing profile (days, power, kWh per period) the way the bill's QR / CNMC form expects. */
export function annualProfile(profile) {
  const days = Math.max(1, +profile.days || 30);
  const y = (v) => Math.max(0, Math.round((+v || 0) * 365 / days));
  const p1 = +profile.power?.p1 || 0;
  return { p1, p2: +profile.power?.p2 || p1, kwh: [y(profile.kwh?.punta), y(profile.kwh?.llano), y(profile.kwh?.valle)] };
}

/** Midnight UTC of the day (the API wants epoch ms; a day-aligned value keeps proxy cache keys stable). */
export const dayStamp = (now = Date.now()) => Math.floor(now / 86400000) * 86400000;

/** Full parameter set of the comparator form (every field is required – a reduced set answers HTTP 500). */
export function cnmcParams({ cp = DEFAULT_CP, p1, p2 = p1, kwh, perfilConsumo = DEFAULT_PERFIL, now = Date.now() }) {
  const day = dayStamp(now), yearAgo = day - 365 * 86400000;
  const [c1, c2, c3] = kwh.map((v) => Math.max(0, Math.round(v)));
  const cpOk = /^\d{5}$/.test(String(cp)) ? String(cp) : DEFAULT_CP;
  return {
    tipoSuministro: 'E', codigoPostal: cpOk,
    potencia: p1, potenciaPrimeraFranja: p1, potenciaSegundaFranja: p2, potenciaTerceraFranja: p1, potenciaCuartaFranja: p1, potenciaQuintaFranja: p1, potenciaSextaFranja: p1,
    consumoAnualE: c1 + c2 + c3, consumoAnualEOrig: c1 + c2 + c3,
    consumoPrimeraFranja: c1, consumoSegundaFranja: c2, consumoTerceraFranja: c3, consumoCuartaFranja: 0, consumoQuintaFranja: 0, consumoSextaFranja: 0,
    consumoAnualEQr: 0, consumoPrimeraFranjaQr: 0, consumoSegundaFranjaQr: 0, consumoTerceraFranjaQr: 0, consumoCuartaFranjaQr: 0, consumoQuintaFranjaQr: 0, consumoSextaFranjaQr: 0,
    consumoAnualEPQr: 0, consumoPrimeraFranjaPQr: 0, consumoSegundaFranjaPQr: 0, consumoTerceraFranjaPQr: 0, consumoCuartaFranjaPQr: 0, consumoQuintaFranjaPQr: 0, consumoSextaFranjaPQr: 0,
    tarifa: 4, consumoAnualG: 0, consumoAnualGOrig: 0, serviciosAdicionales: 2, permanencia: 2, vivienda: true, factura: true,
    energiaAutoconsumo: 0, idAuditoriaQR: 0, potenciaAutoconsumo: 0, revisionPrecios: 2, autoconsumo: false, importe: 0,
    mecanismoAjuste: 0, mecanismoAjusteIVA: 0, importeMecanismoAjustePunta: 0, importeMecanismoAjusteLlano: 0, importeMecanismoAjusteValle: 0,
    precioConsumoMecanismoAjusteTotal: 0, precioConsumoMecanismoAjustePunta: 0, precioConsumoMecanismoAjusteLlano: 0, precioConsumoMecanismoAjusteValle: 0,
    perfilConsumo, dateInicio: yearAgo, dateFin: day, fFact: day, cups: '0000', perfilConsumoG: 0, potenciaAutoconsumoG: 0,
  };
}
export const cnmcQuery = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
export const listUrl = (base, profile) => `${base}ofertas/electricidad?${cnmcQuery(cnmcParams(profile))}`;
export const detailUrl = (base, id, hist, profile) => `${base}oferta?idOferta=${id}&idHistorico=${hist}&${cnmcQuery(cnmcParams(profile))}`;

/* ------------------------------------------------------------------ derivation */
// Six engineered household profiles (within the limits of ordinary offers: ≤ 5 kW, ≤ 3 000 kWh/año, CP 28001).
export const DERIV = { p: 4, dp: 1, K: 3000 };
export const DERIVATION_LISTS = [
  { id: 'L1', p1: 4, p2: 4, kwh: [3000, 0, 0] },      // reference
  { id: 'L2', p1: 4, p2: 4, kwh: [0, 3000, 0] },      // e2 − e1
  { id: 'L3', p1: 4, p2: 4, kwh: [0, 0, 3000] },      // e3 − e1
  { id: 'L4', p1: 5, p2: 4, kwh: [3000, 0, 0] },      // pp1
  { id: 'L5', p1: 4, p2: 5, kwh: [3000, 0, 0] },      // pp2
  { id: 'L6', p1: 4, p2: 4, kwh: [1500, 0, 0] },      // e1
];
/** Which derivation list a query string belongs to (null = a user profile). Used by the proxies' cache policy. */
export function derivationListOf(search) {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const p1 = +q.get('potenciaPrimeraFranja'), p2 = +q.get('potenciaSegundaFranja');
  const k = [+q.get('consumoPrimeraFranja'), +q.get('consumoSegundaFranja'), +q.get('consumoTerceraFranja')];
  if (q.get('codigoPostal') !== DEFAULT_CP) return null;
  return DERIVATION_LISTS.find((d) => d.p1 === p1 && d.p2 === p2 && d.kwh.every((v, i) => v === k[i]))?.id || null;
}

/** Pre-tax sum F + potencia + energía recovered from a published annual total (peninsular taxes). */
export function invertTotal(total, { iva = CNMC_IVA, ie = CNMC_IE, meter = CNMC_METER_PER_YEAR } = {}) {
  if (!(total > 0)) return null;
  return (total / (1 + iva) - meter) / (1 + ie);
}
/** The CNMC's own arithmetic (cents at each step) – reproduces its published totals. */
export function cnmcTotal({ fixed = 0, p1, p2, pp1, pp2, kwh, energy }, { iva = CNMC_IVA, ie = CNMC_IE, meter = CNMC_METER_PER_YEAR } = {}) {
  const power = r2(p1 * pp1 + p2 * pp2);
  const e = r2(kwh[0] * energy[0] + kwh[1] * energy[1] + kwh[2] * energy[2]);
  const base = r2(fixed + power + e);
  const tax = r2(base * ie);
  const x = r2(base + tax + meter);
  return r2(x + r2(x * iva));
}
export const offerKey = (item) => `${item.id}/${item.idHistorico}`;

/** Solve one contract year from the six published totals {L1..L6}. */
export function solveYear(totals) {
  const S = {};
  for (const d of DERIVATION_LISTS) { S[d.id] = invertTotal(totals[d.id]); if (S[d.id] == null) return null; }
  const { p, dp, K } = DERIV;
  const pp1 = (S.L4 - S.L1) / dp, pp2 = (S.L5 - S.L1) / dp;
  const e1 = (S.L1 - S.L6) / (K / 2);
  const e2 = e1 + (S.L2 - S.L1) / K, e3 = e1 + (S.L3 - S.L1) / K;
  const fixed = S.L1 - p * pp1 - p * pp2 - K * e1;
  // Six equations, six unknowns: the fit is exact by construction. Whether the offer really is linear (no tranches,
  // caps or hour-dependent prices) is checked afterwards against the CNMC total of the user's own profile
  // (offerFromCnmc -> cnmc.verified), a seventh, independent data point.
  return { pp1: r2(pp1), pp2: r2(pp2), energy: [r6(e1), r6(e2), r6(e3)], fixedPerYear: r2(fixed) };
}
export const plausibleYear = (y) => !!y && y.energy.every((e) => e > 0.005 && e < 1.5) && y.pp1 > -0.5 && y.pp1 < 300 && y.pp2 > -0.5 && y.pp2 < 300 && Math.abs(y.fixedPerYear) < 900;

/**
 * Solve the unit prices of every offer present in the six derivation lists.
 * @param lists {L1..L6: {resultadoComparador:[…]}}  @returns Map offerKey -> {item, first, second, present[]}
 */
export function derivePricesFromLists(lists) {
  const byList = {};
  for (const d of DERIVATION_LISTS) {
    byList[d.id] = new Map();
    for (const it of lists[d.id]?.resultadoComparador || []) byList[d.id].set(offerKey(it), it);
  }
  const keys = new Set(); for (const d of DERIVATION_LISTS) for (const k of byList[d.id].keys()) keys.add(k);
  const out = new Map();
  for (const k of keys) {
    const items = DERIVATION_LISTS.map((d) => byList[d.id].get(k));
    const present = DERIVATION_LISTS.filter((d, i) => items[i]).map((d) => d.id);
    let first = null, second = null;
    if (present.length === DERIVATION_LISTS.length) {
      const t1 = {}, t2 = {};
      DERIVATION_LISTS.forEach((d, i) => { t1[d.id] = +items[i].importePrimerAnio; t2[d.id] = +items[i].importeSegundoAnio > 0 ? +items[i].importeSegundoAnio : +items[i].importePrimerAnio; });
      first = solveYear(t1); second = solveYear(t2);
    }
    out.set(k, { item: items.find(Boolean), first, second, present, method: 'lists' });
  }
  return out;
}

/** Sum the rows of "datosElectricidad…" of a detail answer by concept. */
export function parseBreakdown(rows) {
  const out = { power: 0, energy: 0, fixed: 0, ie: 0, meter: 0 };
  for (const r of rows || []) {
    const l = String(r.cabecera || '').toLowerCase(), v = +r.valor || 0;
    if (/potencia/.test(l)) out.power += v;
    else if (/consumo|energ/.test(l)) out.energy += v;
    else if (/impuesto/.test(l)) out.ie += v;
    else if (/equipo|contador|medida|alquiler/.test(l)) out.meter += v;
    else out.fixed += v;                                        // término fijo (bono social), cuotas
  }
  return out;
}
/** Per-offer fallback (offers missing from a derivation list): 3 detail calls – the detail endpoint ignores limits. */
export const DETAIL_PROFILES = [
  { id: 'A', p1: 10, p2: 15, kwh: [10000, 0, 0] },
  { id: 'B', p1: 10, p2: 10, kwh: [0, 10000, 0] },
  { id: 'C', p1: 10, p2: 10, kwh: [0, 0, 10000] },
];
/** @param details answers of the 3 DETAIL_PROFILES calls, in order */
export function derivePricesFromDetails(details) {
  const year = (k) => {
    const [A, B, C] = details.map((d) => parseBreakdown(d[k]));
    const pp2 = (A.power - B.power) / 5, pp1 = (B.power - 10 * pp2) / 10;
    return { pp1: r2(pp1), pp2: r2(pp2), energy: [r6(A.energy / 10000), r6(B.energy / 10000), r6(C.energy / 10000)], fixedPerYear: r2(B.fixed) };
  };
  return { first: year('datosElectricidadPrimerAnio'), second: year('datosElectricidadSegundoAnio'), present: ['detail'], method: 'detail' };
}

/** PricesES-shaped object of the app from one solved contract year. */
export function yearToPrices(y, { forceSingle = false } = {}) {
  const [e1, e2, e3] = y.energy;
  const single = forceSingle || (Math.abs(e1 - e2) < 5e-5 && Math.abs(e1 - e3) < 5e-5);
  const out = { energy: single ? { single: e1 } : { punta: e1, llano: e2, valle: e3 }, power: { p1: r6(y.pp1 / 365), p2: r6(y.pp2 / 365) } };
  const F = y.fixedPerYear, bonoYear = r2(BONO_PER_DAY * 365);   // 9,01
  // F ≈ 9,01 -> the bono social financing is billed apart (our simulator adds it); F ≈ 0 -> already inside the prices;
  // anything else -> bono apart plus a fixed fee (cuota) or a fixed discount (negative). Any split gives the same
  // total (both concepts are taxed alike); this one keeps the regulated line visible.
  if (Math.abs(F - bonoYear) <= 0.6) { /* plain offer */ }
  else if (Math.abs(F) <= 0.6) out.bonoSocialIncluded = true;
  else out.feePerMonth = r2((F - bonoYear) / 12);
  return out;
}

/* ------------------------------------------------------------------ brands */
// Legal name on the CNMC -> brand, the code the bill parser (public/lib/parser-es.js) uses for the user's current
// supplier, and the public web. Unknown comercializadoras get a code derived from their CNMC id.
const BRANDS = [
  [/energ[ií]a xxi/i, 'Energía XXI (Endesa – PVPC)', 'PVPC', 'https://www.energiaxxi.com'],
  [/comercializadora de referencia/i, 'Comercializadora de referencia (PVPC)', 'PVPC', 'https://www.cnmc.es/consumidores/energia/precio-voluntario-pequeno-consumidor'],
  [/endesa/i, 'Endesa', 'ENDESA', 'https://www.endesa.com/es/luz-y-gas/luz'],
  [/iberdrola/i, 'Iberdrola', 'IBERDROLA', 'https://www.iberdrola.es/luz/tarifas'],
  [/naturgy/i, 'Naturgy', 'NATURGY', 'https://www.naturgy.es/hogar/luz'],
  [/repsol/i, 'Repsol', 'REPSOL', 'https://www.repsol.es/particulares/hogar/luz-y-gas/tarifas-luz/'],
  [/total ?energies/i, 'TotalEnergies', 'TOTAL', 'https://www.totalenergies.es/es/hogares'],
  [/\bedp\b/i, 'EDP', 'EDP', 'https://www.edpenergia.es'],
  [/octopus/i, 'Octopus Energy', 'OCTOPUS', 'https://octopusenergy.es/precios'],
  [/plenitude|\beni\b/i, 'Plenitude', 'PLENITUDE', 'https://eniplenitude.es/hogar/tarifas-luz/'],
  [/holaluz/i, 'Holaluz', 'HOLALUZ', 'https://www.holaluz.com'],
  [/imagina/i, 'Imagina Energía', 'IMAGINA', 'https://www.imaginaenergia.com'],
  [/chippio/i, 'Chippio', 'CHIPPIO', 'https://chippio.com'],
  [/gana energ/i, 'Gana Energía', 'GANA', 'https://ganaenergia.com'],
  [/\bpodo\b/i, 'Podo', 'PODO', 'https://www.mipodo.com'],
  [/lucera/i, 'Lucera', 'LUCERA', 'https://lucera.es'],
  [/audax/i, 'Audax', 'AUDAX', 'https://www.audaxrenovables.com'],
  [/factor energ/i, 'Factor Energía', 'FACTOR', 'https://www.factorenergia.com'],
  [/som energia/i, 'Som Energia', 'SOM', 'https://www.somenergia.coop'],
  [/goiener/i, 'Goiener', 'GOIENER', 'https://www.goiener.com'],
  [/fen[ií]e/i, 'Feníe Energía', 'FENIE', 'https://www.fenieenergia.es'],
  [/aldro/i, 'Aldro', 'ALDRO', 'https://www.aldroenergia.com'],
  [/domestica gas y electricidad|visalia/i, 'Visalia', 'VISALIA', 'https://visalia.es/luz/'],
  [/a tu lado/i, 'A Tu Lado Energía', 'ATULADO', 'https://atuladoenergia.com'],
  [/energya ?vm|en[eé]rgya/i, 'Enérgya-VM', 'ENERGYAVM', 'https://www.energyavm.es'],
  [/cide hcenerg|chc energ/i, 'CHC Energía', 'CHC', 'https://www.chcenergia.es'],
  [/guissona|bon[aà]rea/i, 'bonÀrea Energia', 'BONAREA', 'https://www.bonarea-energia.com'],
  [/lumisa/i, 'Lumisa', 'LUMISA', 'https://www.lumisa.es'],
  [/\bniba\b/i, 'niba', 'NIBA', 'https://niba.es'],
  [/daimuz/i, 'Daimuz Energía', 'DAIMUZ', 'https://daimuz.es'],
  [/gaolania/i, 'Gaolania', 'GAOLANIA', 'https://gaolania.es'],
  [/nufri/i, 'Energía Nufri', 'NUFRI', 'https://www.energianufri.com'],
  [/telecor/i, 'Telecor', 'TELECOR', 'https://www.telecor.es'],
  [/alginetens/i, 'Alginet Energía', 'ALGINET', 'https://www.alginetenergia.com'],
  [/\belek\b/i, 'Elek', 'ELEK', 'https://elekluz.com'],
  [/gesternova/i, 'Gesternova', 'GESTERNOVA', 'https://gesternova.com'],
  [/\bmet energ/i, 'MET Energía', 'MET', 'https://www.met.com/es'],
];
/** Known brands (code, name, url) – the app adds them to the "comercializadora actual" select. */
export const BRAND_LIST = BRANDS.reduce((acc, [, name, code, url]) => (acc.some((b) => b.code === code) ? acc : [...acc, { code, name, url }]), []);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-.(])([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
export function brandOf(legalName, idComercializadora) {
  const legal = String(legalName || '').trim();
  for (const [re, name, code, url] of BRANDS) if (re.test(legal)) return { name, code, url };
  const stripped = legal.replace(/,?\s*(s\.?\s*a\.?\s*u?\.?|s\.?\s*l\.?\s*u?\.?|s\.?\s*coop\.?(\s*v\.?)?|unipersonal|sociedad an[oó]nima( unipersonal)?|sociedad limitada( unipersonal)?)\s*$/i, '').trim();
  const name = stripped ? (stripped === stripped.toUpperCase() ? titleCase(stripped) : stripped) : legal;
  return { name, code: `CNMC${idComercializadora || 0}`, url: null };
}

/* ------------------------------------------------------------------ offers */
const fmt2 = (v) => (v == null ? '—' : v.toFixed(2).replace('.', ','));
/**
 * Dataset-shaped offer from a CNMC list item + solved prices (+ optional detail metadata).
 * `user` = the annual profile the list was queried with: the offer is `verified` when our reconstruction of the
 * CNMC's first-year total for that profile matches the published figure.
 */
export function offerFromCnmc(item, solved, { detail = null, date = new Date().toISOString().slice(0, 10), user = null } = {}) {
  const brand = brandOf(item.comercializadora, item.idComercializadora);
  const isPvpc = /pvpc/i.test(item.tipoElectricidad || '') || /pvpc/i.test(item.oferta || '');
  // "FFF": the customer picks N cheap hours (Repsol "10 horas") – the cost depends on the hours chosen, not on the
  // three 2.0TD periods, so it cannot be rebuilt line by line; only the CNMC's own annual figure is shown.
  const flexible = item.tipoElectricidad === 'FFF' || !!item.flexibleClienteResultListPrimerAnio;
  const meta = detail?.caracteristicas || {};
  const text = String(meta.caracteristicas || '');
  const name = String(item.oferta || '').replace(/\s+/g, ' ').trim();
  const indexed = !isPvpc && /index|\bflexi\b|\bpool\b|omie|mercado (diario|mayorista|spot)|precio de mercado|precio horario|hora a hora|din[aá]mic/i.test(name + ' ' + text);
  const forceSingle = item.tienePrecioUnico === 'S';
  const y1 = !flexible && solved?.first && plausibleYear(solved.first) ? solved.first : null;
  const y2 = !flexible && solved?.second && plausibleYear(solved.second) ? solved.second : null;
  const first = y1 ? yearToPrices(y1, { forceSingle }) : null;
  const second = y2 ? yearToPrices(y2, { forceSingle }) : null;
  const promo = !!(first && second) && JSON.stringify(first) !== JSON.stringify(second);
  const cond = String(meta.condicionesPenalizacion || '');
  const validez = String(item.validez || '');
  const web = (String(meta.atencionCliente || '').split('$').pop() || '').trim();
  const o = {
    id: `CNMC-${item.id}`, cnmcId: item.id, cnmcHist: item.idHistorico,
    supplierCode: brand.code, supplier: brand.name, legalName: item.comercializadora,
    supplierUrl: brand.url || (/^https?:/.test(web) ? web : null),
    name,
    type: isPvpc ? 'pvpc' : flexible ? 'flexible' : indexed ? 'indexed' : (second || first)?.energy?.single != null ? 'fixed' : 'fixed3',
    prices: !!(first || second),
  };
  if (flexible) o.flexible = true;
  const base = promo ? first : (second || first);
  if (base) Object.assign(o, base);
  if (promo) {
    o.after = second;
    o.promoText = `Promoción el 1.er año (según la CNMC, para su perfil: ${fmt2(+item.importePrimerAnio)} €/año el primer año y ${fmt2(+item.importeSegundoAnio)} €/año después)`;
  }
  if (indexed || isPvpc) o.indexed = true;
  if (isPvpc) o.regulated = true;
  o.newClientsOnly = /nuevos clientes/i.test(`${validez} ${meta.limitaciones || ''}`);
  o.permanence = !!item.penalizacion || (/permanencia/i.test(cond) && !/sin permanencia|no se aplican|no exist|no hay|no habr/i.test(cond));
  if (item.penalizacion && item.importeEstimadoPenalizacion) o.penaltyEstimate = r2(+item.importeEstimadoPenalizacion);
  o.renewable = !!item.verde;
  if (item.serviciosAdicionales) { o.servicesIncluded = true; o.servicesText = item.tipoServicioAdicional || null; }
  if (item.autoconsumo) o.selfConsumption = true;
  if (meta.potenciaMaximaElectricidad && +meta.potenciaMaximaElectricidad < 15) o.maxPower = +meta.potenciaMaximaElectricidad;
  if (meta.potenciaMinimaElectricidad && +meta.potenciaMinimaElectricidad > 0) o.minPower = +meta.potenciaMinimaElectricidad;
  if (meta.consumoMaximoElectricidad && +meta.consumoMaximoElectricidad < 999999) o.maxKwhYear = +meta.consumoMaximoElectricidad;
  if (meta.periodoValidez) o.validity = meta.periodoValidez;
  if (meta.periocidadRevisionPrecios) o.priceRevision = meta.periocidadRevisionPrecios;
  const cn = {
    firstYear: +item.importePrimerAnio || null, secondYear: +item.importeSegundoAnio || null,
    validez, method: solved?.method || null,
    contracting: [meta.ofertaInternet && 'online', meta.ofertaTel && 'teléfono', meta.ofertaOficina && 'oficina'].filter(Boolean),
  };
  if (user && y1 && cn.firstYear) {
    cn.profile = { p1: user.p1, p2: user.p2, kwh: user.kwh };
    cn.ours = cnmcTotal({ fixed: y1.fixedPerYear, p1: user.p1, p2: user.p2, pp1: y1.pp1, pp2: y1.pp2, kwh: user.kwh, energy: y1.energy });
    cn.delta = r2(cn.ours - cn.firstYear);
    cn.verified = Math.abs(cn.delta) <= Math.max(1, cn.firstYear * 0.003);
  }
  o.cnmc = cn;
  o.source = { name: `Comparador oficial CNMC (oferta n.º ${item.id})`, url: meta.webOferta || CNMC_SITE, date, contract: meta.webContrato || null };
  const notes = [text.replace(/\s+/g, ' ').trim(), meta.limitaciones, cond].filter(Boolean).join(' · ');
  if (notes) o.notes = notes.slice(0, 900);
  return o;
}

/** Offers + suppliers from a list answer (the profile it was queried with) and the solved prices. */
export function buildMarket(list, solved, { date, user = null, detailsByKey = null } = {}) {
  const offers = [];
  for (const item of list?.resultadoComparador || []) {
    const k = offerKey(item);
    offers.push(offerFromCnmc(item, solved?.get(k) || null, { date, detail: detailsByKey?.get(k) || null, user }));
  }
  const suppliers = [];
  for (const o of offers) if (!suppliers.some((s) => s.code === o.supplierCode)) suppliers.push({ code: o.supplierCode, name: o.supplier, url: o.supplierUrl || null });
  suppliers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { offers, suppliers };
}
