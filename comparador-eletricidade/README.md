# Comparador de Faturas de Eletricidade (Portugal · España)

Site estático onde o utilizador carrega a **fatura de eletricidade em PDF**; o browser lê as
rubricas da fatura e compara o que está a pagar com as ofertas do mercado:

* **Portugal** – todas as ofertas publicadas pela **ERSE** (EDP Comercial, Endesa, Iberdrola, Galp,
  Goldenergy, Repsol, Plenitude, MEO Energia, SU Eletricidade/tarifa regulada, …).
* **España** (peaje 2.0TD) – lista curada de tarifas de Endesa, Iberdrola, Naturgy, Repsol,
  TotalEnergies, Octopus, Plenitude, Chippio e Imagina, com **comparação conceito a conceito**
  (potencia, energía, bono social, alquiler, impuesto eléctrico, IVA, total) e ligação ao
  comparador oficial da CNMC. O país é detetado automaticamente a partir do texto da fatura.

Rubricas lidas da fatura portuguesa:

| Rubrica                              | O que extraímos                          |
| ------------------------------------ | ---------------------------------------- |
| Termo de Energia (Real / Estimado)   | kWh, €/kWh, valor, desconto, total (por período: simples, fora de vazio, vazio, ponta, cheias) |
| Termo de Potência                    | dias, €/dia, kVA, total                  |
| Termo Fixo Acesso às Redes           | dias, €/dia, total                       |
| Contribuição Audiovisual             | meses, €/mês, total                      |
| Taxa Exploração DGEG                 | meses, €/mês, total                      |
| Imposto Especial Consumo             | kWh, €/kWh, total                        |
| Período de faturação, potência contratada, opção horária, totais e IVA (6 % / 23 %), fornecedor |

Conceptos leídos de la factura española (Endesa, Iberdrola, Naturgy, Repsol, …):

| Concepto                                   | Qué extraemos                                        |
| ------------------------------------------ | ---------------------------------------------------- |
| Potencia P1 (punta-llano) / P2-P3 (valle)  | kW × €/kW·día (o €/kW·año) × días = €                |
| Energía / Consumo                          | kWh × €/kWh = € (precio único o punta/llano/valle)   |
| Financiación Bono Social                   | días × €/día = €                                     |
| Alquiler del contador                      | días × €/día = €                                     |
| Impuesto electricidad                      | base × % = €                                         |
| IVA / IGIC / IPSI                          | % s/ base = €                                        |
| TOTAL, periodo, potencias contratadas, lecturas punta/llano/valle, comercializadora y nombre del contrato |

Tudo corre **no browser** (pdf.js) – o PDF nunca sai do computador do utilizador.

## Como correr

```bash
cd comparador-eletricidade
npm install          # pdfjs-dist (browser), pdfkit + jsdom (só para gerar exemplos e testar)
npm run vendor       # copia pdf.js para public/vendor/pdfjs
npm run data:build   # gera public/data/ofertas.json a partir do ZIP ERSE em data-src/
npm run samples      # gera as faturas de exemplo em public/samples/ (opcional)
npm start            # http://localhost:3000  (PORT=8080 npm start para outra porta)
npm test             # testes do parser, do simulador e da interface (jsdom)
```

`public/` é 100 % estático – pode ser publicado em qualquer alojamento (Cloudflare Pages, GitHub
Pages, Netlify, nginx…) sem o `server.mjs`. A pasta `cloudflare-upload/` e o `.zip` estão
commitados no repositório, prontos a enviar.

## Deploy no Cloudflare Pages

```bash
npm install && npm run vendor && npm run data:build && npm run build
```

`npm run build` cria a pasta **`cloudflare-upload/`** (e o ficheiro `comparador-eletricidade-cloudflare.zip`)
com tudo o que o browser precisa: `index.html`, `app.js`, `styles.css`, `lib/`, `vendor/pdfjs/`,
`data/ofertas.json`, `samples/`, mais `_headers`, `_redirects`, `404.html`, `robots.txt` e
`build.json` (indica a data do dataset ERSE em produção).

**Opção A – upload direto (sem Git):** Cloudflare Dashboard → *Workers & Pages* → *Create* →
*Pages* → *Upload assets* → dar nome ao projeto → arrastar a **pasta `cloudflare-upload/`** (ou o `.zip`) →
*Deploy site*. Cada atualização = repetir o upload (*Create new deployment*).

**Opção B – CLI (wrangler):**

```bash
npx wrangler login
npx wrangler pages deploy cloudflare-upload --project-name comparador-eletricidade
```

