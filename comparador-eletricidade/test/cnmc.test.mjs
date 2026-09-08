// Official CNMC comparator: price derivation from its published annual totals.
// The reference figures below were read from the live API (api/publico/oferta) on 2026-09-08.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cnmcTotal, invertTotal, solveYear, DERIVATION_LISTS, derivePricesFromLists, derivePricesFromDetails, yearToPrices, offerFromCnmc, buildMarket, brandOf, cnmcParams, cnmcQuery, listUrl, detailUrl, annualProfile, BRAND_LIST } from '../public/lib/cnmc.js';
import { simulateES, RULES_ES_2026 } from '../public/lib/simulator-es.js';

// Iberdrola "2.0TD Plan Online 3 Precios" (oferta 4628/369): prices printed in caracteristicas + totals of 7 real calls
const IB = { fixed: 9.01, pp1: 33.242078, pp2: 4.921170, energy: [0.192890, 0.134603, 0.100874] };
const IB_CALLS = [
  [{ p1: 1, p2: 2, kwh: [1000, 0, 0] }, 323.35],
  [{ p1: 1, p2: 1, kwh: [0, 1000, 0] }, 242.94],
  [{ p1: 1, p2: 1, kwh: [0, 0, 1000] }, 200.05],
  [{ p1: 12, p2: 12, kwh: [10000, 0, 0] }, 3058.98],
  [{ p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] }, 829.31],
  [{ p1: 3, p2: 6, kwh: [0, 0, 3000] }, 572.50],
  [{ p1: 5, p2: 5, kwh: [0, 0, 20000] }, 2831.87],
];
// Visalia "3 Precios" (6772/47)
const VI = { fixed: 9.01, pp1: 27.704413, pp2: 0.725423, energy: [0.238530, 0.149464, 0.119806] };
const VI_CALLS = [[{ p1: 10, p2: 20, kwh: [10000, 0, 0] }, 3427.81], [{ p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] }, 880.66], [{ p1: 3, p2: 6, kwh: [0, 0, 3000] }, 591.61]];
// Enérgya-VM "Fórmula Fija Única 24HORAS" (5356/116): bono social inside the prices (F = 0), 25 % promo for 90 days
const EN2 = { fixed: 0, pp1: 32.94, pp2: 1.10, energy: [0.13910, 0.13910, 0.13910] };
const EN1 = { ...EN2, energy: [0.130527, 0.130527, 0.130527] };

test('cnmcTotal reproduces the comparator\'s published totals to the cent', () => {
  for (const [p, total] of IB_CALLS) assert.equal(cnmcTotal({ ...IB, ...p }), total, JSON.stringify(p));
  for (const [p, total] of VI_CALLS) assert.equal(cnmcTotal({ ...VI, ...p }), total, JSON.stringify(p));
  assert.equal(cnmcTotal({ ...EN2, p1: 4, p2: 4, kwh: [3000, 0, 0] }), 715.69);
  assert.equal(cnmcTotal({ ...EN1, p1: 4, p2: 4, kwh: [3000, 0, 0] }), 682.97);
  assert.equal(cnmcTotal({ ...EN2, p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] }), 788.36);
  assert.ok(Math.abs(invertTotal(829.31) - (9.01 + 175.55 + 458.24)) < 0.02);
});

const totalsFor = (pr) => Object.fromEntries(DERIVATION_LISTS.map((d) => [d.id, cnmcTotal({ ...pr, p1: d.p1, p2: d.p2, kwh: d.kwh })]));
const item = (over) => ({ id: 1, idHistorico: 1, idComercializadora: 9, comercializadora: 'IBERDROLA CLIENTES, S.A.U.', oferta: '2.0TD Plan Online 3 Precios (0-10kW)', tipoElectricidad: 'TE', importePrimerAnio: 829.31, importeSegundoAnio: 829.31, validez: 'Válida para consumidores domésticos y pequeños negocios', serviciosAdicionales: false, penalizacion: false, verde: true, tienePrecioUnico: 'N', autoconsumo: false, importeEstimadoPenalizacion: 0, ...over });

