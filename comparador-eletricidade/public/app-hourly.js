// Hour-by-hour view of a tariff's energy cost with the user's REAL consumption curve.
// Used by the detail modal of both flows: every hour (ES) / quarter-hour (PT) of the file is
// classified into the tariff period it falls in and multiplied by the price of that period, so
// the user can see WHERE in the day a tariff wins or loses against the current one.
import { period20TD, PERIODS as PERIODS_ES } from './lib/consumption-es.js';
import { periodFor, seasonOf, dayTypeOf, PERIOD_LABELS_PT } from './lib/consumption-pt.js';
import { PERIOD_KEYS } from './lib/simulator.js';

const p2 = (n) => String(n).padStart(2, '0');
const LABELS_ES = { punta: 'Punta', llano: 'Llano', valle: 'Valle' };
const newRow = (hour, keys) => ({ hour, kwh: 0, byDay: {}, offer: Object.fromEntries(keys.map((k) => [k, 0])), base: Object.fromEntries(keys.map((k) => [k, 0])), costOffer: 0, costBase: 0 });

/**
 * Spain (2.0TD). `hours` = curve.hours of the scope used in the comparison ([{date, hour, kwh, period}]).
 * offer / base = price sets ({ energy: {single} | {punta,llano,valle} }); `scale` rescales the curve to the billed kWh;
 * `shift` = what-if fraction of punta+llano energy moved to valle (applied to the offer only, like the results table).
 */
export function hourlyRowsES(hours, { scale = 1, shift = 0, offer, base, ceutaMelilla = false } = {}) {
  const priceOf = (pr, k) => !pr?.energy ? 0 : pr.energy.punta != null ? +pr.energy[k] || 0 : +pr.energy.single || 0;
  const kinds = new Map();
  const kindOf = (date) => { let k = kinds.get(date); if (!k) { const [y, m, d] = date.split('-').map(Number); k = period20TD(new Date(y, m - 1, d), 12, { ceutaMelilla }) === 'valle' ? 'weekend' : 'weekday'; kinds.set(date, k); } return k; };
  let moved = 0, valleTotal = 0, nValle = 0;
  if (shift > 0) for (const h of hours) { if (h.period === 'valle') { valleTotal += h.kwh; nValle++; } else moved += h.kwh * shift; }
  const rows = Array.from({ length: 24 }, (_, i) => newRow(i, PERIODS_ES));
  const days = { weekday: new Set(), weekend: new Set() };
  for (const h of hours) {
    const r = rows[h.hour]; if (!r) continue;
    const kwh = h.kwh * scale, kind = kindOf(h.date);
    days[kind].add(h.date);
    r.kwh += kwh; r.byDay[kind] = (r.byDay[kind] || 0) + kwh;
    r.base[h.period] += kwh; r.costBase += kwh * priceOf(base, h.period);
    const ok = shift > 0 ? (h.period === 'valle' ? kwh + moved * scale * (valleTotal ? h.kwh / valleTotal : 1 / (nValle || 1)) : kwh * (1 - shift)) : kwh;
    r.offer[h.period] += ok; r.costOffer += ok * priceOf(offer, h.period);
  }
  return finish(rows, { periods: PERIODS_ES, labels: LABELS_ES, dayCounts: { weekday: days.weekday.size, weekend: days.weekend.size } });
}

/**
 * Portugal (ciclos ERSE). `quarters` = curve.quarters ([{day, min, kwh}]); prices are arrays in PERIOD_KEYS order of each option.
 * The offer may be simulated in a different option than the bill (e.g. bi-horária offer vs. simples bill).
 */
