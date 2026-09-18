#!/usr/bin/env node
/**
 * Instalação automática no Cloudflare — idempotente (pode correr as vezes que quiser).
 *
 *   0. pré-voo: validação do token de API (se fornecido) e permissões de D1
 *   1. cria a base de dados D1 "siba-checkin" (se ainda não existir) na Europa Ocidental
 *   2. escreve o database_id em wrangler.jsonc
 *   3. aplica as migrações na base de dados remota
 *   4. garante que a conta tem um subdomínio workers.dev (contas novas não têm) e publica o Worker
 *   5. define os secrets ADMIN_PASSWORD e SESSION_SECRET (só os que faltam ou os que forem passados)
 *   6. faz o teste de ligação ao SIBA (ambiente de desenvolvimento, unidade fictícia do SEF)
 *
 * Autenticação (uma das duas — o token nunca é escrito em ficheiro nem impresso):
 *   - variável de ambiente CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID se tiver mais do que uma conta)
 *   - sessão criada com `npx wrangler login`
 *
 * Variáveis opcionais: ADMIN_PASSWORD, SESSION_SECRET, WORKERS_SUBDOMAIN (nome do subdomínio a
 * registar, se a conta ainda não tiver), WORKER_URL (domínio próprio, para os testes finais).
 *
 * Exemplos:
 *   npm run setup
 *   ADMIN_PASSWORD='a-minha-password' npm run setup
 *   node tools/setup-cloudflare.mjs --ci      (GitHub Actions: sem perguntas; falha se faltar algo)
 *   node tools/setup-cloudflare.mjs --skip-selftest
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "siba-checkin";
const WORKER_NAME = "siba-checkin";
const CF_API = (process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4").replace(/\/$/, "");
const isWin = process.platform === "win32";
const CI = process.argv.includes("--ci") || !!process.env.CI || !process.stdin.isTTY;
const SKIP_SELFTEST = process.argv.includes("--skip-selftest");
const API_TOKEN = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
const wranglerBin = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^\s\*\s?/gm, ""));
  process.exit(0);
}

const log = (m) => console.log(`\n▶ ${m}`);
const fail = (m) => {
  console.error(`\n✘ ${m}`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs the project-local wrangler non-interactively (never blocks on a prompt). */
function wrangler(args, { input, capture = false, quiet = false } = {}) {
  const r = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd: root,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" },
    input,
    stdio: capture ? "pipe" : [input !== undefined ? "pipe" : "inherit", "inherit", "inherit"],
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (capture && !quiet) {
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
  }
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function extractJsonArray(text) {
  // wrangler prints the JSON array on its own line(s); tolerate banners/warnings around it
  const m = text.match(/^\s*\[[\s\S]*\]\s*$/m);
  if (m) return JSON.parse(m[0]);
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a < 0 || b < a) throw new Error("no JSON array in output");
  return JSON.parse(text.slice(a, b + 1));
}