test('solveYear recovers the unit prices from the six derivation totals', () => {
  for (const [name, pr] of [['iberdrola', IB], ['visalia', VI], ['energya', EN2], ['promo', EN1], ['fee', { fixed: 9.01 + 60, pp1: 30, pp2: 2, energy: [0.15, 0.12, 0.09] }]]) {
    const y = solveYear(totalsFor(pr));
    assert.ok(Math.abs(y.pp1 - pr.pp1) < 0.02 && Math.abs(y.pp2 - pr.pp2) < 0.02, `${name} power ${y.pp1}/${y.pp2}`);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(y.energy[i] - pr.energy[i]) < 1.5e-5, `${name} energy ${i}: ${y.energy[i]} vs ${pr.energy[i]}`);
    assert.ok(Math.abs(y.fixedPerYear - pr.fixed) < 0.1, `${name} fixed ${y.fixedPerYear}`);
    // the user's annual total rebuilt from the solved prices matches the comparator within a few cents
    const user = { p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] };
    assert.ok(Math.abs(cnmcTotal({ fixed: y.fixedPerYear, pp1: y.pp1, pp2: y.pp2, energy: y.energy, ...user }) - cnmcTotal({ ...pr, ...user })) <= 0.05, `${name} user total`);
  }
  // a non-linear offer (tranche price above 2 000 kWh punta) fits the six equations but fails the verification
  // against the CNMC total of the user's own profile
  const tranche = (p) => { const e = p.kwh[0] > 2000 ? 0.25 : 0.15; return cnmcTotal({ fixed: 9.01, pp1: 30, pp2: 2, energy: [e, 0.12, 0.09], p1: p.p1, p2: p.p2, kwh: p.kwh }); };
  const yy = solveYear(Object.fromEntries(DERIVATION_LISTS.map((d) => [d.id, tranche(d)])));
  const user = { p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] };
  const o = offerFromCnmc(item({ importePrimerAnio: tranche(user), importeSegundoAnio: tranche(user) }), { first: yy, second: yy, method: 'lists' }, { user });
  assert.equal(o.cnmc.verified, false, JSON.stringify(o.cnmc));
  assert.ok(Math.abs(o.cnmc.delta) > 5);
});

test('yearToPrices maps the solved year to the app\'s PricesES shape and simulateES agrees with the CNMC', () => {
  const pIb = yearToPrices(solveYear(totalsFor(IB)));
  assert.deepEqual(Object.keys(pIb.energy), ['punta', 'llano', 'valle']);
  assert.ok(!pIb.bonoSocialIncluded && !pIb.feePerMonth);
  const pEn = yearToPrices(solveYear(totalsFor(EN2)));
  assert.ok(pEn.energy.single != null && pEn.bonoSocialIncluded === true, JSON.stringify(pEn));
  const pFee = yearToPrices(solveYear(totalsFor({ fixed: 9.01 + 60, pp1: 30, pp2: 2, energy: [0.15, 0.12, 0.09] })));
  assert.ok(Math.abs(pFee.feePerMonth - 5) < 0.02, JSON.stringify(pFee));
  // our bill simulator with the CNMC's regulated inputs (meter 9,72 €/año) reproduces the comparator's figures
  const profile = { days: 365, power: { p1: 4.6, p2: 4.6 }, kwh: { punta: 1029, llano: 1017, valle: 1218 }, meterRentPerDay: 9.72 / 365 };
  assert.ok(Math.abs(simulateES(profile, pIb, RULES_ES_2026).total - 829.31) < 0.1);
  const simEn = simulateES(profile, pEn, RULES_ES_2026);
  assert.ok(Math.abs(simEn.total - 788.36) < 0.1, `energya ${simEn.total}`);
  assert.equal(simEn.bonoSocial, 0, 'no separate bono social line when it is inside the prices');
  assert.match(simEn.lines.find((l) => l.id === 'bono_social').label, /incluida/);
});

const lists = (offers) => Object.fromEntries(DERIVATION_LISTS.map((d) => [d.id, { resultadoComparador: offers.filter((o) => !o.skip || !o.skip.includes(d.id)).map((o) => ({ ...o.item, importePrimerAnio: cnmcTotal({ ...o.y1, p1: d.p1, p2: d.p2, kwh: d.kwh }), importeSegundoAnio: o.y2 ? cnmcTotal({ ...o.y2, p1: d.p1, p2: d.p2, kwh: d.kwh }) : 0 })) }]));

