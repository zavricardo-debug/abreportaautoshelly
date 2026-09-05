// Extracts text from a PDF in the browser with pdf.js, rebuilding visual lines
// from glyph positions (invoices are tables: we need "label ... qty price total"
// on the same line, in reading order).

// Updated automatically by scripts/vendor-pdfjs.mjs (npm run vendor)
const PDFJS_DIR = '../vendor/pdfjs-4.10.38';

let pdfjsPromise = null;

/**
 * Safari (macOS/iOS up to 26.x) does not implement ReadableStream[Symbol.asyncIterator];
 * pdf.js 5.x uses `for await (... of readableStream)` in getTextContent(), which throws
 * "undefined is not a function (near '...t of e...')" there. Polyfill the async iterator
 * so any such loop inside pdf.js works, and read the text stream with a classic reader.
 */
function polyfillStreams() {
  if (typeof ReadableStream === 'undefined') return;
  const proto = ReadableStream.prototype;
  if (typeof proto[Symbol.asyncIterator] === 'function') return;
  const values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      next: () => reader.read(),
      return: async (value) => { if (!preventCancel) await reader.cancel(value); reader.releaseLock(); return { value, done: true }; },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  try {
    Object.defineProperty(proto, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
    if (typeof proto.values !== 'function') Object.defineProperty(proto, 'values', { value: values, writable: true, configurable: true });
  } catch { /* frozen prototype – fall back to the reader loop below */ }
}

/** Browser features pdf.js 5 (legacy build) really needs; report the missing ones in plain words. */
export function browserSupport() {
  const missing = [];
  const inBrowser = typeof document !== 'undefined';
  if (inBrowser && typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof ReadableStream === 'undefined') missing.push('Streams API');
  if (typeof DecompressionStream === 'undefined') missing.push('DecompressionStream (Safari 16.4+, Chrome 80+, Firefox 113+)');
  if (typeof structuredClone === 'undefined') missing.push('structuredClone (Safari 15.4+)');
  let es2022 = true;
  try { new Function('class A { #x = 1; static { } get x() { return this.#x ?? 0; } }'); } catch { es2022 = false; }
  if (!es2022) missing.push('JavaScript 2022 (campos privados / static blocks)');
  return { ok: missing.length === 0, missing };
}

async function loadPdfjs() {
  if (!pdfjsPromise) {
    const sup = browserSupport();
    if (!sup.ok) {
      const err = new Error(`O seu browser não suporta funcionalidades necessárias para ler PDFs (${sup.missing.join(', ')}). Atualize o browser (Safari 16.4+, Chrome 100+, Firefox 115+, Edge 100+) ou introduza os valores manualmente.`);
      err.code = 'PDFJS_LOAD';
      throw err;
    }
    polyfillStreams();
    pdfjsPromise = import(`${PDFJS_DIR}/pdf.min.js`).then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(`${PDFJS_DIR}/pdf.worker.min.js`, import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

/** page.getTextContent() without relying on async iteration of streams (Safari-safe). */
async function readTextContent(page) {
  const stream = page.streamTextContent({ includeMarkedContent: false, disableNormalization: false });
  const reader = stream.getReader();
  const out = { items: [], styles: Object.create(null), lang: null };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out.lang ??= value.lang;
    Object.assign(out.styles, value.styles);
    out.items.push(...value.items);
  }
  return out;
}

/**
 * @param {ArrayBuffer} data
 * @param {(info:{page:number,pages:number})=>void} [onProgress]
 * @param {{password?:string}} [opts]
 * @returns {Promise<{text:string, pages:string[], numPages:number, info:object}>}
 * Throws pdf.js errors as-is: `err.name === 'PasswordException'` (code 1 = needs password,
 * 2 = wrong password), 'InvalidPDFException', … `err.code === 'PDFJS_LOAD'` when pdf.js itself
 * could not be loaded (very old browser / vendor files missing).
 */
export async function extractPdfText(data, onProgress, opts = {}) {
  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (e) {
    if (e?.code === 'PDFJS_LOAD') throw e;
    const err = new Error(`Não foi possível carregar o leitor de PDF (pdf.js): ${e?.message || e}. Atualize o browser ou confirme que a pasta vendor/pdfjs foi publicada.`);
    err.code = 'PDFJS_LOAD'; err.cause = e;
    throw err;
  }
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, password: opts.password || undefined }).promise;
  const pages = [];
  let textItems = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await readTextContent(page);
    textItems += content.items.filter((it) => it.str && it.str.trim()).length;
    pages.push(itemsToLines(content.items));
    onProgress?.({ page: p, pages: doc.numPages });
  }
  let info = {};
  try {
    const m = await doc.getMetadata();
    info = { producer: m.info?.Producer, creator: m.info?.Creator, title: m.info?.Title, xfa: !!m.info?.IsXFAPresent };
  } catch { /* metadata is optional */ }
  info.textItems = textItems;
  info.encrypted = !!opts.password;
  info.pdfjsVersion = pdfjs.version;
  await doc.destroy();
  return { text: pages.join('\n'), pages, numPages: pages.length, info };
}

/** Group text items into lines by their y coordinate, then sort by x. */
function itemsToLines(items) {
  const glyphs = items
    .filter((it) => it.str && it.str.trim() !== '' || it.hasEOL)
    .map((it) => ({
      str: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: Math.abs(it.transform[3]) || Math.abs(it.height) || 8,
    }))
    .filter((g) => g.str.trim() !== '');

  // cluster by y (tolerance relative to font size)
  glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const g of glyphs) {
    const tol = Math.max(2, g.h * 0.45);
    const line = lines.find((l) => Math.abs(l.y - g.y) <= tol);
    if (line) { line.items.push(g); line.y = (line.y * line.items.length + g.y) / (line.items.length + 1); }
    else lines.push({ y: g.y, items: [g] });
  }
  lines.sort((a, b) => b.y - a.y);

  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = '';
    let prev = null;
    for (const g of l.items) {
      if (prev) {
        const gap = g.x - (prev.x + prev.w);
        const spaceW = Math.max(1.5, prev.h * 0.25);
        if (gap > spaceW * 4) out += '   ';
        else if (gap > spaceW * 0.5 || /\s$/.test(prev.str) || /^\s/.test(g.str)) out += ' ';
        else if (gap < -prev.h) out += ' '; // overlapping columns (rare)
      }
      out += g.str;
      prev = g;
    }
    return out.replace(/[ \t]+/g, ' ').trim();
  }).filter(Boolean).join('\n');
}
