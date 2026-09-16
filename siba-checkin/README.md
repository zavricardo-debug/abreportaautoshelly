# Check-in online · Boletins de Alojamento (SIBA / AIMA)

Página web para os **hóspedes preencherem os dados de identificação** exigidos pela lei
portuguesa (AIMA — antigo SEF) e **enviá-los automaticamente ao SIBA** através do web service
oficial `EntregaBoletinsAlojamento`. Corre inteiramente no **Cloudflare** (Workers + D1 + Assets),
sem servidores para gerir, dentro do plano gratuito para um alojamento local.

```
Hóspede  ──►  /r/<slug>/<código>  ──►  Worker  ──►  D1 (base de dados: reservas, hóspedes, envios)
                (formulário)                 └────►  SIBA  https://siba.ssi.gov.pt/baws/boletinsalojamento.asmx
Administrador ──► /admin  (unidade hoteleira, reservas, botão "Enviar ao SIBA", histórico/XML)
```

## Funcionalidades

- **Formulário do hóspede** (EN/PT/ES/FR/DE, telemóvel) com todos os campos do Boletim de
  Alojamento: apelido, nome, nacionalidade (tabela ICAO do SIBA — ex.: Alemanha = `D`),
  data/local de nascimento, tipo/número/país do documento, país e localidade de residência,
  datas de entrada/saída. Vários hóspedes por reserva. Botão **ENVIAR**.
- **Validação** conforme as regras do SIBA (maiúsculas, caracteres permitidos nos nomes,
  n.º de documento só `A-Z0-9`, códigos de país válidos, datas coerentes, tamanhos máximos).
- **Envio ao SIBA** imediato quando o hóspede carrega em ENVIAR (se a data de entrada já
  chegou). Entradas futuras ficam em fila e são enviadas **automaticamente no dia** por uma
  tarefa agendada (cron de 4 em 4 h). Retorno `0` = aceite; erros ficam registados.
- **Painel de administração** (`/admin`, palavra-passe): dados da **Unidade Hoteleira**
  (Código Unidade Hoteleira/NIPC, N.º de ordem/Estabelecimento, Nome, Abreviatura, Morada,
  Localidade, Código Postal, Zona Postal, Telefone, Nome Contacto, Email Contacto,
  **Chave de Activação**), lista/pesquisa de reservas, criação de reservas e **links** para
  hóspedes, edição dos dados, botão **Enviar ao SIBA** (também quando falta algo — os campos
  em falta são assinalados), cancelamento, **histórico de envios com o XML enviado e a
  resposta do SIBA**.
- **Base de dados** (Cloudflare D1/SQLite): `properties`, `reservations`, `guests`,
  `siba_submissions` (auditoria completa de cada chamada).
- Hóspedes de nacionalidade **portuguesa** ficam registados localmente e não são enviados ao
  SIBA (a obrigação de comunicação é apenas para estrangeiros).
- Segurança: chave de ativação nunca sai do servidor; sessão de administrador em cookie
  HttpOnly assinado; proteção CSRF; links de hóspede com código aleatório (~100 bits);
  Cloudflare Turnstile opcional no formulário público.

## Pré-requisitos no SIBA

