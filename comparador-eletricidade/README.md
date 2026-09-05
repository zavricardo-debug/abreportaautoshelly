# Comparador de Faturas de Eletricidade (Portugal)

Site estático onde o utilizador carrega a **fatura de eletricidade em PDF**; o browser lê as
rubricas da fatura e compara o que está a pagar com **todas as ofertas do mercado português**
(EDP Comercial, Endesa, Iberdrola, Galp, Goldenergy, Repsol, Plenitude, MEO Energia, SU
Eletricidade/tarifa regulada, …) usando a lista oficial de preços publicada pela **ERSE**.

Rubricas lidas da fatura:

| Rubrica                              | O que extraímos                          |
| ------------------------------------ | ---------------------------------------- |
| Termo de Energia (Real / Estimado)   | kWh, €/kWh, valor, desconto, total (por período: simples, fora de vazio, vazio, ponta, cheias) |
| Termo de Potência                    | dias, €/dia, kVA, total                  |
| Termo Fixo Acesso às Redes           | dias, €/dia, total                       |
| Contribuição Audiovisual             | meses, €/mês, total                      |
| Taxa Exploração DGEG                 | meses, €/mês, total                      |
| Imposto Especial Consumo             | kWh, €/kWh, total                        |
| Período de faturação, potência contratada, opção horária, totais e IVA (6 % / 23 %), fornecedor |

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

## Como é feita a comparação

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
  lib/parser.js                      parser das rubricas da fatura
  lib/simulator.js                   motor de cálculo da fatura / IVA / comparação
  data/ofertas.json                  ofertas ERSE (gerado)
  vendor/pdfjs/                      pdf.js (gerado por npm run vendor)
  samples/                           faturas de exemplo fictícias (Endesa simples, EDP bi-horária)
scripts/
  update-erse.mjs, lib/erse-parse.mjs  download + conversão dos CSV da ERSE
  vendor-pdfjs.mjs                     copia pdf.js
  make-sample-pdf.mjs                  gera os PDFs de exemplo (pdfkit)
  pdf-to-text.mjs                      debug: `node scripts/pdf-to-text.mjs fatura.pdf --parse`
  build-dist.mjs                       cria cloudflare-upload/ + zip para Cloudflare Pages (npm run build)
server.mjs                           servidor estático local (gzip) + /api/refresh-data
wrangler.toml                        config Cloudflare Pages (output dir = cloudflare-upload)
test/                                node --test (parser, simulador, UI em jsdom)
```

## Compatibilidade de browsers

Safari (macOS/iOS até à versão 26) não implementa `ReadableStream[Symbol.asyncIterator]`, que o
pdf.js 5 usa (`for await … of stream`) – o sintoma é *"undefined is not a function (near '...t of
e...')"*. O `npm run vendor` injeta um polyfill no início de `pdf.min.js` e `pdf.worker.min.js`, e
`lib/pdf-text.js` lê o texto com um `reader` clássico, por isso o site funciona em Safari 16.4+,
Chrome/Edge 100+ e Firefox 115+. Browsers mais antigos recebem uma mensagem clara a sugerir a
introdução manual dos valores.

## Limitações conhecidas

* PDFs digitalizados (imagem) não têm texto – o site pede a introdução manual dos valores.
* Faturas com layouts muito diferentes podem falhar em algumas rubricas; o passo 2 mostra o que
  foi (e não foi) reconhecido e permite corrigir. `npm run pdf:text -- fatura.pdf` ajuda a afinar
  o parser (`public/lib/parser.js`, `LINE_DEFS`).
* IVA das Regiões Autónomas (Madeira 4 %/22 %, Açores 4 %/16 %) não está implementado.
* Ofertas indexadas usam o preço médio comunicado à ERSE – o valor real varia com o OMIE.
