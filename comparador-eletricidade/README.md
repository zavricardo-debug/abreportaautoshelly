# Comparador de Faturas de Eletricidade (Portugal · España)

Site estático onde o utilizador carrega a **fatura de eletricidade em PDF**; o browser lê as
rubricas da fatura e compara o que está a pagar com as ofertas do mercado:

* **Portugal** – todas as ofertas publicadas pela **ERSE** (EDP Comercial, Endesa, Iberdrola, Galp,
  Goldenergy, Repsol, Plenitude, MEO Energia, SU Eletricidade/tarifa regulada, …).
* **España** (peaje 2.0TD) – **mercado completo**: todas as ofertas para vivienda registadas no
  **comparador oficial da CNMC** (≈150 ofertas de ≈60 comercializadoras – Endesa, Iberdrola, Naturgy,
  Repsol, TotalEnergies, Octopus, Plenitude, Enérgya-VM, CHC, Imagina, Visalia, niba, Gaolania, Nufri,
  PVPC, cooperativas…), consultadas em direto para o perfil da fatura, com **comparação conceito a
  conceito** (potencia, energía, bono social, alquiler, impuesto eléctrico, IVA, total) e ligação ao
  comparador oficial. Se a CNMC não responder, usa-se a lista guardada na aplicação (também construída
  a partir da CNMC). O país é detetado automaticamente a partir do texto da fatura.

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