/** Direct Cloudflare API call (only possible when authenticating with an API token). */
async function cfApi(p, init = {}) {
  const res = await fetch(`${CF_API}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${API_TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const j = await res.json().catch(() => ({}));
  return { http: res.status, ok: j.success === true, result: j.result, errors: Array.isArray(j.errors) ? j.errors : [] };
}

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

// ---------------------------------------------------------------------------
// 0. dependencies + authentication + pre-flight
// ---------------------------------------------------------------------------
if (!existsSync(wranglerBin)) {
  log("A instalar dependências (npm ci)…");
  const r = spawnSync(isWin ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: isWin });
  if (r.status !== 0) fail("npm ci falhou");
}

log("A verificar a autenticação no Cloudflare…");
if (API_TOKEN) {
  const ver = await cfApi("/user/tokens/verify");
  if (!ver.ok || ver.result?.status !== "active") {
    const errDesc = ver.errors.map((e) => `${e.code} ${e.message}`).join("; ") || (ver.http ? `HTTP ${ver.http}` : "token inválido");
    fail(
      `O CLOUDFLARE_API_TOKEN fornecido é inválido ou expirou (${errDesc}).\n` +
        "   Verifique o token em https://dash.cloudflare.com/profile/api-tokens.",
    );
  }
}

const who = wrangler(["whoami"], { capture: true, quiet: true });
if (who.status !== 0 || /not authenticated/i.test(who.out)) {
  process.stdout.write(who.out);
  fail(
    "Sem acesso ao Cloudflare. Faça uma de duas coisas:\n" +
      "   a) exporte CLOUDFLARE_API_TOKEN (token criado em dash.cloudflare.com → My Profile → API Tokens →\n" +
      "      modelo «Edit Cloudflare Workers» + permissão «Account · D1 · Edit»); com várias contas, também CLOUDFLARE_ACCOUNT_ID\n" +
      "   b) ou corra `npx wrangler login` e repita.",
  );
}
process.stdout.write(who.out.split("\n").filter((l) => /logged in|│/.test(l)).join("\n") + "\n");

// account id: env, or the single account visible to this login
const accountIds = [...new Set((who.out.match(/\b[0-9a-f]{32}\b/g) || []))];
let accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
if (!accountId && accountIds.length === 1) accountId = accountIds[0];
if (!accountId && accountIds.length > 1) {
  fail(`Este login tem acesso a ${accountIds.length} contas Cloudflare. Defina CLOUDFLARE_ACCOUNT_ID com a conta pretendida (ids: ${accountIds.join(", ")}).`);
}
if (accountId) process.env.CLOUDFLARE_ACCOUNT_ID = accountId; // makes every wrangler call below unambiguous
const loginEmail = (who.out.match(/associated with the email ([^\s.]+(?:\.[^\s.]+)*@[^\s]+?)\.?(?:\s|$)/) || [])[1] || "";

// Pre-flight check: D1 permissions on the account
if (API_TOKEN && accountId) {
  const d1Check = await cfApi(`/accounts/${accountId}/d1/database`);
  if (!d1Check.ok) {
    fail(
      "O CLOUDFLARE_API_TOKEN não tem permissão para aceder ao D1 nesta conta.\n" +
        "   Edite o token em https://dash.cloudflare.com/profile/api-tokens e adicione a permissão «Account · D1 · Edit».",
    );
  }
  console.log("   token verificado: ativo e com permissão D1");
}

// ---------------------------------------------------------------------------
// 1. D1 database
// ---------------------------------------------------------------------------
function listDatabases() {
  const r = wrangler(["d1", "list", "--json"], { capture: true, quiet: true });
  if (r.status !== 0) {
    process.stdout.write(r.out);
    fail("Não consegui listar as bases de dados D1 (o token tem a permissão «D1: Edit»? tem CLOUDFLARE_ACCOUNT_ID definido?)");
  }
  return extractJsonArray(r.out);
}

let db = listDatabases().find((d) => d.name === DB_NAME);
if (db) {
  log(`Base de dados D1 "${DB_NAME}" já existe (${db.uuid})`);
} else {
  log(`A criar a base de dados D1 "${DB_NAME}" (Europa Ocidental)…`);
  const r = wrangler(["d1", "create", DB_NAME, "--location", "weur"]);
  if (r.status !== 0) fail("Falha ao criar a base de dados D1");
  for (let i = 0; i < 5 && !db; i++) {
    db = listDatabases().find((d) => d.name === DB_NAME);
    if (!db) await sleep(3000);
  }
  if (!db) fail("A base de dados foi criada mas ainda não aparece na listagem — repita o comando dentro de instantes");
}

// ---------------------------------------------------------------------------
// 2. wrangler.jsonc
// ---------------------------------------------------------------------------
const cfgPath = path.join(root, "wrangler.jsonc");
const cfg = readFileSync(cfgPath, "utf8");
if (!/"database_id"\s*:/.test(cfg)) fail("wrangler.jsonc não tem database_id");
const patched = cfg.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${db.uuid}$2`);
if (patched !== cfg) {
  writeFileSync(cfgPath, patched);
  log("wrangler.jsonc atualizado com o database_id");
}

// ---------------------------------------------------------------------------
// 3. migrations
// ---------------------------------------------------------------------------
log("A aplicar migrações na base de dados remota…");
{
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    ok = wrangler(["d1", "migrations", "apply", "DB", "--remote"]).status === 0;
    if (!ok && attempt < 3) {
      console.log("   (a base de dados pode ainda estar a ser criada — nova tentativa em 5 s)");
      await sleep(5000);
    }
  }
  if (!ok) fail("Falha ao aplicar migrações");
}

