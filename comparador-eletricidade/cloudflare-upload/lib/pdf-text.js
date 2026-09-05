// Extracts text from a PDF in the browser with pdf.js, rebuilding visual lines
// from glyph positions (invoices are tables: we need "label ... qty price total"
// on the same line, in reading order).

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.js').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
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
    const err = new Error('Não foi possível carregar o leitor de PDF (pdf.js). Atualize o browser ou confirme que a pasta vendor/pdfjs foi publicada.');
    err.code = 'PDFJS_LOAD'; err.cause = e;
    throw err;
  }
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false, password: opts.password || undefined }).promise;
  const pages = [];
  let textItems = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
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