test('derivePricesFromLists + offerFromCnmc: fixed, promo, PVPC, flexible and verification flag', () => {
  const user = { p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218] };
  const offers = [
    { item: item({ id: 4628, idHistorico: 369 }), y1: IB, y2: IB },
    { item: item({ id: 5356, idHistorico: 116, idComercializadora: 16, comercializadora: 'ENERGYA VM GESTION DE ENERGÍA, S.L', oferta: 'Fórmula Fija Única 24HORAS', validez: 'Oferta válida solo para nuevos clientes', tienePrecioUnico: 'S', verde: false }), y1: EN1, y2: EN2 },
    { item: item({ id: 180, idHistorico: 36, idComercializadora: 7, comercializadora: 'Comercializadora de referencia', oferta: 'PVPC Histórico 08/09/2025 - 08/09/2026', tipoElectricidad: 'PVPC', tienePrecioUnico: null }), y1: { fixed: 9.01, pp1: 30.67, pp2: 1.42, energy: [0.19, 0.14, 0.11] }, y2: null },
    { item: item({ id: 7094, idHistorico: 12, idComercializadora: 15, comercializadora: 'REPSOL COMERCIALIZADORA DE ELECTRICIDAD Y GAS, S.L.U', oferta: 'Tarifa 10 horas con descuento', tipoElectricidad: 'FFF', tienePrecioUnico: null }), y1: IB, y2: IB },
  ];
  const L = lists(offers);
  const solved = derivePricesFromLists(L);
  assert.equal(solved.size, 4);
  const ib = solved.get('4628/369');
  assert.ok(ib.first && ib.second && ib.present.length === 6);
  // the user's own list carries the CNMC totals for the user's profile
  const userList = { resultadoComparador: offers.map((o) => ({ ...o.item, importePrimerAnio: cnmcTotal({ ...o.y1, ...user }), importeSegundoAnio: o.y2 ? cnmcTotal({ ...o.y2, ...user }) : 0 })) };
  const market = buildMarket(userList, solved, { date: '2026-09-08', user });
  assert.equal(market.offers.length, 4);
  const [oIb, oEn, oPvpc, oRep] = market.offers;
  assert.equal(oIb.supplierCode, 'IBERDROLA'); assert.equal(oIb.type, 'fixed3'); assert.equal(oIb.id, 'CNMC-4628');
  assert.ok(oIb.cnmc.verified === true, JSON.stringify(oIb.cnmc));
  assert.ok(Math.abs(oIb.energy.punta - 0.192890) < 1.5e-5 && Math.abs(oIb.power.p1 * 365 - 33.242078) < 0.02);
  assert.equal(oIb.newClientsOnly, false); assert.equal(oIb.renewable, true); assert.match(oIb.source.name, /CNMC \(oferta n\.º 4628\)/);
  assert.equal(oEn.supplierCode, 'ENERGYAVM'); assert.equal(oEn.type, 'fixed'); assert.ok(oEn.energy.single != null && oEn.bonoSocialIncluded);
  assert.ok(oEn.after && oEn.promoText && Math.abs(oEn.after.energy.single - 0.1391) < 1.5e-5, JSON.stringify(oEn));
  assert.ok(Math.abs(oEn.energy.single - 0.130527) < 1.5e-5); assert.equal(oEn.newClientsOnly, true);
  assert.equal(oPvpc.type, 'pvpc'); assert.ok(oPvpc.regulated && oPvpc.indexed && oPvpc.supplierCode === 'PVPC' && oPvpc.prices);
  assert.equal(oRep.type, 'flexible'); assert.equal(oRep.prices, false); assert.equal(oRep.supplierCode, 'REPSOL'); assert.ok(oRep.cnmc.firstYear > 0);
  // the market feeds the simulator: flexible offers are skipped, the others ranked
  const profile = { days: 31, power: { p1: 4.6, p2: 4.6 }, kwh: { punta: 97, llano: 60, valle: 119 } };
  const sim = market.offers.filter((o) => o.prices !== false).map((o) => simulateES(profile, { energy: o.energy, power: o.power, feePerMonth: o.feePerMonth || 0, bonoSocialIncluded: !!o.bonoSocialIncluded }));
  assert.equal(sim.length, 3);
  assert.deepEqual(market.suppliers.map((s) => s.code).sort(), ['ENERGYAVM', 'IBERDROLA', 'PVPC', 'REPSOL']);
});

