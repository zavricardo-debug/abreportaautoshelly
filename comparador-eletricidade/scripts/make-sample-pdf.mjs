// Generates realistic sample invoices (fictional data) so the app can be tried
// without a real bill. Layout mimics the Endesa "Fatura de Luz" detail page and
// a bi-horária EDP-style bill. All amounts are computed with the same rules as the
// simulator (public/lib/simulator.js) so the numbers are internally consistent.
// Output: public/samples/*.pdf
import PDFDocument from 'pdfkit';
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULES_2026 } from '../public/lib/simulator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../public/samples');
mkdirSync(OUT, { recursive: true });

const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;
const eur = (v, d = 2) => v.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' €';
const num = (v, d = 0) => v.toLocaleString('pt-PT', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Build all invoice lines for a profile. Energy lines are split by IVA tier the way
 * suppliers print them ("… (IVA 6%)" / "… (IVA 23%)") when the 200 kWh limit is crossed.
 */
function buildInvoice({ power, days, periods, powerPrice, tarPrice, discountPct = 0, largeFamily = false }) {
  const R = RULES_2026;
  const months = days / (365 / 12);
  const totalKwh = periods.reduce((a, p) => a + p.kwh, 0);
  let share = 0;
  if (power <= R.ivaReducedEnergyMaxPower) share = Math.min(1, (largeFamily ? 300 : 200) * days / 30 / totalKwh);
  const tarReduced = power <= R.ivaReducedTarMaxPower;
  const lines = [];
  let base6 = 0, base23 = 0;
  const addEnergy = (label, kwh, price, iva) => {
    const value = r2(kwh * price);
    const disc = r2(-value * discountPct);
    const total = r2(value + disc);
    lines.push({ kind: 'energy', desc: label, qty: `${num(kwh, Number.isInteger(kwh) ? 0 : 1)} kWh`, price: eur(price, 6), value: eur(value), disc: disc ? eur(disc) : '', total: eur(total), iva: iva === 6 ? '6% (b)' : '23% (c)', discNote: disc ? `* Desconto Fatura Digital (${eur(value)} x ${num(discountPct * 100, 2)}%)` : null });
    if (iva === 6) base6 += total; else base23 += total;
  };
  for (const p of periods) {
    const label = `Termo de Energia (Real)${p.label ? ' - ' + p.label : ''}`;
    if (share >= 0.999) addEnergy(label, p.kwh, p.price, 6);
    else if (share <= 0.001) addEnergy(label, p.kwh, p.price, 23);
    else {
      const k6 = Math.round(p.kwh * share * 10) / 10;
      addEnergy(`${label} (IVA 6%)`, k6, p.price, 6);
      addEnergy(`${label} (IVA 23%)`, Math.round((p.kwh - k6) * 10) / 10, p.price, 23);
    }
  }
  const pv = r2(powerPrice * days), pd = r2(-pv * discountPct), pt = r2(pv + pd);
  lines.push({ kind: 'power', desc: `Termo de Potência (${String(power)} kVA)`, qty: `${days} dias`, price: eur(powerPrice, 6), value: eur(pv), disc: pd ? eur(pd) : '', total: eur(pt), iva: '23% (c)', discNote: pd ? `* Desconto Fatura Digital (${eur(pv)} x ${num(discountPct * 100, 2)}%)` : null });
  base23 += pt;
  const tv = r2(tarPrice * days);
  lines.push({ kind: 'tar', desc: 'Termo Fixo Acesso às Redes', qty: `${days} dias`, price: eur(tarPrice, 6), value: eur(tv), disc: '', total: eur(tv), iva: tarReduced ? '6% (b)' : '23% (c)' });
  if (tarReduced) base6 += tv; else base23 += tv;
  const consumptionTotal = r2(base6 + base23);

  const cav = r2(R.cavPerMonth * months), dgeg = r2(R.dgegPerMonth * months), iec = r2(R.iecPerKwh * totalKwh);
  const taxes = [
    { desc: 'Contribuição Audiovisual', qty: `${num(months, 4)} meses`, price: eur(R.cavPerMonth, 6), value: eur(cav), total: eur(cav), iva: '6% (b)' },
    { desc: 'Taxa Exploração DGEG (DL-4/93)', qty: `${num(months, 4)} meses`, price: eur(R.dgegPerMonth, 6), value: eur(dgeg), total: eur(dgeg), iva: '23% (c)' },
    { desc: 'Imposto Especial Consumo (Real)', qty: `${num(totalKwh)} kWh`, price: eur(R.iecPerKwh, 6), value: eur(iec), total: eur(iec), iva: '23% (c)' },
  ];
  base6 += cav; base23 += dgeg + iec;
  const iva6 = r2(base6 * R.ivaReduced), iva23 = r2(base23 * R.ivaNormal);
  const taxesTotal = r2(cav + dgeg + iec + iva6 + iva23);
  const invoiceTotal = r2(consumptionTotal + taxesTotal);
  return { lines, taxes, consumptionTotal, base6: r2(base6), base23: r2(base23), iva6, iva23, taxesTotal, invoiceTotal, totalKwh };
}

function write(file, build) {
  return new Promise((res, rej) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: 'Fatura de exemplo (dados fictícios)' } });
    const stream = createWriteStream(resolve(OUT, file));
    doc.pipe(stream);
    build(doc);
    doc.end();
    stream.on('finish', () => res(resolve(OUT, file)));
    stream.on('error', rej);
  });
}

