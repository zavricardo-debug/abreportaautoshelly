// SIBA (Sistema de Informação de Boletins de Alojamento) web-service client.
//
// Method: EntregaBoletinsAlojamento(UnidadeHoteleira, Estabelecimento, ChaveAcesso, Boletins)
//   - Boletins = Base64 of an XML document that follows BAL.XSD (namespace http://sef.pt/BAws)
//   - Returns "0" on success; otherwise an XML fragment with <Codigo_Retorno> and <Descricao>.
// Reference: https://siba.ssi.gov.pt/ajuda/modos-de-envio/
import { isCountryCode } from "./countries";

// siba.ssi.gov.pt is the current official host (the TLS certificate is issued for it; siba.sef.pt is a
// legacy alias). As of 2026-09 the test environment only answers on siba.ssi.gov.pt — siba.sef.pt/bawsdev
// returns 404 — so both environments point at the new host.
export const SIBA_ENDPOINTS = {
  production: "https://siba.ssi.gov.pt/baws/boletinsalojamento.asmx",
  development: "https://siba.ssi.gov.pt/bawsdev/boletinsalojamento.asmx",
} as const;
export const SIBA_SOAP_ACTION = "http://sef.pt/EntregaBoletinsAlojamento";
export const SIBA_USER_AGENT = "siba-checkin/1.0 (+https://github.com/zavricardo-debug/abreportaautoshelly)";

/**
 * Fictitious hotel unit used by SEF's own sample program ("EnvioBA") against the development
 * environment. It lets an installation verify network/TLS/SOAP/XML acceptance without using a real
 * activation key and without reporting any real guest. Never use it against production.
 */
export const SIBA_TEST_UNIT: PropertyInfo = {
  codigo_unidade: "121212121",
  estabelecimento: "00",
  nome: "Hotel teste",
  abreviatura: "teste",
  morada: "Rua da Alegria, 172",
  localidade: "Portalegre",
  codigo_postal: "1000",
  zona_postal: "234",
  telefone: "214017744",
  fax: "214017766",
  nome_contacto: "Nuno teste",
  email_contacto: "teste.teste@sef.pt",
  chave_activacao: "999999999",
};

/** Obviously fake bulletin for the connectivity self-test (check-in = today so SIBA accepts the date). */
export function selfTestBulletin(today: string = todayIso()): GuestBulletin {
  return {
    apelido: "TESTE",
    nome: "LIGACAO",
    nacionalidade: "GBR",
    data_nascimento: "1990-01-01",
    local_nascimento: "TESTE",
    documento_identificacao: "TESTE123456",
    tipo_documento: "P",
    pais_emissor_documento: "GBR",
    data_entrada: today,
    data_saida: null,
    pais_residencia_origem: "GBR",
    local_residencia_origem: "TESTE",
  };
}

export interface PropertyInfo {
  codigo_unidade: string; // NIPC (9 digits)
  estabelecimento: string; // establishment number ("00")
  nome: string;
  abreviatura: string;
  morada: string;
  localidade: string;
  codigo_postal: string; // 4 digits
  zona_postal: string; // 3 digits
  telefone: string;
  fax?: string;
  nome_contacto: string;
  email_contacto: string;
  chave_activacao: string;
}

export interface GuestBulletin {
  apelido: string;
  nome: string;
  nacionalidade: string;
  data_nascimento: string; // YYYY-MM-DD
  local_nascimento?: string;
  documento_identificacao: string;
  tipo_documento: string; // P | B | O
  pais_emissor_documento: string;
  data_entrada: string; // YYYY-MM-DD
  data_saida?: string | null; // YYYY-MM-DD
  pais_residencia_origem: string;
  local_residencia_origem: string;
}

