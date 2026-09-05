#!/usr/bin/env node
// Cross-checks / refreshes the Spanish offer list against the official CNMC comparator.
//
//   node scripts/update-cnmc.mjs                 -> queries the CNMC API for the reference profile
//                                                   (4,6 kW, 3.264 kWh/año split 35/22/43 – the user's bill)
//                                                   and prints every offer it returns (annual cost, supplier, name)
//   node scripts/update-cnmc.mjs --cp 28001 --p1 4.6 --p2 4.6 --kwh 1147,710,1407 --json out.json
//
// The CNMC comparator (https://comparador.cnmc.gob.es) has no public download; its web app
// calls an undocumented JSON API that (a) rejects requests carrying an Origin header and
// (b) is not reachable from every network. This script therefore runs on YOUR machine, never
// in the browser. The response only contains annual totals per offer, not unit prices, so
// public/data/ofertas-es.json (unit prices, curated from the suppliers' websites) is NOT
// overwritten automatically – use the output to spot offers that are missing or outdated.
//
// If the API is unreachable, open the deep link printed at the end in a browser instead: it
// is the same link the app puts behind the "Comprobar en el comparador oficial CNMC" button.
import { writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const cp = String(args.cp || '28001');
const p1 = +(args.p1 || 4.6), p2 = +(args.p2 || args.p1 || 4.6);
const [c1, c2, c3] = String(args.kwh || '1147,710,1407').split(',').map(Number);   // kWh/year punta, llano, valle
const now = Date.now(), yearAgo = now - 365 * 86400000;

const params = {
  tipoSuministro: 'E', codigoPostal: cp,
  potencia: p1, potenciaPrimeraFranja: p1, potenciaSegundaFranja: p2, potenciaTerceraFranja: p1, potenciaCuartaFranja: p1, potenciaQuintaFranja: p1, potenciaSextaFranja: p1,
  consumoAnualE: c1 + c2 + c3, consumoAnualEOrig: c1 + c2 + c3,
  consumoPrimeraFranja: c1, consumoSegundaFranja: c2, consumoTerceraFranja: c3, consumoCuartaFranja: 0, consumoQuintaFranja: 0, consumoSextaFranja: 0,
  consumoAnualEQr: 0, consumoPrimeraFranjaQr: 0, consumoSegundaFranjaQr: 0, consumoTerceraFranjaQr: 0, consumoCuartaFranjaQr: 0, consumoQuintaFranjaQr: 0, consumoSextaFranjaQr: 0,
  consumoAnualEPQr: 0, consumoPrimeraFranjaPQr: 0, consumoSegundaFranjaPQr: 0, consumoTerceraFranjaPQr: 0, consumoCuartaFranjaPQr: 0, consumoQuintaFranjaPQr: 0, consumoSextaFranjaPQr: 0,
  tarifa: 4, consumoAnualG: 0, consumoAnualGOrig: 0, serviciosAdicionales: 2, permanencia: 2, vivienda: true, factura: true,
  energiaAutoconsumo: 0, idAuditoriaQR: 0, potenciaAutoconsumo: 0, revisionPrecios: 2, autoconsumo: false, importe: 0,
  mecanismoAjuste: 0, mecanismoAjusteIVA: 0, importeMecanismoAjustePunta: 0, importeMecanismoAjusteLlano: 0, importeMecanismoAjusteValle: 0,
  precioConsumoMecanismoAjusteTotal: 0, precioConsumoMecanismoAjustePunta: 0, precioConsumoMecanismoAjusteLlano: 0, precioConsumoMecanismoAjusteValle: 0,
  perfilConsumo: 13, dateInicio: yearAgo, dateFin: now, fFact: now, cups: '0000', perfilConsumoG: 0, potenciaAutoconsumoG: 0,
};
const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
const url = `https://comparador.cnmc.gob.es/api/publico/ofertas/electricidad?${qs}`;
const deepLink = `https://comparador.cnmc.gob.es/comparador/QRE?cp=${cp}&pP1=${p1}&pP2=${p2}&caP1=${c1}&caP2=${c2}&caP3=${c3}&iniA=${new Date(yearAgo).toISOString().slice(0, 10)}&tc=F0&finContrato=${new Date(now + 365 * 86400000).toISOString().slice(0, 10)}`;

console.log(`CNMC comparator – perfil: ${p1}/${p2} kW, ${c1 + c2 + c3} kWh/año (punta ${c1} · llano ${c2} · valle ${c3}), CP ${cp}`);
try {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'Accept-Language': 'es-ES,es;q=0.9', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Referer: 'https://comparador.cnmc.gob.es/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const list = data.resultadoComparador || data.ofertas || data;
  if (!Array.isArray(list)) throw new Error('unexpected response shape: ' + JSON.stringify(data).slice(0, 200));
  const rows = list.map((o) => ({
    supplier: o.comercializadora || o.nombreComercializadora || o.empresa, name: o.oferta || o.nombreOferta || o.nombre,
    yearCost: o.importePrimerAnio ?? o.importeAnual ?? o.importe, yearCost2: o.importeSegundoAnio, type: o.tipoOferta || o.tipo,
    permanence: o.permanencia, services: o.serviciosAdicionales, url: o.urlOferta || o.url,
  })).sort((a, b) => (a.yearCost ?? 1e9) - (b.yearCost ?? 1e9));
  console.log(`${rows.length} ofertas devueltas por la CNMC (coste anual estimado, 1.er año / 2.º año):`);
  for (const r of rows) console.log(`  ${String(r.yearCost?.toFixed?.(2) ?? r.yearCost).padStart(9)} € ${r.yearCost2 != null ? '/ ' + String(r.yearCost2.toFixed?.(2) ?? r.yearCost2).padStart(9) + ' €' : '             '}  ${r.supplier} – ${r.name}`);
  if (args.json) { writeFileSync(String(args.json), JSON.stringify({ fetchedAt: new Date().toISOString(), profile: { cp, p1, p2, kwh: [c1, c2, c3] }, offers: rows, raw: data }, null, 2)); console.log(`guardado en ${args.json}`); }
  console.log('\nCompare esta lista con public/data/ofertas-es.json y actualice los precios unitarios desde la web de cada comercializadora.');
} catch (e) {
  console.error(`\nNo se ha podido consultar la API de la CNMC (${e.message}).`);
  console.error('Abra este enlace en el navegador para ver el comparador oficial con el mismo perfil:\n  ' + deepLink);
  process.exitCode = 1;
}
