// Parses the two CSV files published by ERSE (simuladorprecos.erse.pt)
//   csv/CondComerciais.csv  -> commercial conditions per offer (COD_Proposta)
//   csv/Precos_ELEGN.csv    -> prices per offer / contracted power / tariff option
// into a compact JSON dataset consumed by the browser app.
//
// Only electricity offers (Fornecimento = ELE) for BTN customers are kept.
// DUAL offers (electricity + gas) are kept too, flagged as dual, because their
// electricity prices are valid for comparison when the user also has gas.

const SEP = ';';

/** Minimal CSV parser (semicolon separated, optional double quotes, CRLF). */
export function parseCsv(text, sep = SEP) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.replace(/^\uFEFF/, '').trim());
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** "0,1654" -> 0.1654 ; "" -> null ; "2E-05" -> 0.00002 */
export function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function yn(v) { return String(v).trim().toUpperCase() === 'S'; }

/** "dd/mm/yyyy" -> "yyyy-mm-dd" */
function isoDate(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Human friendly supplier names for the COM codes used by ERSE.
export const SUPPLIER_NAMES = {
  TUR: 'SU Eletricidade (Tarifa Regulada)',
  EDPC: 'EDP Comercial',
  END: 'Endesa',
  IBD: 'Iberdrola',
  GALP: 'Galp',
  GOLD: 'Goldenergy',
  REPSOL: 'Repsol',
  ENIPLENITUDE: 'Plenitude',
  MEOENERGIA: 'MEO Energia',
  COOP: 'Coopérnico',
  AUDAX: 'Audax',
  IBELECTRA: 'Ibelectra',
  NABALIAENERGIA: 'Nabalia Energia',
  AXPO: 'Axpo',
  ALFAENERGIA: 'Alfa Energia',
  DOUROGAS: 'Dourogás',
  EZUENERGIA: 'EZU Energia',
  MUON: 'Muon',
  JAFPLUS: 'JAF Plus',
  LUZBOA: 'Luzboa',
  LUZIGAS: 'Luzigás',
  YESENERGY: 'YesEnergy',
  ACCIONA: 'Acciona',
  LOGICA: 'Lógica Energy',
  NOSSAENERGIA: 'Nossa Energia',
  OENEO: 'Oeneo Energy',
  PORTULOGOS: 'Portulogos',
  ELERGONE: 'Elergone',
  USENERGY: 'Usenergy',
  'ZUG POWER': 'Zug Power',
};

export function supplierName(code) {
  return SUPPLIER_NAMES[code] || code;
}

/**
 * Build the dataset.
 * @param {string} condCsv  content of CondComerciais.csv
 * @param {string} precCsv  content of Precos_ELEGN.csv
 * @param {{source?:string, publishedAt?:string}} meta
 */
export function buildDataset(condCsv, precCsv, meta = {}) {
  const cond = parseCsv(condCsv);
  const prec = parseCsv(precCsv);

  const offers = new Map();
  for (const r of cond) {
    const supply = r['Fornecimento'];
    if (supply !== 'ELE' && supply !== 'DUAL') continue;
    const code = r['COD_Proposta'];
    if (!code || code === 'U1') continue; // U1 = placeholder for the user's own prices
    offers.set(code, {
      id: code,
      supplierCode: r['COM'],
      supplier: supplierName(r['COM']),
      name: r['NomeProposta'],
      variant: r['TxTModalidade'] && r['TxTModalidade'] !== ' ' ? r['TxTModalidade'] : '',
      segment: r['Segmento'], // Dom | Ndom | Tod
      dual: supply === 'DUAL',
      indexed: yn(r['FiltroPrecosIndex_ELE']),
      newClientsOnly: yn(r['FiltroNovosClientes']),
      restricted: yn(r['FiltroRestrições']),
      requiresServices: yn(r['FiltroServicosAdic']),
      loyalty: yn(r['FiltroFidelização']),
      renewable: yn(r['FiltroRenovavel_ELE']),
      socialTariff: yn(r['FiltroTarifaSocial']),
      contractMonths: num(r['DuracaoContrato']),
      validFrom: isoDate(r['Data ini']),
      validTo: isoDate(r['Data fim']),
      // yearly extra costs / refunds (as published by ERSE, all €/year)
      servicesCostYear: num(r['CustoServicos_c/IVA (€/ano)']) || 0,
      refundFixedYear: num(r['ReembFixo (€/ano)']) || 0,
      refundPctFixed: num(r['ReembTF_ELE (%)']) || 0, // fraction (0.02 = 2 %)
      refundPctEnergy: num(r['ReembTW_ELE (%)']) || 0,
      refundPerKwh: num(r['ReembW_ELE (€/kWh)']) || 0,
      newClientDiscountYear: num(r['DescontNovoCliente_c/IVA (€/ano)']) || 0,
      description: r['TxTOferta'] || '',
      erseNotes: r['TxTERSE'] || '',
      restrictionsText: r['TxTRestricoesAdic'] || '',
      otherBenefits: r['DetalheOutrosDesc/benefi'] || '',
      priceUpdatePolicy: r['TxTAtualizaPrecos'] || '',
      contracting: r['TxTContratação'] || '',
      billing: r['TxTFatura'] || '',
      payment: r['TxTPagamento'] || '',
      links: {
        supplier: cleanUrl(r['LinkCOM']),
        offer: cleanUrl(r['LinkOfertaCom']),
        sheet: cleanUrl(r['LinkFichaPadrao']),
        terms: cleanUrl(r['LinkCondicoesGerais']),
      },
      phone: r['ContactoComercialTel'] || '',
      prices: {}, // key: `${power}|${option}` -> {tf, p1, p2, p3}
    });
  }

  // Prices. Note: for DUAL offers ERSE emits, for the same (offer, power, option),
  // one row with electricity prices and another with gas prices -> merge.
  let priceRows = 0;
  for (const r of prec) {
    const offer = offers.get(r['COD_Proposta']);
    if (!offer) continue;
    const power = num(r['Pot_Cont']);
    const option = num(r['Contagem']); // 1 simples, 2 bi-horária, 3 tri-horária
    if (!power || !option) continue;
    const tf = num(r['TF']);
    const p1 = num(r['TV|TVFV|TVP']);
    if (tf === null && p1 === null) continue; // gas-only row
    const key = `${power}|${option}`;
    const entry = offer.prices[key] || {};
    if (tf !== null) entry.tf = tf;
    if (p1 !== null) entry.p1 = p1;
    const p2 = num(r['TVV|TVC']);
    const p3 = num(r['TVVz']);
    if (p2 !== null) entry.p2 = p2;
    if (p3 !== null) entry.p3 = p3;
    offer.prices[key] = entry;
    priceRows++;
  }

  const list = [...offers.values()].filter((o) => Object.keys(o.prices).length > 0);
  list.sort((a, b) => a.supplier.localeCompare(b.supplier, 'pt') || a.name.localeCompare(b.name, 'pt'));

  const suppliers = [...new Set(list.map((o) => o.supplierCode))]
    .map((code) => ({ code, name: supplierName(code), offers: list.filter((o) => o.supplierCode === code).length }))
    .sort((a, b) => b.offers - a.offers);

  return {
    meta: {
      source: meta.source || 'ERSE – Simulador de Preços de Energia (simuladorprecos.erse.pt)',
      publishedAt: meta.publishedAt || null,
      generatedAt: new Date().toISOString(),
      offers: list.length,
      priceRows,
    },
    suppliers,
    offers: list,
  };
}

function cleanUrl(v) {
  const s = String(v || '').trim();
  if (!s || s === 'NA' || s === '-') return '';
  // ERSE data occasionally contains "https:// https://www..." typos
  const m = /https?:\/\/\S+$/.exec(s);
  return m ? m[0] : s;
}
