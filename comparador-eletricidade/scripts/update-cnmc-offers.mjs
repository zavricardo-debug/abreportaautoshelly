#!/usr/bin/env node
// Builds public/data/ofertas-es.json from the OFFICIAL CNMC comparator (https://comparador.cnmc.gob.es):
// every 2.0TD household electricity offer registered by the comercializadoras, with unit prices derived from
// the comparator's own calculator. Same maths as the browser's "Mercado completo" mode (public/lib/cnmc.js);
// this snapshot is the fallback the app uses when the CNMC cannot be reached.
//
//   npm run data:cnmc                                   -> writes public/data/ofertas-es.json + reports/cnmc-update.json
//   node scripts/update-cnmc-offers.mjs --dry           -> prints the summary, writes nothing
//   node scripts/update-cnmc-offers.mjs --no-detail     -> skip the per-offer detail calls (conditions/limits)
//   node scripts/update-cnmc-offers.mjs --cp 08001 --p1 4.6 --p2 4.6 --kwh 1029,1017,1218   (reference profile)
//   node scripts/update-cnmc-offers.mjs --from-dir DIR  -> offline: DIR holds L1.json … L6.json + user.json + <id>-<hist>.json
//
// Requests: 6 derivation lists + 1 list per reference profile (+ 1 detail per offer unless --no-detail).
// Run it from a machine with internet access (the CNMC API blocks some networks) – it takes 1–3 minutes.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CNMC_API, DERIVATION_LISTS, DETAIL_PROFILES, listUrl, detailUrl, derivePricesFromLists, derivePricesFromDetails, offerKey, buildMarket, annualProfile } from '../public/lib/cnmc.js';
import { RULES_ES_2026, simulateES } from '../public/lib/simulator-es.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const OUT = resolve(ROOT, String(args.out || 'public/data/ofertas-es.json'));
const REPORT = resolve(ROOT, 'reports/cnmc-update.json');
const DRY = !!args.dry;
const DETAIL = !args['no-detail'];
const DELAY_MS = +(args.delay || 300);
const FROM_DIR = args['from-dir'] ? resolve(ROOT, String(args['from-dir'])) : null;

// Reference profiles listed in the snapshot: the union of their offers is what the app can show offline.
const REF = [
  { id: 'std', cp: String(args.cp || '28001'), p1: +(args.p1 || 4.6), p2: +(args.p2 || args.p1 || 4.6), kwh: String(args.kwh || '1029,1017,1218').split(',').map(Number) },
  { id: 'small', cp: String(args.cp || '28001'), p1: 3.45, p2: 3.45, kwh: [540, 470, 790] },
  { id: 'large', cp: String(args.cp || '28001'), p1: 6.9, p2: 6.9, kwh: [1950, 1700, 2850] },
];