export interface FieldError {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Normalisation helpers (SIBA field types)
// ---------------------------------------------------------------------------

const NAME_ALLOWED = /[^A-ZÇÃÁÀÉÊÍÕÔÓÚ'\- ]/g;

export function cleanText(v: unknown): string {
  return String(v ?? "")
    .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function digits(v: unknown, max = 0): string {
  const out = cleanText(v).replace(/\D+/g, "");
  return max ? out.slice(0, max) : out;
}

/** Person names: upper-case, only [A-Z ÇÃÁÀÉÊÍÕÔÓÚ ' -] and space (SIBA "Alfabético Nome"). */
export function normalizeName(v: unknown, max = 40): string {
  let s = cleanText(v).toUpperCase();
  // transliterate accented letters SIBA does not accept (e.g. Ü, Ñ, Ö) to their base letter
  s = s
    .split("")
    .map((ch) => {
      if (/[A-ZÇÃÁÀÉÊÍÕÔÓÚ'\- ]/.test(ch)) return ch;
      const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (/^[A-Z]$/.test(base)) return base;
      if (ch === "ß") return "SS";
      if (ch === "Æ") return "AE";
      if (ch === "Ø") return "O";
      if (/[.,]/.test(ch)) return " ";
      return "";
    })
    .join("")
    .replace(NAME_ALLOWED, "")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, max).trim();
}

/** Free text fields (places, addresses): upper-case, strip control chars, limit length. */
export function normalizeText(v: unknown, max: number, upper = true): string {
  let s = cleanText(v).replace(/[\u0000-\u001f]/g, "");
  if (upper) s = s.toUpperCase();
  return s.slice(0, max).trim();
}

/** Document number: only A-Z and 0-9, max 16. */
export function normalizeDocNumber(v: unknown): string {
  return cleanText(v).toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 16);
}

export function normalizeDocType(v: unknown): string {
  const t = cleanText(v).toUpperCase();
  if (t === "P" || t === "B" || t === "O") return t;
  if (t.startsWith("PASS")) return "P";
  if (t === "I" || t === "ID" || t.startsWith("BI") || t.startsWith("CC") || t.includes("IDENT")) return "B";
  return "O";
}

export function isIsoDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function todayIso(now: Date = new Date()): string {
  // Portugal is UTC+0 / UTC+1; using UTC keeps the check stable on the Worker.
  return now.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateProperty(p: PropertyInfo): FieldError[] {
  const e: FieldError[] = [];
  if (!/^\d{9}$/.test(p.codigo_unidade)) e.push({ field: "codigo_unidade", message: "NIPC must have 9 digits" });
  if (!/^\d{1,4}$/.test(p.estabelecimento)) e.push({ field: "estabelecimento", message: "Establishment number must be numeric (e.g. 00)" });
  if (!p.nome || p.nome.length > 40) e.push({ field: "nome", message: "Name is required (max 40 characters)" });
  if (!p.abreviatura || p.abreviatura.length > 15) e.push({ field: "abreviatura", message: "Abbreviation is required (max 15 characters)" });
  if (!p.morada || p.morada.length > 40) e.push({ field: "morada", message: "Address is required (max 40 characters)" });
  if (!p.localidade || p.localidade.length > 30) e.push({ field: "localidade", message: "Locality is required (max 30 characters)" });
  if (!/^\d{4}$/.test(p.codigo_postal)) e.push({ field: "codigo_postal", message: "Postal code must have 4 digits" });
  if (!/^\d{3}$/.test(p.zona_postal)) e.push({ field: "zona_postal", message: "Postal zone must have 3 digits" });
  if (!/^\d{6,10}$/.test(p.telefone)) e.push({ field: "telefone", message: "Phone must contain 6 to 10 digits" });
  if (p.fax && !/^\d{6,10}$/.test(p.fax)) e.push({ field: "fax", message: "Fax must contain only digits" });
  if (!p.nome_contacto || p.nome_contacto.length > 40) e.push({ field: "nome_contacto", message: "Contact name is required (max 40 characters)" });
  if (!p.email_contacto || p.email_contacto.length > 140 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email_contacto))
    e.push({ field: "email_contacto", message: "A valid contact e-mail is required" });
  if (!p.chave_activacao) e.push({ field: "chave_activacao", message: "Activation key (Chave de Activação) is required" });
  return e;
}

/**
 * Validates a bulletin that is about to be sent to SIBA. `today` is YYYY-MM-DD.
 * Returns an empty array when the bulletin is complete and valid.
 */
export function validateGuest(g: GuestBulletin, today: string = todayIso()): FieldError[] {
  const e: FieldError[] = [];
  if (!g.apelido) e.push({ field: "apelido", message: "Surname is required" });
  if (g.apelido.length > 40) e.push({ field: "apelido", message: "Surname: max 40 characters" });
  if (g.nome.length > 40) e.push({ field: "nome", message: "Given names: max 40 characters" });
  if (!isCountryCode(g.nacionalidade)) e.push({ field: "nacionalidade", message: "Nationality is required" });
  if (!isIsoDate(g.data_nascimento)) e.push({ field: "data_nascimento", message: "Date of birth is required (YYYY-MM-DD)" });
  else if (g.data_nascimento >= today) e.push({ field: "data_nascimento", message: "Date of birth must be in the past" });
  if (g.local_nascimento && g.local_nascimento.length > 30) e.push({ field: "local_nascimento", message: "Place of birth: max 30 characters" });
  if (!g.documento_identificacao) e.push({ field: "documento_identificacao", message: "Document number is required" });
  else if (!/^[A-Z0-9]{1,16}$/.test(g.documento_identificacao))
    e.push({ field: "documento_identificacao", message: "Document number: only letters and digits (max 16)" });
  if (!["P", "B", "O"].includes(g.tipo_documento)) e.push({ field: "tipo_documento", message: "Document type must be P, B or O" });
  if (!isCountryCode(g.pais_emissor_documento)) e.push({ field: "pais_emissor_documento", message: "Issuing country is required" });
  if (!isIsoDate(g.data_entrada)) e.push({ field: "data_entrada", message: "Check-in date is required" });
  else if (g.data_entrada > today) e.push({ field: "data_entrada", message: "SIBA only accepts check-in dates up to today" });
  if (g.data_saida) {
    if (!isIsoDate(g.data_saida)) e.push({ field: "data_saida", message: "Check-out date is invalid" });
    else if (isIsoDate(g.data_entrada) && g.data_saida < g.data_entrada)
      e.push({ field: "data_saida", message: "Check-out must be on or after check-in" });
  }
  if (!isCountryCode(g.pais_residencia_origem)) e.push({ field: "pais_residencia_origem", message: "Country of residence is required" });
  if (!g.local_residencia_origem) e.push({ field: "local_residencia_origem", message: "Place of residence (city) is required" });
  if (g.local_residencia_origem.length > 30) e.push({ field: "local_residencia_origem", message: "Place of residence: max 30 characters" });
  return e;
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

export function escapeXml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlDate(iso: string): string {
  // xs:dateTime; SIBA only uses the date part.
  return `${iso}T00:00:00`;
}

function tag(name: string, value: unknown, indent = "    "): string {
  return `${indent}<${name}>${escapeXml(value)}</${name}>\n`;
}

/** Builds the MovimentoBAL document (BAL.XSD). */
export function buildMovimentoBAL(
  p: PropertyInfo,
  guests: GuestBulletin[],
  fileNumber: number,
  now: Date = new Date(),
): string {
  let x = '<?xml version="1.0" encoding="utf-8"?>\n';
  x += '<MovimentoBAL xmlns="http://sef.pt/BAws">\n';
  x += "  <Unidade_Hoteleira>\n";
  x += tag("Codigo_Unidade_Hoteleira", p.codigo_unidade);
  x += tag("Estabelecimento", p.estabelecimento);
  x += tag("Nome", p.nome);
  x += tag("Abreviatura", p.abreviatura);
  x += tag("Morada", p.morada);
  x += tag("Localidade", p.localidade);
  x += tag("Codigo_Postal", p.codigo_postal);
  x += tag("Zona_Postal", p.zona_postal);
  x += tag("Telefone", p.telefone);
  if (p.fax) x += tag("Fax", p.fax);
  x += tag("Nome_Contacto", p.nome_contacto);
  x += tag("Email_Contacto", p.email_contacto);
  x += "  </Unidade_Hoteleira>\n";
  for (const g of guests) {
    x += "  <Boletim_Alojamento>\n";
    x += tag("Apelido", g.apelido);
    if (g.nome) x += tag("Nome", g.nome);
    x += tag("Nacionalidade", g.nacionalidade);
    x += tag("Data_Nascimento", xmlDate(g.data_nascimento));
    if (g.local_nascimento) x += tag("Local_Nascimento", g.local_nascimento);
    x += tag("Documento_Identificacao", g.documento_identificacao);
    x += tag("Pais_Emissor_Documento", g.pais_emissor_documento);
    x += tag("Tipo_Documento", g.tipo_documento);
    x += tag("Data_Entrada", xmlDate(g.data_entrada));
    if (g.data_saida) x += tag("Data_Saida", xmlDate(g.data_saida));
    x += tag("Pais_Residencia_Origem", g.pais_residencia_origem);
    x += tag("Local_Residencia_Origem", g.local_residencia_origem);
    x += "  </Boletim_Alojamento>\n";
  }
  x += "  <Envio>\n";
  x += tag("Numero_Ficheiro", fileNumber);
  x += tag("Data_Movimento", now.toISOString().slice(0, 19));
  x += "  </Envio>\n";
  x += "</MovimentoBAL>\n";
  return x;
}

export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function buildSoapEnvelope(p: PropertyInfo, boletinsBase64: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
    'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n' +
    "  <soap:Body>\n" +
    '    <EntregaBoletinsAlojamento xmlns="http://sef.pt/">\n' +
    `      <UnidadeHoteleira>${escapeXml(p.codigo_unidade)}</UnidadeHoteleira>\n` +
    `      <Estabelecimento>${escapeXml(String(parseInt(p.estabelecimento, 10) || 0))}</Estabelecimento>\n` +
    `      <ChaveAcesso>${escapeXml(p.chave_activacao)}</ChaveAcesso>\n` +
    `      <Boletins>${boletinsBase64}</Boletins>\n` +
    "    </EntregaBoletinsAlojamento>\n" +
    "  </soap:Body>\n" +
    "</soap:Envelope>\n"
  );
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export interface SibaResult {
  ok: boolean;
  code: string; // "0" on success
  message: string;
  line?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
}

function pick(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i"));
  return m ? m[1].trim() : undefined;
}

export function parseSibaResponse(body: string, httpStatus = 200): SibaResult {
  const text = body ?? "";
  const fault = pick(text, "faultstring");
  if (fault) return { ok: false, code: "SOAP_FAULT", message: cleanText(decodeEntities(fault)) };

  const resultRaw = pick(text, "EntregaBoletinsAlojamentoResult");
  if (resultRaw === undefined) {
    if (httpStatus >= 400) return { ok: false, code: `HTTP_${httpStatus}`, message: cleanText(text).slice(0, 300) || `HTTP ${httpStatus}` };
    // Some proxies return plain "0"
    if (cleanText(text) === "0") return { ok: true, code: "0", message: "OK" };
    return { ok: false, code: "UNEXPECTED", message: `Unexpected response: ${cleanText(text).slice(0, 300)}` };
  }
  const result = decodeEntities(resultRaw).trim();
  if (result === "0") return { ok: true, code: "0", message: "OK" };

  const code = pick(result, "Codigo_Retorno") ?? "";
  const desc = pick(result, "Descricao") ?? "";
  const line = pick(result, "Linha");
  return {
    ok: false,
    code: cleanText(code) || "ERROR",
    message: cleanText(decodeEntities(desc)) || cleanText(result).slice(0, 300),
    line: line ? cleanText(line) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendOutcome extends SibaResult {
  httpStatus: number;
  responseRaw: string;
  requestXml: string;
  endpoint: string;
}

export async function sendToSiba(
  endpoint: string,
  property: PropertyInfo,
  guests: GuestBulletin[],
  fileNumber: number,
  fetchImpl: typeof fetch = fetch,
): Promise<SendOutcome> {
  const requestXml = buildMovimentoBAL(property, guests, fileNumber);
  const envelope = buildSoapEnvelope(property, base64Utf8(requestXml));
  let httpStatus = 0;
  let responseRaw = "";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45_000);
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `"${SIBA_SOAP_ACTION}"`,
        Accept: "text/xml",
        "User-Agent": SIBA_USER_AGENT, // some IIS/WAF front-ends reject requests without one
      },
      body: envelope,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    httpStatus = res.status;
    responseRaw = await res.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "NETWORK", message: `Could not reach SIBA: ${msg}`, httpStatus, responseRaw, requestXml, endpoint };
  }
  const parsed = parseSibaResponse(responseRaw, httpStatus);
  return { ...parsed, httpStatus, responseRaw, requestXml, endpoint };
}
