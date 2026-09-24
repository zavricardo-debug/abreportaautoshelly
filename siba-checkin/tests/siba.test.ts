import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64Utf8,
  buildMovimentoBAL,
  buildSoapEnvelope,
  normalizeDocNumber,
  normalizeDocType,
  normalizeName,
  parseSibaResponse,
  selfTestBulletin,
  sendToSiba,
  SIBA_ENDPOINTS,
  SIBA_TEST_UNIT,
  validateGuest,
  validateProperty,
  type GuestBulletin,
  type PropertyInfo,
} from "../src/siba.ts";
import { COUNTRIES, isCountryCode } from "../src/countries.ts";

const property: PropertyInfo = {
  codigo_unidade: "121212121",
  estabelecimento: "00",
  nome: "Hotel teste",
  abreviatura: "teste",
  morada: "Rua da Alegria, 172",
  localidade: "Portalegre",
  codigo_postal: "1000",
  zona_postal: "234",
  telefone: "214017744",
  fax: "",
  nome_contacto: "Nuno teste",
  email_contacto: "teste.teste@sef.pt",
  chave_activacao: "999999999",
};

const guest: GuestBulletin = {
  apelido: "DOE",
  nome: "JOHN",
  nacionalidade: "GBR",
  data_nascimento: "1980-05-17",
  local_nascimento: "LONDON",
  documento_identificacao: "AB1234567",
  tipo_documento: "P",
  pais_emissor_documento: "GBR",
  data_entrada: "2026-09-15",
  data_saida: "2026-09-18",
  pais_residencia_origem: "GBR",
  local_residencia_origem: "LONDON",
};

test("name normalisation follows SIBA character rules", () => {
  assert.equal(normalizeName("  müller-lüdenscheidt "), "MULLER-LUDENSCHEIDT");
  assert.equal(normalizeName("João D'Ávila"), "JOÃO D'ÁVILA");
  assert.equal(normalizeName("O’Neil"), "O'NEIL");
  assert.equal(normalizeName("Straße"), "STRASSE");
  assert.equal(normalizeName("Ana-Maria Ñoño"), "ANA-MARIA NONO");
  assert.equal(normalizeName("A".repeat(50)).length, 40);
  assert.equal(normalizeName("123 Bad!Name"), "BADNAME");
});

test("document number and type normalisation", () => {
  assert.equal(normalizeDocNumber(" ab 12-34.56 "), "AB123456");
  assert.equal(normalizeDocNumber("x".repeat(30)).length, 16);
  assert.equal(normalizeDocType("passport"), "P");
  assert.equal(normalizeDocType("B"), "B");
  assert.equal(normalizeDocType("ID"), "B");
  assert.equal(normalizeDocType("driving licence"), "O");
});

test("country table contains SIBA specific codes", () => {
  assert.equal(COUNTRIES.length, 208);
  assert.ok(isCountryCode("D"), "Germany must be 'D' per SIBA table");
  assert.ok(isCountryCode("RKS"));
  assert.ok(isCountryCode("PRT"));
  assert.ok(!isCountryCode("DEU"));
  assert.ok(!isCountryCode(""));
});

test("property validation", () => {
  assert.deepEqual(validateProperty(property), []);
  const bad = { ...property, codigo_unidade: "123", zona_postal: "12", email_contacto: "nope", chave_activacao: "" };
  const fields = validateProperty(bad).map((e) => e.field);
  assert.deepEqual(fields, ["codigo_unidade", "zona_postal", "email_contacto", "chave_activacao"]);
});

test("guest validation", () => {
  assert.deepEqual(validateGuest(guest, "2026-09-16"), []);
  const errs = validateGuest({ ...guest, apelido: "", nacionalidade: "XXX", data_entrada: "2026-09-20", documento_identificacao: "AB 12" }, "2026-09-16");
  const fields = errs.map((e) => e.field);
  assert.ok(fields.includes("apelido"));
  assert.ok(fields.includes("nacionalidade"));
  assert.ok(fields.includes("data_entrada"));
  assert.ok(fields.includes("documento_identificacao"));
  // check-out before check-in
  assert.ok(validateGuest({ ...guest, data_saida: "2026-09-01" }, "2026-09-16").some((e) => e.field === "data_saida"));
  // birth date must be in the past
  assert.ok(validateGuest({ ...guest, data_nascimento: "2026-09-16" }, "2026-09-16").some((e) => e.field === "data_nascimento"));
  // optional fields
  assert.deepEqual(validateGuest({ ...guest, nome: "", local_nascimento: "", data_saida: null }, "2026-09-16"), []);
});