export function hourlyRowsPT(quarters, { scale = 1, shift = 0, cycle = 'diario', offerOption = 1, offerPrices = [], baseOption = 1, basePrices = [] } = {}) {
  // a single-price tariff (simples) still gets its hours classified in ponta/cheias/vazio – informative, the price is the same anyway
  const priceFor = (opt, prices, per) => { if (+opt === 1) return +prices?.[0] || 0; const i = (PERIOD_KEYS[opt] || PERIOD_KEYS[1]).indexOf(per); return i >= 0 ? +prices?.[i] || 0 : 0; };
  const classOpt = (opt) => (+opt === 1 ? 3 : +opt);
  const info = new Map();
  const infoOf = (day) => { let e = info.get(day); if (!e) { const [y, m, d] = day.split('-').map(Number); const dt = new Date(y, m - 1, d); e = { season: seasonOf(dt), dayType: dayTypeOf(dt) }; info.set(day, e); } return e; };
  const perOffer = (q) => periodFor({ ...infoOf(q.day), minute: q.min, cycle, option: classOpt(offerOption) });
  const perBase = (q) => periodFor({ ...infoOf(q.day), minute: q.min, cycle, option: classOpt(baseOption) });
  const doShift = shift > 0 && +offerOption > 1;
  let moved = 0, vazioTotal = 0, nVazio = 0;
  if (doShift) for (const q of quarters) { if (perOffer(q) === 'vazio') { vazioTotal += q.kwh; nVazio++; } else moved += q.kwh * shift; }
  const keys = [...new Set([...PERIOD_KEYS[classOpt(offerOption)], ...PERIOD_KEYS[classOpt(baseOption)]])];
  const rows = Array.from({ length: 24 }, (_, i) => newRow(i, keys));
  const days = { util: new Set(), sabado: new Set(), domingo: new Set() };
  for (const q of quarters) {
    const r = rows[Math.floor(q.min / 60)]; if (!r) continue;
    const { dayType } = infoOf(q.day); days[dayType].add(q.day);
    const kwh = q.kwh * scale, po = perOffer(q), pb = perBase(q);
    r.kwh += kwh; r.byDay[dayType] = (r.byDay[dayType] || 0) + kwh;
    r.base[pb] += kwh; r.costBase += kwh * priceFor(baseOption, basePrices, pb);
    const ok = doShift ? (po === 'vazio' ? kwh + moved * scale * (vazioTotal ? q.kwh / vazioTotal : 1 / (nVazio || 1)) : kwh * (1 - shift)) : kwh;
    r.offer[po] += ok; r.costOffer += ok * priceFor(offerOption, offerPrices, po);
  }
  return finish(rows, { periods: PERIOD_KEYS[classOpt(offerOption)], labels: PERIOD_LABELS_PT, dayCounts: { util: days.util.size, sabado: days.sabado.size, domingo: days.domingo.size } });
}

function finish(rows, meta) {
  const total = { kwh: 0, costOffer: 0, costBase: 0 };
  for (const r of rows) { total.kwh += r.kwh; total.costOffer += r.costOffer; total.costBase += r.costBase; }
  for (const r of rows) r.share = total.kwh ? r.kwh / total.kwh : 0;
  return { rows, total, ...meta };
}

const T = {
  es: {
    title: 'Energía hora a hora con su consumo real',
    hour: 'Hora', period: 'Periodo', kwh: 'kWh', base: 'Su tarifa', offer: 'Esta tarifa', cost: 'Coste', diff: 'Diferencia', total: 'Total energía',
    chartBase: 'su tarifa', chartOffer: 'esta tarifa', avgPrice: 'precio medio',
  },
  pt: {
    title: 'Energia hora a hora com o seu consumo real',
    hour: 'Hora', period: 'Período', kwh: 'kWh', base: 'A sua tarifa', offer: 'Esta oferta', cost: 'Custo', diff: 'Diferença', total: 'Total energia',
    chartBase: 'a sua tarifa', chartOffer: 'esta oferta', avgPrice: 'preço médio',
  },
};

/**
 * HTML of the section (intro text, chart, table). `intro` is written by the caller (it knows the file, scope, cycle…).
 * @param {ReturnType<typeof hourlyRowsES>} data
 */