1. Unidade registada no portal SIBA (https://siba.ssi.gov.pt) e ofício com **NIPC**,
   **n.º de estabelecimento** (normalmente `00`) e **chave de ativação**.
2. Modo de envio = **Web Service**. Se registou com outro modo, peça a alteração para
   `siba@sef.pt` indicando o NIPC.

## Primeiro envio real — procedimento recomendado

1. Depois do deploy, entre em `/admin` → separador **Ajuda** → **Testar ligação ao SIBA**.
   Envia um boletim fictício da unidade de testes do SEF (NIPC `121212121`, chave `999999999`)
   para o ambiente de desenvolvimento `…/bawsdev/…`. Não usa a sua chave nem dados reais e nada
   fica gravado. Resultado esperado: **retorno 0**. Se falhar com `NETWORK`/`HTTP_5xx`, o problema
   é de ligação; se falhar com um código SIBA, é de formato — em ambos os casos o XML e a resposta
   ficam visíveis no ecrã.
2. Registe a sua **Unidade Hoteleira** (dados do ofício) — o cartão fica com o selo "pronta".
3. Crie uma reserva de teste com **um hóspede real** (ex.: o primeiro hóspede estrangeiro que chegar,
   com data de entrada = hoje) e carregue em **Enviar ao SIBA**. Confirme:
   - estado **Comunicado** e retorno `0` no histórico da reserva;
   - o ofício comprovativo chegou ao e-mail de contacto (também em *Área reservada → Entrega dos
     Boletins → Consulta de Ofícios Emitidos*).
4. Erros típicos na primeira comunicação: `Não foi possível autenticar a Unidade Hoteleira` /
   `Dados de Entrada Inválidos` ⇒ NIPC, n.º de estabelecimento ou chave diferentes do ofício;
   `O método de envio selecionado … não lhe permite efetuar esta operação` ⇒ modo de envio ainda
   não é Web Service. Corrija em **Unidade Hoteleira** e volte a carregar em **Enviar ao SIBA**.

## Instalação automática (recomendado)

Um único comando cria a base de dados D1, aplica as migrações, publica o Worker, define os
secrets e faz o teste de ligação ao SIBA. É idempotente — pode repetir sempre que quiser.

**Opção A — no seu computador** (precisa de Node 22+ e de uma conta Cloudflare):

```bash
cd siba-checkin
npm ci
npx wrangler login          # abre o browser; em alternativa: export CLOUDFLARE_API_TOKEN=...
npm run setup               # pergunta a password do /admin e trata do resto
```

**Opção B — GitHub Actions** (nada é instalado no seu computador; o token fica só no GitHub):

1. Crie um token em `dash.cloudflare.com → My Profile → API Tokens → Create Token`, modelo
   **Edit Cloudflare Workers**, e acrescente a permissão **Account → D1 → Edit**.
2. No repositório GitHub: `Settings → Secrets and variables → Actions → New repository secret`:
   `CLOUDFLARE_API_TOKEN` (o token), `ADMIN_PASSWORD` (password do painel, mín. 6 caracteres) e,
   só se a sua conta Cloudflare tiver acesso a várias contas, `CLOUDFLARE_ACCOUNT_ID`.
3. `Actions → Deploy SIBA check-in to Cloudflare → Run workflow`. O resumo do job mostra o endereço
   do painel e o resultado do teste ao SIBA. A partir daí, cada alteração em `siba-checkin/` que
   chegue ao ramo `main` é publicada automaticamente.

O script nunca imprime nem grava o token; os secrets são enviados ao Cloudflare por `stdin`.
Depois da primeira execução, faça commit do `database_id` que ficou em `wrangler.jsonc`.

## Instalação manual (passo a passo)

```bash
cd siba-checkin
npm install
npx wrangler login                       # autentica no Cloudflare

npx wrangler d1 create siba-checkin      # cria a base de dados
#   → copie o "database_id" devolvido para wrangler.jsonc (d1_databases[0].database_id)

npx wrangler d1 migrations apply DB --remote   # cria as tabelas

npx wrangler secret put ADMIN_PASSWORD   # palavra-passe do /admin (mín. 6 caracteres)
npx wrangler secret put SESSION_SECRET   # texto aleatório longo (ex.: openssl rand -hex 32)

npm run deploy                           # publica em https://siba-checkin.<conta>.workers.dev
```

Depois abra `https://…/admin`, entre com a palavra-passe e registe a **Unidade Hoteleira**
com os dados do ofício. O link para os hóspedes é `https://…/r/<slug>` (slug escolhido por si,
ex.: `ladra`) — ou crie a reserva no painel e envie o link individual `…/r/<slug>/<código>`.

### Domínio próprio (opcional)
No painel Cloudflare → Workers & Pages → siba-checkin → Settings → Domains & Routes, adicione
o seu domínio (ex.: `checkin.exemplo.pt`).

### Variáveis (wrangler.jsonc → `vars`)

| Variável | Valor | Significado |
|---|---|---|
| `SIBA_ENV` | `production` / `development` | produção (`https://siba.ssi.gov.pt/baws/`) ou ambiente de testes do SEF (`/bawsdev/`) |
| `AUTO_SEND` | `true` / `false` | `false` = o hóspede só grava; o administrador envia manualmente |
| `APP_NAME` | texto | nome mostrado |
| `TURNSTILE_SITE_KEY` + secret `TURNSTILE_SECRET` | opcional | anti-bot no formulário público |
| secret `SIBA_ENDPOINT` | URL | força um endpoint (ex.: simulador local) |

## Desenvolvimento local

```bash
cp .dev.vars.example .dev.vars           # defina ADMIN_PASSWORD (e SIBA_ENDPOINT do simulador)
npm run db:migrate:local
npm run mock:siba                        # simulador do web service SIBA em http://127.0.0.1:9797
npm run dev                              # http://127.0.0.1:8787  (guest: /r/<slug>  admin: /admin)
npm test                                 # testes unitários (XML, validação, SOAP, respostas)
curl http://127.0.0.1:8787/cdn-cgi/local/scheduled   # dispara o cron localmente
```

O simulador devolve `0` (aceite); com chave de ativação `000000000` devolve o erro 22 para
testar o fluxo de erro.

## Estados de uma reserva

| Estado | Significado |
|---|---|
| `draft` | link criado / dados guardados, hóspede ainda não carregou em ENVIAR |
| `submitted` | hóspede enviou; à espera da data de entrada (ou de envio manual se `AUTO_SEND=false`) |
| `sent` | todos os boletins aceites pelo SIBA (retorno `0`) |
| `error` | SIBA rejeitou / dados incompletos — corrigir no painel e **Enviar ao SIBA** |
| `cancelled` | cancelada pelo administrador |

O envio ao SIBA só acontece depois de alguém o **autorizar** (coluna `approved`): o hóspede ao carregar em
ENVIAR com `AUTO_SEND=true`, ou o administrador ao carregar em **Enviar ao SIBA**. Se a data de entrada ainda
não chegou, a reserva fica `submitted` + autorizada e o cron envia-a no dia do check-in. Com `AUTO_SEND=false`
as reservas dos hóspedes ficam `submitted` **sem** autorização e o cron não lhes toca — só o administrador envia.
O painel mostra esta diferença ("agendada" vs. "aguarda envio pelo administrador").

## Estrutura

```
siba-checkin/
├── wrangler.jsonc          configuração Cloudflare (Worker, D1, assets, cron)
├── migrations/0001_init.sql  esquema da base de dados
├── src/
│   ├── index.ts            rotas HTTP (API pública + API de administração) e cron
│   ├── service.ts          lógica de envio (validação → XML → SIBA → registo)
│   ├── siba.ts             cliente SIBA: normalização, validação, XML BAL, SOAP, parsing
│   ├── db.ts               acesso à base de dados D1
│   ├── auth.ts             sessão do administrador (HMAC) e códigos aleatórios
│   └── countries.ts        tabela de países/códigos ICAO do SIBA
├── public/
│   ├── checkin.html        formulário do hóspede (servido em /r/<slug>[/<código>])
│   ├── admin.html          painel de administração (/admin)
│   ├── i18n.js, app.css, index.html, _headers
├── tools/mock-siba.mjs     simulador local do web service SIBA
└── tests/siba.test.ts      testes unitários
```

## Referências

- Modos de envio / especificação do web service e do XML (BAL.XSD):
  https://siba.ssi.gov.pt/ajuda/modos-de-envio/
- Tabela de países (códigos ICAO): https://siba.ssi.gov.pt/ajuda/modos-de-envio/lista-de-paises/
- Prazo legal: 3 dias úteis após a entrada e após a saída (Lei n.º 23/2007, art. 15.º e 16.º).
