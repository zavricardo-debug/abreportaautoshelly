#!/usr/bin/env node
// Local simulator of the SIBA SOAP web service, for development and testing.
//   node tools/mock-siba.mjs            (listens on http://127.0.0.1:9797)
// Then set in .dev.vars:  SIBA_ENDPOINT=http://127.0.0.1:9797/baws/boletinsalojamento.asmx
//
// Behaviour:
//   - decodes the Base64 <Boletins> payload and validates the basic BAL structure
//   - ChaveAcesso "000000000" -> returns SIBA error 22 (invalid key) to test error handling
//   - otherwise returns "0" (success), like the real service.
import http from "node:http";

const PORT = Number(process.env.PORT || 9797);

function xmlEsc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function pick(xml, name) {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i"));
  return m ? m[1].trim() : undefined;
}
function soapResult(result) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <EntregaBoletinsAlojamentoResponse xmlns="http://sef.pt/">
      <EntregaBoletinsAlojamentoResult>${xmlEsc(result)}</EntregaBoletinsAlojamentoResult>
    </EntregaBoletinsAlojamentoResponse>
  </soap:Body>
</soap:Envelope>`;
}
function errorResult(code, desc, line = 1) {
  return `<ErrosBA><RetornoBA><Linha>${line}</Linha><Codigo_Retorno>${code}</Codigo_Retorno><Descricao>${xmlEsc(desc)}</Descricao></RetornoBA></ErrosBA>`;
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Mock SIBA</h1><p>POST SOAP to /baws/boletinsalojamento.asmx</p>");
      return;
    }
    const uh = pick(body, "UnidadeHoteleira");
    const est = pick(body, "Estabelecimento");
    const key = pick(body, "ChaveAcesso");
    const b64 = pick(body, "Boletins");
    let result = "0";
    let decoded = "";
    try {
      decoded = Buffer.from(b64 ?? "", "base64").toString("utf8");
    } catch {
      /* ignore */
    }
    if (!uh || !/^\d{9}$/.test(uh)) result = errorResult(10, "Unidade Hoteleira inválida");
    else if (!key) result = errorResult(21, "Chave de acesso em falta");
    else if (key === "000000000") result = errorResult(22, "Chave de acesso inválida");
    else if (!decoded.includes("<MovimentoBAL")) result = errorResult(30, "Conteúdo XML inválido");
    else if (!decoded.includes("<Boletim_Alojamento>")) result = errorResult(31, "Sem boletins");
    else {
      const n = (decoded.match(/<Boletim_Alojamento>/g) || []).length;
      const fileNo = pick(decoded, "Numero_Ficheiro");
      console.log(`[mock-siba] ${new Date().toISOString()} UH=${uh}${uh === "121212121" ? " (SEF test unit)" : ""} Est=${est} ficheiro=${fileNo} boletins=${n} -> OK`);
      if (process.env.VERBOSE) console.log(decoded);
    }
    if (result !== "0") console.log(`[mock-siba] rejected: ${result}`);
    res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
    res.end(soapResult(result));
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`[mock-siba] listening on http://127.0.0.1:${PORT}/baws/boletinsalojamento.asmx`));