const HEADERS = { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'es-ES,es;q=0.9', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

async function getJson(url, name) {
  if (FROM_DIR) {
    const f = resolve(FROM_DIR, `${name}.json`);
    if (!existsSync(f)) throw new Error(`missing ${f}`);
    return JSON.parse(readFileSync(f, 'utf8'));
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      await sleep(DELAY_MS);
      return j;
    } catch (e) {
      if (attempt === 3) throw new Error(`${name}: ${e.message}`);
      console.warn(`  retry ${attempt} ${name}: ${e.message}`);
      await sleep(2000 * attempt);
    }
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`CNMC comparator import – ${FROM_DIR ? 'offline from ' + FROM_DIR : CNMC_API}`);
  // 1. six derivation lists (prices of every offer at once)
  const lists = {};
  for (const d of DERIVATION_LISTS) {
    process.stdout.write(`  list ${d.id} (P ${d.p1}/${d.p2} kW · ${d.kwh.join('/')} kWh) … `);
    lists[d.id] = await getJson(listUrl(CNMC_API, d), d.id);
    console.log(`${lists[d.id].resultadoComparador?.length ?? 0} offers`);
  }
  const solved = derivePricesFromLists(lists);
  // 2. reference profiles: which offers apply + the CNMC's own figures for them (verification)
  const refLists = {};
  for (const p of REF) {
    process.stdout.write(`  profile ${p.id} (${p.p1}/${p.p2} kW · ${p.kwh.join('/')} kWh · CP ${p.cp}) … `);
    refLists[p.id] = await getJson(listUrl(CNMC_API, p), p.id === 'std' ? 'user' : p.id);
    console.log(`${refLists[p.id].resultadoComparador?.length ?? 0} offers`);
  }
  // union of the offers of the reference profiles (the std one first, keeps the CNMC ordering)
  const items = new Map();
  for (const p of REF) for (const it of refLists[p.id].resultadoComparador || []) if (!items.has(offerKey(it))) items.set(offerKey(it), { ...it, _profile: p.id });
  // 3. offers missing from a derivation list -> per-offer detail derivation; details for conditions of every offer
  const detailsByKey = new Map();
  let n = 0;
  for (const [k, it] of items) {
    n++;
    const need = !solved.get(k)?.first;
    if (!need && !DETAIL) continue;
    const std = REF[0];
    try {
      if (need) {
        const det = [];
        for (const pr of DETAIL_PROFILES) det.push(await getJson(detailUrl(CNMC_API, it.id, it.idHistorico, { cp: std.cp, ...pr }), `${it.id}-${it.idHistorico}-${pr.id}`));
        solved.set(k, { ...derivePricesFromDetails(det), item: it });
        detailsByKey.set(k, det[0]);
        console.log(`  ${n}/${items.size} ${it.comercializadora} – ${it.oferta}: prices from detail calls`);
      } else {
        detailsByKey.set(k, await getJson(detailUrl(CNMC_API, it.id, it.idHistorico, { cp: std.cp, p1: std.p1, p2: std.p2, kwh: std.kwh }), `${it.id}-${it.idHistorico}`));
        if (n % 20 === 0) console.log(`  ${n}/${items.size} details…`);
      }
    } catch (e) {
      console.warn(`  ${n}/${items.size} ${it.comercializadora} – ${it.oferta}: ${e.message}`);
    }
  }
  // 4. dataset
  const date = new Date().toISOString().slice(0, 10);
  const std = REF[0];
  const user = { p1: std.p1, p2: std.p2, kwh: std.kwh };
  const market = buildMarket({ resultadoComparador: [...items.values()] }, solved, { date, user, detailsByKey });
  // offers of the other profiles were not queried for the std profile: verification only applies to std's
  for (const o of market.offers) { const it = items.get(`${o.cnmcId}/${o.cnmcHist}`); if (it?._profile !== 'std' && o.cnmc) { delete o.cnmc.verified; delete o.cnmc.delta; delete o.cnmc.ours; o.cnmc.listedFor = it._profile; } }
  const priced = market.offers.filter((o) => o.prices);
  const verified = market.offers.filter((o) => o.cnmc?.verified);
  const unverified = market.offers.filter((o) => o.cnmc && o.cnmc.verified === false);
  if (priced.length < 20) throw new Error(`only ${priced.length} priced offers – refusing to overwrite the dataset`);
  const dataset = {
    meta: {
      country: 'ES', market: '2.0TD', publishedAt: date,
      source: 'Comparador oficial CNMC (comparador.cnmc.gob.es)', official: true,
      offers: market.offers.length, suppliers: market.suppliers.length, priced: priced.length, verified: verified.length,
      profiles: REF.map((p) => ({ id: p.id, cp: p.cp, p1: p.p1, p2: p.p2, kwh: p.kwh, listed: refLists[p.id].resultadoComparador?.length || 0 })),
      note: 'Todas las ofertas 2.0TD para viviendas registradas en el comparador oficial de la CNMC para los perfiles de referencia. Precios unitarios derivados de los importes anuales que publica el comparador para seis perfiles de referencia (su cálculo es lineal en potencia y consumo) y verificados reproduciendo el importe anual publicado para el perfil estándar. Regenerar con: npm run data:cnmc',
    },
    rules: RULES_ES_2026,
    suppliers: market.suppliers,
    offers: market.offers,
  };
  // 5. sanity ranking for the reference bill (31 days, 4,6 kW, 277 kWh)
  const profile = { days: 31, power: { p1: std.p1, p2: std.p2 }, kwh: { punta: std.kwh[0] * 31 / 365, llano: std.kwh[1] * 31 / 365, valle: std.kwh[2] * 31 / 365 } };
  const ranking = priced.map((o) => ({ o, t: simulateES(profile, { energy: o.energy, power: o.power, feePerMonth: o.feePerMonth || 0, bonoSocialIncluded: !!o.bonoSocialIncluded }, RULES_ES_2026).total })).sort((a, b) => a.t - b.t);
  console.log(`\n${market.offers.length} offers · ${market.suppliers.length} comercializadoras · ${priced.length} with unit prices · ${verified.length} verified to the cent · ${unverified.length} with a deviation`);
  for (const u of unverified) console.log(`  ! ${u.supplier} – ${u.name}: ours ${u.cnmc.ours} vs CNMC ${u.cnmc.firstYear} (${u.cnmc.delta > 0 ? '+' : ''}${u.cnmc.delta})`);
  console.log('\nCheapest for the reference bill (31 days):');
  for (const { o, t } of ranking.slice(0, 12)) console.log(`  ${t.toFixed(2).padStart(7)} €  ${o.supplier} – ${o.name}${o.promoText ? ' (promo)' : ''}${o.cnmc?.verified ? ' ✓' : ''}`);
  const report = { date, seconds: r2((Date.now() - t0) / 1000), offers: market.offers.length, suppliers: market.suppliers.length, priced: priced.length, verified: verified.length, unverified: unverified.map((u) => ({ id: u.cnmcId, supplier: u.supplier, name: u.name, ours: u.cnmc.ours, cnmc: u.cnmc.firstYear })), unpriced: market.offers.filter((o) => !o.prices).map((o) => ({ id: o.cnmcId, supplier: o.supplier, name: o.name })), ranking: ranking.slice(0, 30).map(({ o, t }) => ({ total31d: t, supplier: o.supplier, name: o.name })) };
  if (DRY) { console.log('\n--dry: nothing written'); return; }
  mkdirSync(dirname(OUT), { recursive: true }); mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(dataset, null, 1) + '\n');
  writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nwritten ${OUT}\nreport  ${REPORT}\nnext: npm test && npm run build`);
}

main().catch((e) => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