// Column x positions for the detail table (Endesa style)
const COL = { desc: 40, qty: 250, price: 320, value: 385, disc: 440, total: 495, iva: 550 };

function tableHeader(doc, y) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#444');
  doc.text('Descrição', COL.desc, y).text('Quantidade', COL.qty, y).text('x   Preço', COL.price, y).text('=   Valor', COL.value, y)
    .text('-   Desconto*', COL.disc, y).text('=   Total**', COL.total, y).text('IVA', COL.iva, y, { lineBreak: false });
  doc.moveTo(40, y + 11).lineTo(555, y + 11).strokeColor('#bbb').stroke();
  doc.fillColor('#000');
}

function line(doc, y, r, sub) {
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  doc.text(r.desc, COL.desc, y, { width: 205, lineBreak: false });
  doc.text(r.qty, COL.qty, y, { width: 68, lineBreak: false });
  doc.text(r.price, COL.price, y, { width: 62, lineBreak: false });
  doc.text(r.value, COL.value, y, { width: 52, lineBreak: false });
  doc.text(r.disc || '', COL.disc, y, { width: 52, lineBreak: false });
  doc.text(r.total, COL.total, y, { width: 52, lineBreak: false });
  doc.text(r.iva, COL.iva, y, { width: 45, lineBreak: false });
  let yy = y + 11;
  if (sub) { doc.fontSize(7).fillColor('#555').text(sub, COL.desc, yy, { lineBreak: false }); yy += 9; }
  if (r.discNote) { doc.fontSize(7).fillColor('#555').text(r.discNote, COL.desc, yy, { lineBreak: false }); yy += 9; }
  doc.fillColor('#000');
  return yy + 3;
}

function totalLine(doc, y, label, value, bold = true) {
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
  doc.text(label, COL.desc, y, { lineBreak: false }).text(value, COL.total, y, { width: 95, lineBreak: false });
  return y + 16;
}

