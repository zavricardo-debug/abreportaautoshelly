// Debug helper: extract text from a PDF exactly like the browser does (same line
// reconstruction as public/lib/pdf-text.js) and optionally run the parser on it.
//
//   node scripts/pdf-to-text.mjs fatura.pdf            -> prints the text
//   node scripts/pdf-to-text.mjs fatura.pdf --parse    -> prints the parsed JSON
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/pdf-to-text.mjs <file.pdf> [--parse]'); process.exit(1); }

const pdfjs = await import(pathToFileURL(resolve(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
// Reuse the browser module's line builder without loading the vendored pdf.js.
const src = readFileSync(resolve(__dirname, '../public/lib/pdf-text.js'), 'utf8');
const itemsToLines = new Function(src.slice(src.indexOf('function itemsToLines')) + '; return itemsToLines;')();

const data = new Uint8Array(readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  pages.push(itemsToLines((await page.getTextContent()).items));
}
const text = pages.join('\n');
if (process.argv.includes('--parse')) {
  // same routing as the web app: detect the country of the bill, then run the matching parser
  const { detectCountry, parseInvoiceTextES } = await import('../public/lib/parser-es.js');
  const det = detectCountry(text);
  console.error(`country: ${det.country} (ES ${det.scoreES} / PT ${det.scorePT})`);
  if (det.country === 'ES') {
    console.log(JSON.stringify(parseInvoiceTextES(text), null, 2));
  } else {
    const { parseInvoiceText } = await import('../public/lib/parser.js');
    console.log(JSON.stringify(parseInvoiceText(text), null, 2));
  }
} else {
  console.log(text);
}