**Opção C – ligado ao GitHub (build automático a cada push):** *Create* → *Pages* → *Connect to
Git* → escolher o repositório e definir:

| Campo                  | Valor                                                                  |
| ---------------------- | ---------------------------------------------------------------------- |
| Root directory         | `comparador-eletricidade`                                              |
| Build command          | `npm run vendor && npm run data:build && npm run build`                |
| Build output directory | `cloudflare-upload`                                                    |

(Node 20+ é o predefinido no Cloudflare; se necessário defina a variável `NODE_VERSION=22`.)
Para atualizar as ofertas basta trocar o ZIP em `data-src/` (ou correr `npm run data:update` e
fazer commit do novo ZIP) – o build regenera o `ofertas.json`.

Não são precisos Functions, KV ou variáveis de ambiente – o site não tem backend.

## Atualizar as ofertas (dados ERSE)

Os preços vêm do simulador oficial da ERSE (<https://simuladorprecos.erse.pt>), que publica um
ZIP com dois CSV (`CondComerciais_ELEGN.csv` e `Precos_ELEGN.csv`) cerca de duas vezes por semana.

```bash
npm run data:update                       # descarrega o ZIP mais recente da ERSE e regenera o JSON
node scripts/update-erse.mjs --zip f.zip  # ou a partir de um ZIP já descarregado
npm run data:build                        # ou a partir do ZIP mais recente em data-src/
```

O JSON gerado inclui a data de publicação (mostrada no cabeçalho do site). Também há um endpoint
`POST /api/refresh-data` no `server.mjs` que corre a atualização no servidor.

Dataset atual: ZIP ERSE de **2026-09-02** (809 ofertas, 28 comercializadores, 17 114 linhas de preços).

## Tarifas españolas (`public/data/ofertas-es.json`)

No existe un fichero público de precios del mercado español (el comparador de la CNMC no ofrece
descarga y su API interna no es pública), por lo que la lista se mantiene **a mano** con los
precios sin impuestos publicados en las webs de las comercializadoras (y, cuando la web no los
muestra, en Rastreator/Selectra). Cada tarifa guarda `source.url` y `source.date`; el detalle de
cada tarifa en el sitio muestra esa fuente. Campos: `energy` (`single` o `punta/llano/valle`,
€/kWh), `power` (`p1`/`p2`, €/kW·día), `after` (precios tras la promoción), `feePerDay`/`feePerMonth`
(indexadas), `extraPerKwh` (p. ej. SNOEE de Repsol), `maxPower`, `maxKwhYear`, `newClientsOnly`,
`onlineOnly`, `indexed`, `renewable`, `notes`.

```bash
npm run data:check-es      # simula la factura de referencia (4,6 kW, 277 kWh, 31 días) con todas las tarifas
npm run data:cnmc          # consulta la API del comparador CNMC para el mismo perfil (sólo desde tu PC;
                           # imprime el coste anual de cada oferta para detectar tarifas nuevas/obsoletas)
```

Modelo de factura (`public/lib/simulator-es.js`, reproduce al céntimo la factura de Endesa incluida
como ejemplo, 89,84 €): potencia = kW × €/kW·día × días (P1 y P2); energía = kWh × €/kWh;
financiación bono social 0,024688 €/día y alquiler del contador (iguales en todas las tarifas);
impuesto eléctrico 5,11269632 % sobre potencia + energía + cuotas + bono social (mínimo 1 €/MWh);
IVA 21 % sobre todo lo anterior más el alquiler. Si la factura tiene precio único, el reparto
punta/llano/valle para simular tarifas con discriminación horaria se toma de las lecturas de la
propia factura (o de un perfil típico 30/26/44 % si no aparecen).

## Como é feita a comparação (Portugal)

Para cada oferta reconstruímos a fatura completa com o perfil do utilizador (kVA, opção horária,
kWh por período, dias faturados):

* Termo de Energia = kWh × €/kWh (preços ERSE já incluem a tarifa de acesso às redes)
* Termo de Potência = dias × €/dia (idem – por isso na fatura somamos *Termo de Potência* +
  *Termo Fixo Acesso às Redes* para obter o €/dia comparável)
* IEC 0,001 €/kWh, Taxa DGEG 0,07 €/mês, CAV 2,85 €/mês
* IVA 2026: 6 % nos primeiros 200 kWh/30 dias (300 kWh para famílias numerosas) até 6,9 kVA;
  6 % no termo fixo de acesso às redes até 3,45 kVA; 23 % no resto (Continente).
* Reembolsos/descontos publicados na ERSE (percentuais, fixos anuais, €/kWh), custo de serviços
  obrigatórios e descontos de boas-vindas (pro-rata ao período; nunca aplicados ao fornecedor atual).

A fatura "baseline" do utilizador é recalculada com os preços lidos (após descontos) – nos exemplos
incluídos o total simulado coincide com o total impresso na fatura.

Os filtros permitem excluir ofertas indexadas (OMIE), condicionadas (parcerias/ACP/Plano Amigo),
com serviços obrigatórios, duais (luz+gás), só para novos clientes, já terminadas, e mostrar
apenas a melhor oferta de cada comercializador.

## Estrutura

```
public/
  index.html, styles.css, app.js     interface (3 passos: PDF → valores → comparação)
  lib/pdf-text.js                    extração de texto com pdf.js (reconstrói linhas por coordenadas)
  lib/parser.js                      parser das rubricas da fatura (PT)
  lib/simulator.js                   motor de cálculo da fatura / IVA / comparação (PT)
  app-es.js, lib/parser-es.js, lib/simulator-es.js   fluxo espanhol (deteção de país, parser 2.0TD, modelo de fatura)
  data/ofertas.json                  ofertas ERSE (gerado)
  data/ofertas-es.json               tarifas españolas (curadas a mano, com fonte e data)
  vendor/pdfjs/                      pdf.js (gerado por npm run vendor)
  samples/                           faturas de exemplo fictícias (Endesa simples, EDP bi-horária, Endesa España 2.0TD)
scripts/
  update-erse.mjs, lib/erse-parse.mjs  download + conversão dos CSV da ERSE
  vendor-pdfjs.mjs                     copia pdf.js
  make-sample-pdf.mjs                  gera os PDFs de exemplo (pdfkit)
  pdf-to-text.mjs                      debug: `node scripts/pdf-to-text.mjs fatura.pdf --parse`
  update-cnmc.mjs                      consulta a API do comparador da CNMC (npm run data:cnmc)
  build-dist.mjs                       cria cloudflare-upload/ + zip para Cloudflare Pages (npm run build)
server.mjs                           servidor estático local (gzip) + /api/refresh-data
wrangler.toml                        config Cloudflare Pages (output dir = cloudflare-upload)
test/                                node --test (parser, simulador, UI em jsdom)
```

## Compatibilidade de browsers

O pdf.js está **fixado na versão 4.10.38 (build legacy)**. As versões 5+/6+ usam `for await … of
readableStream` em `getTextContent()`, que o Safari (macOS/iOS, todas as versões até à 26) não
suporta – o sintoma é *"Erro ao ler o PDF: undefined is not a function (near '...t of e...')"*
(mozilla/pdf.js#21557; as correções propostas não foram integradas). Não atualize o `pdfjs-dist`
para 5.x sem confirmar em Safari; `npm run vendor` recusa versões que não sejam 4.x.

Adicionalmente `npm run vendor` injeta um polyfill de `ReadableStream[Symbol.asyncIterator]` no
início de `pdf.min.js` e `pdf.worker.min.js`, coloca-os numa pasta versionada
(`public/vendor/pdfjs-<versão>/`, cacheável para sempre) e atualiza o caminho em
`lib/pdf-text.js`. O site funciona em Safari 16.4+, Chrome/Edge 100+ e Firefox 115+; browsers
mais antigos recebem uma mensagem clara a sugerir a introdução manual dos valores. A versão da
aplicação aparece no rodapé (`APP_VERSION` em `app.js`) e nas mensagens de erro.

## Limitações conhecidas

* PDFs digitalizados (imagem) não têm texto – o site pede a introdução manual dos valores.
* Faturas com layouts muito diferentes podem falhar em algumas rubricas; o passo 2 mostra o que
  foi (e não foi) reconhecido e permite corrigir. `npm run pdf:text -- fatura.pdf` ajuda a afinar
  o parser (`public/lib/parser.js`, `LINE_DEFS`).
* IVA das Regiões Autónomas (Madeira 4 %/22 %, Açores 4 %/16 %) não está implementado.
* Ofertas indexadas usam o preço médio comunicado à ERSE – o valor real varia com o OMIE.
* España: la lista de tarifas es manual (fecha en cada tarifa) y no incluye PVPC ni tarifas
  planas/flexibles; IGIC/IPSI se aplican sólo si la factura los indica. Confirme siempre en el
  comparador oficial de la CNMC (botón con sus datos ya cargados) antes de cambiar.