function detailTable(doc, y, inv, { sectionLabel, sub, noteLabels }) {
  tableHeader(doc, y); y += 16;
  doc.font('Helvetica-Bold').fontSize(8.5).text(sectionLabel, COL.desc, y, { lineBreak: false }); y += 14;
  for (const l of inv.lines) y = line(doc, y, l, sub);
  y = totalLine(doc, y + 2, `TOTAL ${sectionLabel}`, eur(inv.consumptionTotal));
  doc.font('Helvetica-Bold').fontSize(8.5).text('Taxas e Impostos', COL.desc, y, { lineBreak: false }); y += 14;
  for (const t of inv.taxes) y = line(doc, y, t);
  y += 4;
  doc.font('Helvetica').fontSize(8);
  doc.text(noteLabels ? '(c) IVA 23%' : 'IVA 23%', COL.desc, y, { lineBreak: false }).text(eur(inv.base23), COL.value, y, { lineBreak: false }).text(eur(inv.iva23), COL.total, y, { lineBreak: false }); y += 12;
  doc.text(noteLabels ? '(b) IVA 6%' : 'IVA 6%', COL.desc, y, { lineBreak: false }).text(eur(inv.base6), COL.value, y, { lineBreak: false }).text(eur(inv.iva6), COL.total, y, { lineBreak: false }); y += 14;
  y = totalLine(doc, y, 'TOTAL Taxas e Impostos', eur(inv.taxesTotal));
  return y;
}

const DISCLAIMER = 'Documento de exemplo com dados fictícios, gerado para demonstração do comparador. Não é uma fatura real.';