test('offers missing from a derivation list are solved from three detail calls', () => {
  const breakdown = (pr, p) => { const power = pr.pp1 * p.p1 + pr.pp2 * p.p2, energy = p.kwh[0] * pr.energy[0] + p.kwh[1] * pr.energy[1] + p.kwh[2] * pr.energy[2]; return [{ cabecera: 'Término fijo', valor: pr.fixed }, { cabecera: 'Término de potencia', valor: Math.round(power * 100) / 100 }, { cabecera: 'Consumo electricidad', valor: Math.round(energy * 100) / 100 }, { cabecera: 'Impuesto sobre electricidad 5,11269632%', valor: 1 }, { cabecera: 'Equipo de medida', valor: 9.72 }]; };
  const details = [{ p1: 10, p2: 15, kwh: [10000, 0, 0] }, { p1: 10, p2: 10, kwh: [0, 10000, 0] }, { p1: 10, p2: 10, kwh: [0, 0, 10000] }].map((p) => ({ datosElectricidadPrimerAnio: breakdown(EN1, p), datosElectricidadSegundoAnio: breakdown(VI, p) }));
  const s = derivePricesFromDetails(details);
  assert.ok(Math.abs(s.first.energy[0] - 0.130527) < 1e-6 && Math.abs(s.first.pp1 - 32.94) < 0.01 && Math.abs(s.first.pp2 - 1.10) < 0.01 && s.first.fixedPerYear === 0);
  assert.ok(Math.abs(s.second.energy[2] - 0.119806) < 1e-6 && Math.abs(s.second.pp1 - 27.704413) < 0.01);
  const o = offerFromCnmc(item({ id: 9, idHistorico: 1 }), s, { date: '2026-09-08' });
  assert.ok(o.prices && o.after && o.cnmc.method === 'detail');
});

test('brands, params and URLs', () => {
  assert.deepEqual(brandOf('DOMESTICA GAS Y ELECTRICIDAD SLU', 196).code, 'VISALIA');
  assert.equal(brandOf('ENERGYA VM GESTION DE ENERGÍA, S.L', 16).name, 'Enérgya-VM');
  assert.equal(brandOf('Comercializadora de referencia', 7).code, 'PVPC');
  assert.deepEqual(brandOf('SUMINISTROS ESPECIALES ALGINETENSES S.COOP V.', 55).code, 'ALGINET');
  const unknown = brandOf('LUZ DEL VALLE ENERGÍA, S.L.U.', 321);
  assert.equal(unknown.code, 'CNMC321'); assert.equal(unknown.name, 'Luz Del Valle Energía');
  assert.ok(BRAND_LIST.some((b) => b.code === 'ENDESA') && BRAND_LIST.filter((b) => b.code === 'PVPC').length === 1);
  const params = cnmcParams({ cp: '28001', p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1218], now: Date.UTC(2026, 8, 8, 10) });
  assert.equal(params.consumoAnualE, 3264); assert.equal(params.potenciaSegundaFranja, 4.6); assert.equal(params.perfilConsumo, 13); assert.equal(params.serviciosAdicionales, 2); assert.equal(params.tarifa, 4);
  assert.equal(params.dateFin, Date.UTC(2026, 8, 8)); assert.equal(params.dateInicio, Date.UTC(2026, 8, 8) - 365 * 86400000);
  assert.equal(Object.keys(params).length, 60, 'full parameter set (a reduced one is answered with HTTP 500)');
  assert.equal(cnmcParams({ cp: 'abc', p1: 3, kwh: [1, 2, 3] }).codigoPostal, '28001');
  assert.match(listUrl('api/cnmc/', { p1: 4, p2: 4, kwh: [3000, 0, 0] }), /^api\/cnmc\/ofertas\/electricidad\?tipoSuministro=E&codigoPostal=28001&potencia=4&/);
  assert.match(detailUrl('https://comparador.cnmc.gob.es/api/publico/', 4628, 369, { p1: 1, p2: 2, kwh: [1000, 0, 0] }), /oferta\?idOferta=4628&idHistorico=369&tipoSuministro=E/);
  assert.deepEqual(annualProfile({ days: 31, power: { p1: 4.6, p2: 4.6 }, kwh: { punta: 87.4, llano: 86.4, valle: 103.4 } }), { p1: 4.6, p2: 4.6, kwh: [1029, 1017, 1217] });
  assert.equal(cnmcQuery({ a: 1, b: true }), 'a=1&b=true');
});