test("MovimentoBAL XML matches BAL.XSD structure", () => {
  const xml = buildMovimentoBAL(property, [guest, { ...guest, nome: "", local_nascimento: "", data_saida: null }], 7, new Date("2026-09-16T10:20:30Z"));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(xml.includes('<MovimentoBAL xmlns="http://sef.pt/BAws">'));
  // Unidade_Hoteleira, order of elements
  const uh = xml.slice(xml.indexOf("<Unidade_Hoteleira>"), xml.indexOf("</Unidade_Hoteleira>"));
  const order = [...uh.matchAll(/<([A-Za-z_]+)>/g)].map((m) => m[1]).slice(1);
  assert.deepEqual(order, ["Codigo_Unidade_Hoteleira", "Estabelecimento", "Nome", "Abreviatura", "Morada", "Localidade", "Codigo_Postal", "Zona_Postal", "Telefone", "Fax", "Nome_Contacto", "Email_Contacto"]);
  assert.ok(uh.includes("<Fax></Fax>"), "empty fax is still emitted as an empty element");
  // Boletim elements
  assert.equal((xml.match(/<Boletim_Alojamento>/g) || []).length, 2);
  const b1 = xml.slice(xml.indexOf("<Boletim_Alojamento>"), xml.indexOf("</Boletim_Alojamento>"));
  const bOrder = [...b1.matchAll(/<([A-Za-z_]+)>/g)].map((m) => m[1]).slice(1);
  assert.deepEqual(bOrder, ["Apelido", "Nome", "Nacionalidade", "Data_Nascimento", "Local_Nascimento", "Documento_Identificacao", "Pais_Emissor_Documento", "Tipo_Documento", "Data_Entrada", "Data_Saida", "Pais_Residencia_Origem", "Local_Residencia_Origem"]);
  assert.ok(xml.includes("<Data_Nascimento>1980-05-17T00:00:00</Data_Nascimento>"));
  assert.ok(xml.includes("<Data_Entrada>2026-09-15T00:00:00</Data_Entrada>"));
  // second guest without optional fields
  const b2 = xml.slice(xml.lastIndexOf("<Boletim_Alojamento>"), xml.lastIndexOf("</Boletim_Alojamento>"));
  assert.ok(!b2.includes("<Nome>") && !b2.includes("<Local_Nascimento>") && !b2.includes("<Data_Saida>"));
  // Envio
  assert.ok(xml.includes("<Numero_Ficheiro>7</Numero_Ficheiro>"));
  assert.ok(xml.includes("<Data_Movimento>2026-09-16T10:20:30</Data_Movimento>"));
  // escaping
  const esc = buildMovimentoBAL({ ...property, morada: "R. <A&B> \"x\"" }, [guest], 1);
  assert.ok(esc.includes("<Morada>R. &lt;A&amp;B&gt; &quot;x&quot;</Morada>"));
});

test("SOAP envelope", () => {
  const b64 = base64Utf8("<a>ção</a>");
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), "<a>ção</a>");
  const env = buildSoapEnvelope(property, b64);
  assert.ok(env.includes('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'));
  assert.ok(env.includes('<EntregaBoletinsAlojamento xmlns="http://sef.pt/">'));
  assert.ok(env.includes("<UnidadeHoteleira>121212121</UnidadeHoteleira>"));
  assert.ok(env.includes("<Estabelecimento>0</Estabelecimento>"), "Estabelecimento is int in the SOAP method");
  assert.ok(env.includes("<ChaveAcesso>999999999</ChaveAcesso>"));
  assert.ok(env.includes(`<Boletins>${b64}</Boletins>`));
});

