// "Mercado completo" – loads EVERY 2.0TD offer registered in the official CNMC comparator, live, and turns the
// comparator's published annual totals into the unit prices the app needs for its line-by-line comparison.
//
// Seven requests through the site's /api/cnmc/ proxy (cloudflare/_worker.js in production, server.mjs locally):
// six fixed "derivation" lists (identical for every user, so the edge caches them) that let us solve the prices of
// all offers at once (see public/lib/cnmc.js), plus one list for the user's own profile that says which offers
// apply to it and what the CNMC itself estimates for each (used to verify our reconstruction, to the cent).
import { CNMC_PROXY, annualProfile, listUrl, detailUrl, DERIVATION_LISTS, DETAIL_PROFILES, derivePricesFromLists, derivePricesFromDetails, buildMarket, offerKey, offerFromCnmc } from './lib/cnmc.js';

const today = () => new Date().toISOString().slice(0, 10);

async function getJson(fetchImpl, url, { timeoutMs = 90000 } = {}) {
  const opts = { cache: 'default' };
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) opts.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetchImpl(url, opts);
  if (!res || !res.ok) {
    let msg = `HTTP ${res?.status ?? '???'}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

/**
 * @param profile {days, power{p1,p2}, kwh{punta,llano,valle}} – the bill's profile (annualised here)
 * @returns {{offers, suppliers, user, meta, unpriced:number, fallback:number}}
 */
export async function loadCnmcMarket(profile, { cp = '', onProgress = null, fetchImpl = (u, o) => fetch(u, o), base = CNMC_PROXY, maxDetail = 10 } = {}) {
  const user = annualProfile(profile);
  const userProfile = { cp, p1: user.p1, p2: user.p2, kwh: user.kwh };
  const jobs = [...DERIVATION_LISTS.map((d) => ({ id: d.id, url: listUrl(base, d) })), { id: 'user', url: listUrl(base, userProfile) }];
  const lists = {};
  let done = 0;
  onProgress?.(0, jobs.length);
  await Promise.all(jobs.map(async (j) => {
    lists[j.id] = await getJson(fetchImpl, j.url);
    if (!Array.isArray(lists[j.id]?.resultadoComparador)) throw new Error(`respuesta inesperada de la CNMC (${j.id})`);
    onProgress?.(++done, jobs.length);
  }));
  const solved = derivePricesFromLists(lists);
  // offers of the user's list that are missing from some derivation list (power/consumption limits): 3 detail calls each
  const userItems = lists.user.resultadoComparador;
  const missing = userItems.filter((it) => !(solved.get(offerKey(it))?.first));
  const detailsByKey = new Map();
  let fallback = 0;
  for (const it of missing.slice(0, maxDetail)) {
    try {
      const details = await Promise.all(DETAIL_PROFILES.map((p) => getJson(fetchImpl, detailUrl(base, it.id, it.idHistorico, { cp, ...p }))));
      solved.set(offerKey(it), { ...derivePricesFromDetails(details), item: it });
      detailsByKey.set(offerKey(it), details[0]);
      fallback++;
    } catch { /* stays unpriced */ }
  }
  const date = today();
  const market = buildMarket(lists.user, solved, { date, user, detailsByKey });
  const unpriced = market.offers.filter((o) => !o.prices).length;
  const verified = market.offers.filter((o) => o.cnmc?.verified).length;
  return {
    ...market, user, unpriced, fallback,
    meta: {
      country: 'ES', market: '2.0TD', live: true, publishedAt: date, source: 'Comparador oficial CNMC (comparador.cnmc.gob.es) – consulta en vivo', official: true,
      offers: market.offers.length, suppliers: market.suppliers.length, priced: market.offers.length - unpriced, verified,
      profile: { cp: cp || null, ...user },
      note: 'Precios unitarios derivados de los importes anuales publicados por el comparador de la CNMC para seis perfiles de referencia (el cálculo del comparador es lineal en potencia y consumo). Cada tarifa se verifica reproduciendo el importe anual que la CNMC publica para su perfil.',
    },
  };
}

/** Conditions of one offer (detail endpoint), fetched lazily when the user opens "Detalle". */
export async function loadCnmcOfferDetail(offer, profile, { cp = '', fetchImpl = (u, o) => fetch(u, o), base = CNMC_PROXY } = {}) {
  const user = annualProfile(profile);
  const detail = await getJson(fetchImpl, detailUrl(base, offer.cnmcId, offer.cnmcHist, { cp, p1: user.p1, p2: user.p2, kwh: user.kwh }), { timeoutMs: 45000 });
  const item = { id: offer.cnmcId, idHistorico: offer.cnmcHist, comercializadora: offer.legalName || offer.supplier, idComercializadora: 0, oferta: offer.name, tipoElectricidad: offer.regulated ? 'PVPC' : 'TE', importePrimerAnio: offer.cnmc?.firstYear, importeSegundoAnio: offer.cnmc?.secondYear, validez: offer.cnmc?.validez, penalizacion: offer.permanence, verde: offer.renewable, serviciosAdicionales: offer.servicesIncluded, tipoServicioAdicional: offer.servicesText };
  const enriched = offerFromCnmc(item, null, { detail, date: offer.source?.date });
  const total = (rows) => +(rows || []).find((r) => /^total$/i.test(String(r.cabecera || '')))?.valor || null;
  return {
    notes: enriched.notes || '', validity: enriched.validity || null, priceRevision: enriched.priceRevision || null,
    maxPower: enriched.maxPower || null, minPower: enriched.minPower || null, maxKwhYear: enriched.maxKwhYear || null,
    contracting: enriched.cnmc?.contracting || [], webOferta: detail?.caracteristicas?.webOferta || null, webContrato: detail?.caracteristicas?.webContrato || null,
    infoAdicional: detail?.caracteristicas?.infoAdicional || null, condicionesRevision: detail?.caracteristicas?.condicionesRevisionPrecios || null,
    atencionCliente: detail?.caracteristicas?.atencionCliente || null,
    totals: { first: total(detail?.datosGeneralesPrimerAnio), second: total(detail?.datosGeneralesSegundoAnio) },
    breakdown: { first: detail?.datosElectricidadPrimerAnio || [], second: detail?.datosElectricidadSegundoAnio || [] },
  };
}