/* ---------------------------------------------------------------- Endesa, simples, 3,45 kVA */
const endesa = buildInvoice({ power: 3.45, days: 31, periods: [{ kwh: 157, price: 0.166823 }], powerPrice: 0.1514, tarPrice: RULES_2026.tarFixedPerDay[3.45], discountPct: 0.05 });
const endesaCredit = -8.02;
await write('fatura-exemplo-endesa.pdf', (doc) => {
  // page 1: summary
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0b2a5b').text('endesa', 40, 40);
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  doc.text('Endesa Energia S.A. – Sucursal em Portugal', 360, 42, { width: 195, align: 'right' });
  doc.text('NIF 980245974', 360, 52, { width: 195, align: 'right' });
  doc.text('Apoio ao cliente: 800 101 030', 360, 62, { width: 195, align: 'right' });

  doc.font('Helvetica-Bold').fontSize(11).text('A sua fatura de LUZ', 40, 100);
  doc.font('Helvetica').fontSize(9);
  doc.text('Fatura: FAC 2026/00123456', 40, 118).text('Data: 03 set 2026', 40, 130)
    .text('Período de Faturação: 03 ago 2026 a 02 set 2026', 40, 142)
    .text('Data limite de pagamento: 23 set 2026', 40, 154);
  doc.text('Titular: MARIA EXEMPLO SILVA', 320, 118).text('Morada de fornecimento: RUA DAS FLORES 12, 3º ESQ', 320, 130)
    .text('1000-100 LISBOA', 320, 142).text('CPE: PT0002000123456789XY', 320, 154)
    .text('Nº de contrato: 0012345678', 320, 166);

  doc.roundedRect(40, 190, 515, 70, 6).strokeColor('#0b2a5b').stroke();
  doc.font('Helvetica-Bold').fontSize(9).text('Dados do contrato', 50, 198);
  doc.font('Helvetica').fontSize(9);
  doc.text('Tarifa: Endesa Tarifa Livre – Simples', 50, 212).text('Potência contratada: 3,45 kVA', 50, 224)
    .text('Ciclo horário: Simples', 50, 236);
  doc.text('Leitura anterior (Real): 12.345 kWh em 03 ago 2026', 300, 212)
    .text('Leitura atual (Real): 12.502 kWh em 02 set 2026', 300, 224)
    .text('Consumo faturado: 157 kWh', 300, 236);

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#0b2a5b').text('TOTAL A PAGAR', 40, 285).text(eur(r2(endesa.invoiceTotal + endesaCredit)), 400, 285, { width: 155, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor('#000').text('Débito direto na conta PT50 **** **** **** **** 1234 em 23 set 2026', 40, 305);
  doc.fontSize(7).fillColor('#777').text(DISCLAIMER, 40, 800);

  // page 2: detail
  doc.addPage();
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#0b2a5b').text('endesa', 40, 40);
  doc.font('Helvetica').fontSize(8).fillColor('#000').text('Fatura: FAC 2026/00123456   Página 2/2', 360, 44, { width: 195, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('Detalhe da fatura de LUZ', 40, 80);
  doc.font('Helvetica').fontSize(8).text('Período de Faturação: 03 ago 2026 a 02 set 2026   |   Potência contratada 3,45 kVA   |   Opção horária: Simples', 40, 96);

  let y = detailTable(doc, 120, endesa, { sectionLabel: 'Luz (Consumo)', sub: '03 ago a 02 set', noteLabels: true });
  y = totalLine(doc, y + 4, 'TOTAL DA FATURA DE LUZ', eur(endesa.invoiceTotal));
  y += 6;
  doc.font('Helvetica').fontSize(7.5).fillColor('#333');
  doc.text(`Nota de crédito aplicada: ${eur(endesaCredit)} (acerto de leitura estimada da fatura anterior). Valor a pagar: ${eur(r2(endesa.invoiceTotal + endesaCredit))}.`, 40, y); y += 20;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#000').text('Outros', COL.desc, y); y += 14;
  doc.font('Helvetica').fontSize(8).text('Mecanismo DL 33/2022 (ajuste ibérico) 157 kWh 0,000000 € 0,00 €', COL.desc, y); y += 20;
  doc.fontSize(7.5).fillColor('#333');
  doc.text('** Os preços apresentados não incluem IVA. Tarifas de Acesso às Redes aprovadas pela ERSE para 2026. O Termo de Energia inclui a componente de acesso às redes (0,0607 €/kWh).', 40, y, { width: 515 }); y += 24;
  doc.text('Consumo médio diário neste período: 5,06 kWh. No período homólogo do ano anterior: 5,40 kWh.', 40, y, { width: 515 });
  doc.fontSize(7).fillColor('#777').text(DISCLAIMER, 40, 800);
});

/* ---------------------------------------------------------------- EDP style, bi-horária, 6,9 kVA */
const edp = buildInvoice({ power: 6.9, days: 31, periods: [{ label: 'Fora de Vazio', kwh: 245, price: 0.1935 }, { label: 'Vazio', kwh: 168, price: 0.1119 }], powerPrice: 0.2344, tarPrice: RULES_2026.tarFixedPerDay[6.9] });
await write('fatura-exemplo-edp-bihoraria.pdf', (doc) => {
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#e30613').text('edp', 40, 40);
  doc.font('Helvetica').fontSize(8).fillColor('#000');
  doc.text('EDP Comercial – Comercialização de Energia, S.A.', 360, 42, { width: 195, align: 'right' });
  doc.text('NIF 503504564 · Linha de apoio 808 53 53 53', 360, 52, { width: 195, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).text('Fatura de Eletricidade nº FT 2026/987654', 40, 90);
  doc.font('Helvetica').fontSize(9);
  doc.text('Data de emissão: 05/09/2026', 40, 108).text('Período de faturação: 05/08/2026 a 04/09/2026 (31 dias)', 40, 120)
    .text('Cliente: JOÃO EXEMPLO PEREIRA · Local: AV. DA REPÚBLICA 45, 4000-200 PORTO', 40, 132)
    .text('CPE: PT0002000987654321ZZ · Potência contratada: 6,9 kVA · Opção horária: Bi-horária (ciclo diário)', 40, 144);
  let y = detailTable(doc, 180, edp, { sectionLabel: 'Eletricidade', noteLabels: false });
  y = totalLine(doc, y + 4, 'TOTAL DA FATURA', eur(edp.invoiceTotal));
  doc.fontSize(7).fillColor('#777').text(DISCLAIMER, 40, 800);
});

console.log('Sample PDFs written to', OUT);
console.log('  Endesa  total', endesa.invoiceTotal, '€ (a pagar', r2(endesa.invoiceTotal + endesaCredit), '€)');
console.log('  EDP     total', edp.invoiceTotal, '€');