test("response parsing", () => {
  const ok = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><EntregaBoletinsAlojamentoResponse xmlns="http://sef.pt/"><EntregaBoletinsAlojamentoResult>0</EntregaBoletinsAlojamentoResult></EntregaBoletinsAlojamentoResponse></soap:Body></soap:Envelope>`;
  assert.deepEqual(parseSibaResponse(ok), { ok: true, code: "0", message: "OK" });

  const err = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><EntregaBoletinsAlojamentoResponse xmlns="http://sef.pt/"><EntregaBoletinsAlojamentoResult>&lt;ErrosBA&gt;&lt;RetornoBA&gt;&lt;Linha&gt;2&lt;/Linha&gt;&lt;Codigo_Retorno&gt;22&lt;/Codigo_Retorno&gt;&lt;Descricao&gt;Chave de acesso inválida&lt;/Descricao&gt;&lt;/RetornoBA&gt;&lt;/ErrosBA&gt;</EntregaBoletinsAlojamentoResult></EntregaBoletinsAlojamentoResponse></soap:Body></soap:Envelope>`;
  const parsed = parseSibaResponse(err);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "22");
  assert.equal(parsed.message, "Chave de acesso inválida");
  assert.equal(parsed.line, "2");

  const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Server was unable to process request.</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
  assert.equal(parseSibaResponse(fault, 500).code, "SOAP_FAULT");

  assert.equal(parseSibaResponse("<html>bad gateway</html>", 502).code, "HTTP_502");
});

test("official endpoints and self-test fixtures", () => {
  assert.equal(SIBA_ENDPOINTS.production, "https://siba.ssi.gov.pt/baws/boletinsalojamento.asmx");
  assert.equal(SIBA_ENDPOINTS.development, "https://siba.ssi.gov.pt/bawsdev/boletinsalojamento.asmx");
  // SEF's fictitious unit must itself pass our validation, and so must the fake bulletin
  assert.deepEqual(validateProperty(SIBA_TEST_UNIT), []);
  assert.deepEqual(validateGuest(selfTestBulletin("2026-09-16"), "2026-09-16"), []);
  assert.equal(SIBA_TEST_UNIT.codigo_unidade, "121212121");
  assert.equal(SIBA_TEST_UNIT.chave_activacao, "999999999");
});

test("sendToSiba: request shape, success and network failure", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const okFetch: typeof fetch = async (url, init) => {
    seen = { url: String(url), init: init ?? {} };
    return new Response(
      `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><EntregaBoletinsAlojamentoResponse xmlns="http://sef.pt/"><EntregaBoletinsAlojamentoResult>0</EntregaBoletinsAlojamentoResult></EntregaBoletinsAlojamentoResponse></soap:Body></soap:Envelope>`,
      { status: 200, headers: { "Content-Type": "text/xml; charset=utf-8" } },
    );
  };
  const r = await sendToSiba(SIBA_ENDPOINTS.development, SIBA_TEST_UNIT, [selfTestBulletin("2026-09-16")], 42, okFetch);
  assert.equal(r.ok, true);
  assert.equal(r.code, "0");
  assert.equal(r.httpStatus, 200);
  assert.ok(seen);
  const { url, init } = seen!;
  assert.equal(url, SIBA_ENDPOINTS.development);
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers["Content-Type"], "text/xml; charset=utf-8");
  assert.equal(headers.SOAPAction, '"http://sef.pt/EntregaBoletinsAlojamento"');
  assert.ok(headers["User-Agent"]);
  const body = String(init.body);
  assert.ok(body.includes("<UnidadeHoteleira>121212121</UnidadeHoteleira>"));
  assert.ok(body.includes("<Estabelecimento>0</Estabelecimento>"));
  assert.ok(body.includes("<ChaveAcesso>999999999</ChaveAcesso>"));
  const b64 = body.match(/<Boletins>([^<]+)<\/Boletins>/)![1];
  const xml = Buffer.from(b64, "base64").toString("utf8");
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(xml.includes("<Numero_Ficheiro>42</Numero_Ficheiro>"));
  assert.equal(xml, r.requestXml);

  const downFetch: typeof fetch = async () => {
    throw new TypeError("fetch failed: ECONNRESET");
  };
  const bad = await sendToSiba(SIBA_ENDPOINTS.development, SIBA_TEST_UNIT, [selfTestBulletin("2026-09-16")], 43, downFetch);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "NETWORK");
  assert.match(bad.message, /Could not reach SIBA/);
});
