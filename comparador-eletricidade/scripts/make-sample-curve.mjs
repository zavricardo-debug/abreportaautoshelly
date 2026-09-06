// Generates public/samples/consumo-horario-ejemplo.csv – an hourly consumption curve in the
// Datadis / CNMC format (CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion) for the billing period
// of the Spanish sample invoice (19/07/2026 → 18/08/2026, 31 days) with a realistic household
// profile that adds up to the 277,224 kWh of that bill (punta 97 / llano 60 / valle 119 kWh on the bill).
// Deterministic (seeded) so the file is reproducible.  Usage: npm run samples:curve
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { period20TD } from '../public/lib/consumption-es.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const out = resolve(__dirname, '../public/samples/consumo-horario-ejemplo.csv');

let seed = 20260719;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// base profile (relative weights per hour beginning 0..23) – summer household: fridge base load,
// breakfast, lunch, air-conditioning in the evening, dishwasher at night
const weekday = [0.18, 0.15, 0.14, 0.14, 0.14, 0.15, 0.20, 0.35, 0.45, 0.40, 0.35, 0.33, 0.42, 0.55, 0.60, 0.45, 0.35, 0.32, 0.40, 0.55, 0.75, 0.85, 0.70, 0.35];
const weekend = [0.22, 0.18, 0.15, 0.14, 0.14, 0.15, 0.18, 0.25, 0.42, 0.55, 0.60, 0.62, 0.65, 0.70, 0.72, 0.60, 0.50, 0.45, 0.48, 0.58, 0.72, 0.80, 0.68, 0.38];

const start = new Date(2026, 6, 19); // 19/07/2026
const days = 31;
const rows = [];
let total = 0;
for (let d = 0; d < days; d++) {
  const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
  const dow = date.getDay();
  const prof = dow === 0 || dow === 6 ? weekend : weekday;
  // some days away from home (lower), a hot week (higher)
  const dayFactor = (d >= 10 && d <= 16 ? 1.25 : 1) * (d === 20 || d === 21 ? 0.55 : 1);
  for (let h = 0; h < 24; h++) {
    const noise = 0.75 + rnd() * 0.5;
    let kwh = prof[h] * dayFactor * noise;
    if (h === 22 && dow >= 1 && dow <= 5 && rnd() < 0.5) kwh += 0.9; // dishwasher after 22 h some weekdays
    if (h === 1 && rnd() < 0.3) kwh += 1.1;                        // washing machine at night
    rows.push({ date, h, kwh });
    total += kwh;
  }
}
// scale to the bill's kWh
const target = 277.224;
const k = target / total;
let csv = 'CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion\n';
const by = { punta: 0, llano: 0, valle: 0 };
for (const r of rows) {
  const kwh = Math.round(r.kwh * k * 1000) / 1000;
  by[period20TD(r.date, r.h)] += kwh;
  const dd = String(r.date.getDate()).padStart(2, '0'), mm = String(r.date.getMonth() + 1).padStart(2, '0');
  csv += `ES0031000000000000AB0F;${dd}/${mm}/${r.date.getFullYear()};${r.h + 1};${kwh.toFixed(3).replace('.', ',')};R\n`;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, csv);
const sum = by.punta + by.llano + by.valle;
console.log(`wrote ${out}: ${rows.length} hours, ${sum.toFixed(3)} kWh – punta ${by.punta.toFixed(1)} (${(100 * by.punta / sum).toFixed(0)} %) · llano ${by.llano.toFixed(1)} (${(100 * by.llano / sum).toFixed(0)} %) · valle ${by.valle.toFixed(1)} (${(100 * by.valle / sum).toFixed(0)} %)`);