// ---------------------------------------------------------------------------
// 4. workers.dev subdomain (new accounts have none -> non-interactive deploy would fail) + deploy
// ---------------------------------------------------------------------------
let subdomain = "";
if (API_TOKEN && accountId) {
  const cur = await cfApi(`/accounts/${accountId}/workers/subdomain`);
  if (cur.ok && cur.result && cur.result.subdomain) {
    subdomain = cur.result.subdomain;
  } else {
    log("A conta ainda não tem subdomínio workers.dev — a registar um…");
    const candidates = [
      slug(process.env.WORKERS_SUBDOMAIN),
      slug(loginEmail.split("@")[0]),
      WORKER_NAME,
      `${WORKER_NAME}-${randomBytes(2).toString("hex")}`,
    ].filter((c, i, a) => c && c.length >= 3 && a.indexOf(c) === i);
    for (const name of candidates) {
      const r = await cfApi(`/accounts/${accountId}/workers/subdomain`, { method: "PUT", body: JSON.stringify({ subdomain: name }) });
      if (r.ok) {
        subdomain = r.result?.subdomain || name;
        console.log(`   registado: https://${subdomain}.workers.dev`);
        break;
      }
      if (r.errors.some((e) => e.code === 10031)) {
        console.log(`   "${name}" não está disponível, a tentar outro…`);
        continue;
      }
      console.log(`   não consegui registar "${name}": ${r.errors.map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${r.http}`}`);
      break;
    }
    if (!subdomain) console.log("   (continuo sem subdomínio; se o deploy falhar, registe-o no dashboard — link abaixo — e repita)");
  }
}

log("A publicar o Worker…");
const dep = wrangler(["deploy"], { capture: true });
if (dep.status !== 0) {
  if (/workers\.dev subdomain/i.test(dep.out)) {
    fail(
      "O deploy precisa de um subdomínio workers.dev na conta. Registe-o (um clique) em\n" +
        `   https://dash.cloudflare.com/${accountId || ""}/workers/onboarding   e repita \`npm run setup\`.\n` +
        "   (Com CLOUDFLARE_API_TOKEN definido o instalador regista-o automaticamente.)",
    );
  }
  fail("Falha no deploy");
}
// WORKER_URL lets you point the final checks at a custom domain (when the workers.dev subdomain is disabled)
const url =
  (process.env.WORKER_URL || "").replace(/\/$/, "") ||
  (dep.out.match(/https:\/\/[\w.-]+\.workers\.dev/) || [])[0] ||
  (subdomain ? `https://${WORKER_NAME}.${subdomain}.workers.dev` : "");

// ---------------------------------------------------------------------------
// 5. secrets
// ---------------------------------------------------------------------------
log("A configurar secrets…");
let existing = [];
{
  const r = wrangler(["secret", "list", "--format", "json"], { capture: true, quiet: true });
  if (r.status === 0) {
    try {
      existing = extractJsonArray(r.out).map((s) => s.name);
    } catch {
      existing = [];
    }
  }
}
const toSet = {};
let adminPassword = (process.env.ADMIN_PASSWORD || "").trim();
if (adminPassword) {
  if (adminPassword.length < 6) fail("ADMIN_PASSWORD tem de ter pelo menos 6 caracteres");
  toSet.ADMIN_PASSWORD = adminPassword;
} else if (!existing.includes("ADMIN_PASSWORD")) {
  if (CI) fail("Falta o secret ADMIN_PASSWORD (password do painel /admin, mín. 6 caracteres)");
  do {
    adminPassword = await promptHidden("Password para o painel /admin (mín. 6 caracteres): ");
  } while (adminPassword.length < 6);
  toSet.ADMIN_PASSWORD = adminPassword;
}
const sessionSecret = (process.env.SESSION_SECRET || "").trim();
if (sessionSecret) toSet.SESSION_SECRET = sessionSecret;
else if (!existing.includes("SESSION_SECRET")) toSet.SESSION_SECRET = randomBytes(32).toString("base64url");