Além da fatura, é possível juntar o **ficheiro de consumos por hora / 15 minutos** (CSV, `.xls` ou
`.xlsx` da E-Redes em Portugal, CSV/Excel da Datadis ou da distribuidora em Espanha) – há uma segunda
zona de upload logo no passo 1 e outra no passo 2 – para que a comparação use o consumo **real** de
cada período horário – ver [Consumos por hora (E-Redes)](#consumos-por-hora-e-redes--ficheiro-excel-ou-csv)
e [Curva de consumo horario (CSV)](#curva-de-consumo-horario-csv-o-excel).

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
`data/ofertas.json`, `samples/`, mais `_headers`, `_redirects`, `404.html`, `robots.txt`,
`build.json` (indica a versão da app e as datas dos datasets em produção) e o **`_worker.js`** +
`_routes.json` do proxy `/api/cnmc/*` (ver [Tarifas españolas](#tarifas-españolas-publicdataofertas-esjson)).

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

Não são precisos KV nem variáveis de ambiente. O único código de servidor é o `_worker.js` na raiz do
bundle (Pages *advanced mode*, funciona também no upload direto): trata apenas `/api/cnmc/*` – proxy
GET, só de leitura, para a API do comparador da CNMC (que recusa pedidos com cabeçalho `Origin` do
browser) com cache de 6 h – e entrega tudo o resto como ficheiros estáticos. Se o worker não estiver
publicado (bundle antigo), o site continua a funcionar com a lista guardada.

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

La lista española se construye a partir del **comparador oficial de la CNMC**
(<https://comparador.cnmc.gob.es>), donde cada comercializadora está obligada a registrar sus ofertas.
El comparador no publica precios unitarios ni ofrece descarga, sólo el **importe anual estimado** de
cada oferta para el perfil consultado; su cálculo es lineal en potencia y consumo, así que la
aplicación lo invierte:

1. **Mercado completo (en vivo, por defecto).** Al comparar, el navegador pide al proxy `/api/cnmc/`
   siete listas: seis *perfiles de derivación* fijos (iguales para todos los usuarios, cacheados en el
   edge) que permiten resolver por oferta el término de potencia P1/P2, los tres precios de energía y
   la cuota fija, y la lista del **perfil de la factura** (potencia, consumo anualizado por periodo,
   código postal), que dice qué ofertas se pueden contratar y cuánto estima la CNMC para cada una. Las
   ofertas que no aparecen en alguna lista de derivación (límites de potencia/consumo) se resuelven con
   tres llamadas al detalle. Cada oferta se **verifica** reproduciendo al céntimo el importe anual que
   publica la CNMC para el perfil del usuario (`cnmc.verified`); las de horas flexibles (Repsol «10
   horas») no se pueden reconstruir por periodos y sólo muestran el importe de la CNMC. El detalle de
   cada oferta muestra el n.º de oferta CNMC, sus importes anuales, la comprobación y los enlaces a la
   web y al contrato registrados por la comercializadora. Módulos: `public/lib/cnmc.js` (matemática y
   marcas), `public/app-cnmc.js` (carga), `cloudflare/_worker.js` y `server.mjs` (proxy).
2. **Lista guardada (`public/data/ofertas-es.json`).** Copia estática, con la misma estructura, usada
   cuando la CNMC no responde o al elegir «Lista guardada» en el selector de fuente. Se regenera con:

```bash
npm run data:cnmc          # desde un PC con internet: descarga las listas de la CNMC, deriva y verifica los
                           # precios, escribe public/data/ofertas-es.json + reports/cnmc-update.json (1–3 min)
node scripts/update-cnmc-offers.mjs --dry           # sólo imprime el resumen
node scripts/update-cnmc-offers.mjs --no-detail     # sin las llamadas al detalle (condiciones/límites)
node scripts/update-cnmc-offers.mjs --cp 08001 --p1 4.6 --p2 4.6 --kwh 1029,1017,1218   # perfil de referencia
npm run data:check-es      # simula la factura de referencia (4,6 kW, 277 kWh, 31 días) con la lista guardada
npm run data:cnmc:link     # antiguo: imprime el coste anual CNMC de cada oferta para un perfil
```

Después de regenerar: `npm test && npm run build` y volver a desplegar. La lista guardada actual
(publicada el 2026-09-08) es la lista curada anterior, con los precios publicados por las
comercializadoras, y sólo cubre 10 comercializadoras; el modo en vivo cubre todo el mercado.

Campos de cada oferta: `energy` (`single` o `punta/llano/valle`, €/kWh), `power` (`p1`/`p2`,
€/kW·día), `after` (precios tras la promoción), `feePerDay`/`feePerMonth` (cuotas o descuentos fijos),
`extraPerKwh`, `bonoSocialIncluded`, `maxPower`/`minPower`/`maxKwhYear`, `newClientsOnly`,
`permanence`, `servicesIncluded`, `indexed`, `renewable`, `flexible`, `notes`, `source{name,url,date,
contract}` y, en las ofertas CNMC, `cnmcId`/`cnmcHist`, `legalName` y `cnmc{firstYear, secondYear,
validez, method, verified, delta, contracting}`.

Modelo de factura (`public/lib/simulator-es.js`, reproduce al céntimo la factura de Endesa incluida
como ejemplo, 89,84 €): potencia = kW × €/kW·día × días (P1 y P2); energía = kWh × €/kWh;
financiación bono social 0,024688 €/día y alquiler del contador (iguales en todas las tarifas);
impuesto eléctrico 5,11269632 % sobre potencia + energía + cuotas + bono social (mínimo 1 €/MWh);
IVA 21 % sobre todo lo anterior más el alquiler. Si la factura tiene precio único, el reparto
punta/llano/valle para simular tarifas con discriminación horaria se toma de las lecturas de la
propia factura (o de un perfil típico 30/26/44 % si no aparecen).

Lectura de la factura (`public/lib/parser-es.js`): se leen **todas** las líneas de coste
(potencia P1/P2, energía por periodo o precio único, descuentos y cuotas de la tarifa, servicios
adicionales, bono social, alquiler, impuesto eléctrico, IVA, total) y el paso 2 muestra cada línea
tal como viene en la factura junto al valor recalculado (deben coincidir; si no, el campo
correspondiente se puede corregir). Las líneas informativas de la primera página («consumo medio
diario», «mismo periodo del año anterior»…), los subtotales de sección («Potencia 22,71 €») y la
copia del detalle que algunas facturas repiten no se contabilizan dos veces; los subtotales se usan
para comprobar las sumas. Los descuentos de la tarifa actual entran en la base imponible (como la
energía); los servicios adicionales (mantenimiento, seguros…) sólo llevan IVA y quedan fuera de la
comparación con las tarifas. `npm run pdf:text -- factura.pdf --parse` detecta el país y ejecuta el
parser correspondiente.

### Curva de consumo horario (CSV o Excel)

La factura sólo da el total de kWh (o, en el mejor de los casos, las lecturas por periodo), así que
para las tarifas con discriminación horaria el reparto punta/llano/valle es una estimación. En el paso 2
se puede adjuntar el **CSV o Excel (.xlsx) de consumo horario** que se descarga gratis de [Datadis](https://datadis.es)
o del área de cliente de la distribuidora (e-distribución, i-DE, UFD, Viesgo…). Los `.xlsx` se leen en el
navegador con `public/lib/xlsx-lite.js` (fechas/horas en texto o en números de serie de Excel) y los `.xls`
antiguos (Excel 97-2003, o tablas HTML/XML guardadas como `.xls`) con `public/lib/xls-lite.js`; también
`.ods`, tablas «pivot» (una fila por día y una columna por hora) y ficheros con varias hojas.
`public/lib/consumption-es.js` lee los formatos habituales (`CUPS;Fecha;Hora;Consumo_kWh;Metodo_obtencion`
de Datadis/CNMC, `AE_kWh;AS_KWh;…` de e-distribución, `FECHA-HORA;…;CONSUMO Wh` de i-DE, el fichero del
**área de clientes de Endesa** – 6 filas de metadatos `CUPS:`, `Fecha inicio:`, `Tarifa:`… y después
`Fecha,Hora,Consumo (Wh),Precio (€/kWh),Coste por hora (€)` con horas `00:00-01:00` y una fila `Total (Wh):`
al final, o la variante antigua `Fecha;Hora 0..23;Consumo;Precio (€);Coste por hora` – ficheros sin
cabecera, cuartohorarios 1..96 o `HH:MM`, valores en Wh o kWh, coma o punto decimal) y clasifica cada hora
según el calendario 2.0TD de la Circular 3/2020 (laborables: punta 10–14 h y 18–22 h, llano 8–10, 14–18 y
22–24 h, valle 0–8 h; sábados, domingos, 6 de enero y festivos nacionales de fecha fija valle las 24 h;
Ceuta y Melilla con la punta desplazada a 11–15 h y 19–23 h). La columna `Hora` 1..24 de las
distribuidoras es la hora *final* del intervalo (hora 1 = 00:00–01:00).

La tabla de resultados muestra, dentro de la columna **Energía**, lo que cuestan los kWh de cada periodo
(punta / llano / valle) **con los precios de su factura → con la tarifa**, y el botón **Detalle** abre con
la tabla *Energía por periodo horario – lo que paga hoy vs. esta tarifa* (kWh, €/kWh y € de cada lado,
diferencia). Si su factura tiene precio único, "paga hoy" es kWh del periodo × ese precio único, de modo que
se ve cuánto le cuestan hoy las horas de valle que una tarifa de tres periodos abarataría.

Con la curva cargada, el botón **Detalle** de cada tarifa añade la sección *Energía hora a hora con su consumo
real*: cada hora del fichero se clasifica en punta / llano / valle según el día en que se consumió, se multiplica
por el precio de ese periodo en la tarifa y en su factura, y se muestran el gráfico (barras grises = su tarifa,
de colores = la tarifa) y una tabla de 24 filas con kWh, coste y diferencia por hora (`public/app-hourly.js`).

Con la curva cargada: se muestran el reparto real por periodos (comparado con el de la factura), el perfil
medio de un día laborable y de fin de semana (barras coloreadas por periodo), y los kWh de punta/llano/valle
del formulario se sustituyen por los reales (recortados al periodo de la factura si la curva lo cubre y
escalados a los kWh facturados). En los resultados aparece una tabla adicional con la energía de cada
tarifa por periodo (kWh × precio de punta, llano y valle) y un selector «si trasladase a valle» para
simular el ahorro de mover parte del consumo a las horas valle. `npm run samples:curve` genera
`public/samples/consumo-horario-ejemplo.csv` (744 horas coherentes con la factura de ejemplo).

## Consumos por hora (E-Redes) – ficheiro Excel ou CSV

A fatura portuguesa nem sempre mostra o consumo repartido por **vazio / cheias / ponta** – numa
tarifa simples só aparece o total e, mesmo em bi-horário, não há forma de saber quanto se pagaria em
tri-horário (ou noutro ciclo). Por isso o passo 2 aceita um segundo ficheiro: o **diagrama de carga**
que qualquer cliente com contador inteligente descarrega gratuitamente no
[Balcão Digital da E-Redes](https://balcaodigital.e-redes.pt)
(**Consumos → Consultar consumos detalhados → Exportar**, dados desde 01/01/2024; tem de ser o ficheiro
de *Consumos/Diagrama de carga*, não o de *Leituras*). O ficheiro pode ser largado na segunda zona de
upload do passo 1 («Consumos por hora»), na caixa própria do passo 2 ou até na zona do PDF (o site
percebe que não é um PDF) – antes ou depois da fatura.

O que é lido (`public/lib/consumption-pt.js`):

* **Excel `.xlsx`** diretamente no browser, sem bibliotecas externas – `public/lib/xlsx-lite.js` é um
  leitor mínimo de OOXML (inflate RFC 1951 + diretório ZIP + `sharedStrings.xml`/`sheetN.xml`), com
  datas/horas em texto ou em números de série do Excel.
* **Excel `.xls`** (97-2003, BIFF8/BIFF5) – `public/lib/xls-lite.js` percorre o contentor OLE2 (FAT,
  mini-FAT, diretório) e os registos BIFF (`LABELSST`/`SST`+`CONTINUE`, `NUMBER`, `RK`, `MULRK`,
  `LABEL`, `FORMULA` com resultado em cache, formatos de data, sistema 1904). Também lê os «falsos» `.xls`
  que muitos portais exportam: uma **tabela HTML** ou um documento **SpreadsheetML 2003** com extensão
  `.xls`, ficheiros SYLK/DIF e texto UTF-16 («Texto Unicode» do Excel). Folhas **OpenDocument `.ods`**
  (LibreOffice) também são lidas (`content.xml`). Quando o livro tem várias folhas/tabelas todas são
  tentadas (a primeira com dados reconhecíveis ganha) e, se nenhuma servir, a mensagem de erro mostra as
  primeiras linhas lidas para facilitar o diagnóstico.
* **Tabela «pivot»** (uma linha por dia e uma coluna por hora – `Fecha | 0h … 23h`, `Data | 00:00 … 23:00`,
  ou 96 colunas de quartos de hora), como exportam algumas áreas de cliente: é convertida para o formato
  hora a hora antes de classificar.
* **CSV/TXT** com `;`, `,` ou tabulações, vírgula ou ponto decimal, com ou sem linhas de título antes do
  cabeçalho (`Data | Hora | Consumo registado, Ativa (kW) | [Injeção registada…] | [Estado]`).
* Formato E-Redes: um registo por **15 minutos**, hora = **fim** do intervalo (`00:15` = 00:00–00:15,
  `00:00` = último quarto do dia anterior) e valores em **kW médios** → kWh = kW ÷ 4. Também aceita
  ficheiros horários genéricos (`Data;Hora;Consumo (kWh)`, hora `HH:MM` ou índice 1..24, valores em
  Wh/kWh, timestamps UTC de contadores tipo Shelly), colunas de injeção (ignoradas) e `Estado`
  (Real/Estimado). Ficheiros só com totais diários são recusados com explicação.
* Cada quarto de hora é classificado com os **períodos horários da ERSE** para Portugal Continental,
  hora legal de Inverno/Verão (último domingo de março → último domingo de outubro), nos dois ciclos:
  * **Ciclo diário** (igual todos os dias): vazio 22–08 h; Inverno ponta 09:00–10:30 e 18:00–20:30,
    Verão ponta 10:30–13:00 e 19:30–21:00; restante cheias.
  * **Ciclo semanal**: dias úteis vazio 00–07 h, Inverno ponta 09:30–12:00 e 18:30–21:00, Verão ponta
    09:15–12:15, restante cheias; sábado sem ponta (Inverno cheias 09:30–13:00 e 18:30–22:00, Verão
    09:00–14:00 e 20:00–22:00, resto vazio); domingo vazio todo o dia.
  * Bi-horário: fora de vazio = ponta + cheias. O ciclo é lido da fatura quando lá aparece («ciclo
    diário»/«ciclo semanal») e pode ser mudado no próprio painel.

A tabela de resultados mostra, na coluna **Energia**, quanto custam os kWh de cada período (ponta / cheias /
vazio ou fora de vazio / vazio) **com os preços da sua fatura → com a oferta**, e o botão **Detalhe** abre com
a tabela *Energia por período horário – o que paga hoje vs. esta oferta*. Quando a oferta tem outra opção
horária (p. ex. tri-horária face a uma fatura bi-horária) os preços atuais são aplicados aos mesmos kWh
período a período (vazio = vazio; fora de vazio = ponta + cheias; de tri para bi usa-se a média ponderada
dos preços de ponta e cheias).

Com o ficheiro carregado, o botão **Detalhe** de cada oferta (passo 3) acrescenta a secção *Energia hora a
hora com o seu consumo real*: cada quarto de hora do ficheiro é classificado em ponta / cheias / vazio no
ciclo escolhido e no horário legal do dia em que foi consumido, multiplicado pelo preço desse período na
oferta e na sua tarifa, com gráfico (barras cinzentas = a sua tarifa, coloridas = a oferta) e tabela de 24
linhas com kWh, custo e diferença por hora (`public/app-hourly.js`).

Com o ficheiro carregado o passo 2 mostra: ficheiro/período/nº de dias, consumo total (recortado ao
período da fatura quando o ficheiro o cobre), repartição real em **tri-horário** e **bi-horário** para
os dois ciclos (tabela + barras), **potência máxima registada** (média de 15 min, comparada com a
potência contratada – útil para avaliar uma descida de potência), avisos (valores estimados, injeção)
e três perfis médios (dia útil, sábado, domingo) em quartos de hora coloridos por período. Os kWh por
período do formulário passam a ser os reais (escalados ao total faturado) e no passo 3 o seletor
**«Opção horária a comparar»** permite ver as ofertas em **simples, bi-horário e tri-horário** com o
mesmo consumo real (cada linha indica a opção); **«E se passar consumo para o vazio?»** transfere
10/25/50 % do consumo fora de vazio para o vazio para medir o interesse de mudar hábitos. Sem
ficheiro só é possível simular a opção da fatura e a simples (esta só precisa do total).

`npm run samples:eredes` gera `public/samples/consumos-eredes-exemplo.xlsx` (+ `.csv`): 38 dias de
quartos de hora no layout da E-Redes, coerentes com as faturas de exemplo (botão «Experimentar com um
ficheiro de exemplo»). Os testes (`test/consumption-pt.test.mjs`, `test/app.test.mjs`) cobrem os
horários da ERSE, os leitores xlsx/xls (fixtures `.xls` gerados com xlwt, tabela HTML e SpreadsheetML),
ficheiros com datas em série do Excel e o fluxo completo na interface.

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
  lib/consumption-es.js              curva horaria ES (CSV Datadis/distribuidoras, calendario 2.0TD)
  app-curve-pt.js, lib/consumption-pt.js   consumos E-Redes (PT): leitura, horários ERSE (ciclo diário/semanal), repartição por período
  lib/xlsx-lite.js                   leitor .xlsx sem dependências (inflate + zip + OOXML) usado pelos dois fluxos
  lib/xls-lite.js                    leitor .xls (OLE2 + BIFF8/5) e de tabelas HTML / SpreadsheetML guardadas como .xls
  data/ofertas.json                  ofertas ERSE (gerado)
  data/ofertas-es.json               tarifas españolas guardadas (fallback do modo em direto CNMC)
  lib/cnmc.js, app-cnmc.js           mercado completo ES: API do comparador CNMC, derivação/verificação de preços, marcas
  vendor/pdfjs/                      pdf.js (gerado por npm run vendor)
  samples/                           faturas de exemplo fictícias (Endesa simples, EDP bi-horária, Endesa España 2.0TD),
                                     curva horaria ES (CSV) e diagrama de carga E-Redes (xlsx + csv)
scripts/
  update-erse.mjs, lib/erse-parse.mjs  download + conversão dos CSV da ERSE
  vendor-pdfjs.mjs                     copia pdf.js
  make-sample-pdf.mjs                  gera os PDFs de exemplo (pdfkit)
  make-sample-curve.mjs, make-sample-eredes.mjs   geram a curva ES e o Excel/CSV E-Redes de exemplo
  pdf-to-text.mjs                      debug: `node scripts/pdf-to-text.mjs fatura.pdf --parse`
  update-cnmc-offers.mjs               regenera ofertas-es.json a partir do comparador da CNMC (npm run data:cnmc)
  update-cnmc.mjs                      antigo: imprime o custo anual CNMC de cada oferta (npm run data:cnmc:link)
  build-dist.mjs                       cria cloudflare-upload/ + zip para Cloudflare Pages (npm run build)
cloudflare/_worker.js                worker Pages (proxy /api/cnmc/* → comparador CNMC), copiado para a raiz do bundle
server.mjs                           servidor estático local (gzip) + /api/refresh-data + proxy /api/cnmc/*
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
* España: los precios del modo «Mercado completo» se derivan de los importes anuales de la CNMC
  (perfil horario estándar del comparador); las tarifas flexibles por horas no se reconstruyen y las
  indexadas usan el precio medio con el que la CNMC las calcula. La lista guardada sólo cubre las
  comercializadoras incluidas cuando se generó. IGIC/IPSI se aplican sólo si la factura los indica.
  Confirme siempre en el comparador oficial de la CNMC (botón con sus datos ya cargados) antes de
  cambiar.
* Curva horaria / consumos E-Redes: se prueban todas las hojas del libro (`.xls`/`.xlsx`/`.ods`); los
  ficheros protegidos con contraseña deben guardarse sin protección o como CSV; las tarifas
  indexadas se simulan con su precio medio (no hora a hora con el precio OMIE de cada hora); los
  excedentes de autoconsumo no se compensan. Em Portugal os horários implementados
  são os do Continente (Açores/Madeira têm ciclos próprios) e os do Regulamento Tarifário em vigor
  (os novos períodos anunciados pela ERSE para 2027 ainda não estão incluídos).
