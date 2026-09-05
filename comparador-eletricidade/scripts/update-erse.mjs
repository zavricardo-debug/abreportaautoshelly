#!/usr/bin/env node
// Downloads (or reads locally) the ERSE commercial offers CSV bundle and builds
// public/data/ofertas.json used by the web app.
//
//   node scripts/update-erse.mjs                 # download latest ZIP from ERSE
//   node scripts/update-erse.mjs --csv-dir DIR   # use a ZIP already in DIR (newest *.zip)
//   node scripts/update-erse.mjs --zip file.zip  # use a specific ZIP
//
// The ZIP contains csv\CondComerciais.csv and csv\Precos_ELEGN.csv.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { buildDataset } from './lib/erse-parse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'public/data/ofertas.json');
const SETTINGS_URL = 'https://simuladorprecos.erse.pt/config/Settings.json';

const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

async function main() {
  let zipPath = argValue('--zip');
  let publishedAt = null;

  if (!zipPath && argValue('--csv-dir')) {
    const dir = resolve(ROOT, argValue('--csv-dir'));
    const zips = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip')).sort();
    if (!zips.length) throw new Error(`No .zip files found in ${dir}`);
    zipPath = resolve(dir, zips[zips.length - 1]);
  }

  if (!zipPath) {
    console.log(`Fetching ${SETTINGS_URL} ...`);
    const settings = await (await fetch(SETTINGS_URL)).json();
    const csvUrl = String(settings.csvPath || '').replace(/ /g, '%20');
    if (!csvUrl) throw new Error('csvPath not found in Settings.json');
    console.log(`Downloading ${csvUrl} ...`);
    const buf = Buffer.from(await (await fetch(csvUrl)).arrayBuffer());
    const stamp = /(\d{8})%20(\d{6})/.exec(csvUrl);
    const name = stamp ? `erse-${stamp[1]}-${stamp[2]}.zip` : `erse-${Date.now()}.zip`;
    mkdirSync(resolve(ROOT, 'data-src'), { recursive: true });
    zipPath = resolve(ROOT, 'data-src', name);
    writeFileSync(zipPath, buf);
    console.log(`Saved ${zipPath} (${buf.length} bytes)`);
  }

  const stamp = /(\d{4})(\d{2})(\d{2})[-_ ]?(\d{2})(\d{2})(\d{2})/.exec(basename(zipPath));
  if (stamp) publishedAt = `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}`;

  const { cond, prec } = readZip(zipPath);
  const dataset = buildDataset(cond, prec, { publishedAt });
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(dataset));
  console.log(`Wrote ${OUT}: ${dataset.meta.offers} offers, ${dataset.meta.priceRows} price rows, ` +
    `${dataset.suppliers.length} suppliers (published ${publishedAt || 'unknown'})`);
}

/**
 * Extract the two CSVs from the ZIP with a tiny native reader (no extra deps).
 * ERSE ZIPs use "stored" or "deflate" entries and backslash paths (csv\...).
 */
function readZip(zipPath) {
  const entries = unzip(readFileSync(zipPath));
  const find = (pattern) => {
    const hit = [...entries.keys()].find((n) =>
      n.split(/[\\/]/).pop().toLowerCase().includes(pattern.toLowerCase()));
    if (!hit) throw new Error(`${pattern} not found inside ${zipPath} (entries: ${[...entries.keys()].join(', ')})`);
    return entries.get(hit).toString('utf8').replace(/^\uFEFF/, '');
  };
  return { cond: find('CondComerciais'), prec: find('Precos_ELEGN') };
}

/** Minimal ZIP reader: walks the central directory, returns Map<name, Buffer>. */
function unzip(buf) {
  const files = new Map();
  // locate End Of Central Directory record
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (EOCD not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // local file header
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) files.set(name, Buffer.from(data));
    else if (method === 8) files.set(name, inflateRawSync(data));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

main().catch((e) => { console.error(e); process.exit(1); });