export function renderHourlySection(data, { lang = 'es', isBase = false, intro = '', note = '', fmtNum, fmtEur, esc }) {
  const t = T[lang] || T.es;
  const { rows, total, periods, labels } = data;
  const maxKwh = Math.max(1e-9, ...rows.map((r) => r.kwh));
  const maxCost = Math.max(1e-9, ...rows.map((r) => Math.max(r.costOffer, r.costBase)));
  const dominant = (r) => periods.reduce((m, k) => (r.offer[k] > (r.offer[m] || 0) ? k : m), periods[0]);
  const chips = (r) => periods.map((k) => [k, r.kwh ? r.offer[k] / Math.max(1e-9, periods.reduce((a, kk) => a + r.offer[kk], 0)) : 0]).filter(([, s]) => s >= 0.005).sort((a, b) => b[1] - a[1])
    .map(([k, s], i) => `<span class="pchip ${k}">${esc(labels[k] || k)}${i > 0 || s < 0.995 ? ` <small>${fmtNum(100 * s, 0)} %</small>` : ''}</span>`).join(' ');

  // chart: cost per hour of the day – grey = current tariff, coloured (by the offer's period) = this tariff
  const W = 720, H = 190, padL = 40, padB = 20, padT = 8, gw = (W - padL - 6) / 24;
  const yOf = (v) => padT + (H - padB - padT) * (1 - v / maxCost);
  let svg = '';
  for (const f of [0.25, 0.5, 0.75, 1]) { const y = yOf(maxCost * f); svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="2" y="${(y + 4).toFixed(1)}">${fmtNum(maxCost * f, 2)} €</text>`; }
  rows.forEach((r) => {
    const x = padL + r.hour * gw, label = `${p2(r.hour)}:00–${p2(r.hour + 1)}:00 · ${fmtNum(r.kwh, 1)} kWh`;
    if (isBase) svg += `<rect class="${dominant(r)}" x="${(x + 2).toFixed(1)}" y="${yOf(r.costOffer).toFixed(1)}" width="${(gw - 4).toFixed(1)}" height="${(H - padB - yOf(r.costOffer)).toFixed(1)}" rx="2"><title>${label} · ${fmtEur(r.costOffer)}</title></rect>`;
    else svg += `<rect class="base" x="${(x + 1.5).toFixed(1)}" y="${yOf(r.costBase).toFixed(1)}" width="${(gw / 2 - 2).toFixed(1)}" height="${(H - padB - yOf(r.costBase)).toFixed(1)}" rx="1.5"><title>${label} · ${t.chartBase}: ${fmtEur(r.costBase)}</title></rect>` +
      `<rect class="${dominant(r)}" x="${(x + gw / 2).toFixed(1)}" y="${yOf(r.costOffer).toFixed(1)}" width="${(gw / 2 - 2).toFixed(1)}" height="${(H - padB - yOf(r.costOffer)).toFixed(1)}" rx="1.5"><title>${label} · ${t.chartOffer}: ${fmtEur(r.costOffer)}</title></rect>`;
    if (r.hour % 2 === 0) svg += `<text x="${(x + gw / 2 - 6).toFixed(1)}" y="${H - 5}">${p2(r.hour)}</text>`;
  });
  const legend = `<div class="curve-legend">${isBase ? '' : `<span class="sw base"></span> ${t.chartBase} `}${periods.map((k) => `<span class="sw ${k}"></span> ${esc((labels[k] || k).toLowerCase())}`).join(' ')}${isBase ? '' : ` <span class="muted">(${t.chartOffer})</span>`}</div>`;

  const diffCell = (d) => `<td class="num diff ${d < -0.005 ? 'good' : d > 0.005 ? 'bad' : 'zero'}">${d === 0 ? '=' : (d < 0 ? '−' : '+') + fmtEur(Math.abs(d))}</td>`;
  const body = rows.map((r) => {
    const avg = r.kwh ? r.costOffer / r.kwh : 0;
    return `<tr><td>${p2(r.hour)}–${p2(r.hour + 1)}</td><td>${chips(r)}</td>` +
      `<td class="num"><span class="hbar" style="width:${(100 * r.kwh / maxKwh).toFixed(1)}%"></span>${fmtNum(r.kwh, 1)}<small class="muted"> ${fmtNum(100 * r.share, 1)} %</small></td>` +
      (isBase ? `<td class="num">${fmtEur(r.costOffer)}<small class="muted"> ${fmtNum(avg, 4)} €/kWh</small></td>`
        : `<td class="num">${fmtEur(r.costBase)}</td><td class="num">${fmtEur(r.costOffer)}<small class="muted"> ${fmtNum(avg, 4)} €/kWh</small></td>${diffCell(Math.round((r.costOffer - r.costBase) * 100) / 100)}`) + '</tr>';
  }).join('');
  const foot = `<tr class="total"><td>${t.total}</td><td></td><td class="num">${fmtNum(total.kwh, 1)}</td>` +
    (isBase ? `<td class="num">${fmtEur(total.costOffer)}</td>` : `<td class="num">${fmtEur(total.costBase)}</td><td class="num">${fmtEur(total.costOffer)}</td>${diffCell(Math.round((total.costOffer - total.costBase) * 100) / 100)}`) + '</tr>';
  const head = `<tr><th>${t.hour}</th><th>${t.period}</th><th class="num">${t.kwh}</th>${isBase ? `<th class="num">${t.cost}</th>` : `<th class="num">${t.base}</th><th class="num">${t.offer}</th><th class="num">${t.diff}</th>`}</tr>`;
  return `
    <section class="hourly" id="hourly-detail">
      <h4>${t.title}</h4>
      <p class="muted small">${intro}</p>
      <div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${t.title}">${svg}</svg></div>
      ${legend}
      <details class="hourly-table"><summary>${lang === 'pt' ? 'Tabela hora a hora' : 'Tabla hora a hora'} (24 filas)</summary>
        <table class="invoice hourly"><thead>${head}</thead><tbody>${body}${foot}</tbody></table>
      </details>
      ${note ? `<p class="muted small">${note}</p>` : ''}
    </section>`;
}