if (Object.keys(toSet).length) {
  // passed through stdin: never on the command line, never written to disk
  if (wrangler(["secret", "bulk"], { input: JSON.stringify(toSet) }).status !== 0) fail("Falha ao definir os secrets");
  console.log(`   definidos: ${Object.keys(toSet).join(", ")}`);
} else {
  console.log("   já estavam todos definidos (nada alterado)");
}

// ---------------------------------------------------------------------------
// 6. SIBA connectivity self-test (fictitious SEF test unit -> development environment)
// ---------------------------------------------------------------------------
let selfTest = "não executado";
if (SKIP_SELFTEST) selfTest = "saltado (--skip-selftest)";
else if (url && adminPassword) {
  log("Teste de ligação ao SIBA (ambiente de desenvolvimento, boletim fictício)…");
  try {
    let cookie = "";
    for (let attempt = 0; attempt < 10 && !cookie; attempt++) {
      const res = await fetch(`${url}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url },
        body: JSON.stringify({ password: adminPassword }),
      });
      if (res.ok) cookie = (res.headers.get("set-cookie") || "").split(";")[0];
      else if (res.status === 503 || res.status === 401 || res.status === 404) await sleep(4000); // new version still propagating
      else throw new Error(`login HTTP ${res.status}`);
    }
    if (!cookie) throw new Error("login não ficou disponível a tempo — repita `npm run setup` daqui a um minuto");
    const st = await fetch(`${url}/api/admin/siba-selftest`, { method: "POST", headers: { Cookie: cookie, Origin: url } });
    const j = await st.json();
    selfTest = j.ok
      ? `✔ o SIBA aceitou o boletim de teste (retorno 0) — ${j.endpoint} · ${j.duration_ms} ms`
      : `✘ ${j.code} — ${j.message} (${j.endpoint} · HTTP ${j.http_status || "—"})`;
  } catch (e) {
    selfTest = `não concluído: ${e.message}`;
  }
  console.log(`   ${selfTest}`);
} else if (url) {
  selfTest = "saltado — corra com ADMIN_PASSWORD definido, ou use o botão em /admin → Ajuda";
}

// ---------------------------------------------------------------------------
console.log("\n" + "═".repeat(72));
console.log("✔ Instalação concluída");
if (url) {
  console.log(`   Painel de administração:  ${url}/admin`);
  console.log(`   Link para hóspedes:       ${url}/r/<slug>   (o slug define-se ao registar a unidade)`);
} else {
  console.log("   O Worker foi publicado mas ainda não tem endereço workers.dev.");
  console.log(`   Ative-o em https://dash.cloudflare.com/${accountId || ""}/workers/onboarding e repita \`npm run setup\`.`);
}
console.log(`   Teste SIBA:               ${selfTest}`);
console.log("\nPróximos passos: /admin → «Unidade Hoteleira» → registar os dados do ofício da AIMA/SEF");
console.log("(NIPC, n.º de estabelecimento, chave de ativação…) → «Ajuda» → «Testar ligação ao SIBA».");
if (patched !== cfg) console.log("\nNota: wrangler.jsonc foi alterado (database_id) — faça commit dessa alteração.");
console.log("═".repeat(72));

// GitHub Actions: also in the job summary
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [
    "## ✔ SIBA check-in publicado no Cloudflare",
    "",
    url ? `- **Painel de administração:** ${url}/admin` : `- Worker publicado sem endereço workers.dev — ative-o em https://dash.cloudflare.com/${accountId || ""}/workers/onboarding e volte a correr o workflow`,
    url ? `- **Link para hóspedes:** ${url}/r/<slug> (o slug define-se ao registar a unidade)` : "",
    `- Base de dados D1: \`${DB_NAME}\` (\`${db.uuid}\`) — opcional: guardar este id em \`siba-checkin/wrangler.jsonc\``,
    `- Teste de ligação ao SIBA: ${selfTest}`,
    "",
    "Próximo passo: abrir o painel → «Unidade Hoteleira» → registar os dados do ofício da AIMA/SEF.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n", { flag: "a" });
}
