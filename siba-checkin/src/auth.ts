// Minimal, dependency-free admin authentication for Cloudflare Workers.
// A single administrator password (secret ADMIN_PASSWORD) unlocks a signed,
// HttpOnly session cookie (HMAC-SHA256 with SESSION_SECRET).

const COOKIE = "siba_admin";
const SESSION_TTL_S = 12 * 60 * 60; // 12 hours

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(sig);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export interface AuthEnv {
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
}

/** Session secret: SESSION_SECRET, or (fallback) a hash derived from the admin password. */
async function sessionSecret(env: AuthEnv): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const digest = await crypto.subtle.digest("SHA-256", enc.encode("siba-checkin::" + (env.ADMIN_PASSWORD ?? "")));
  return b64url(digest);
}

export function adminConfigured(env: AuthEnv): boolean {
  return typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= 6;
}

export function checkPassword(env: AuthEnv, password: string): boolean {
  if (!adminConfigured(env)) return false;
  return timingSafeEqual(env.ADMIN_PASSWORD as string, password ?? "");
}

export async function createSessionCookie(env: AuthEnv, secure: boolean): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const payload = `${exp}.${nonce}`;
  const sig = await sign(await sessionSecret(env), payload);
  const value = `${payload}.${sig}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_S}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

export async function isAuthenticated(req: Request, env: AuthEnv): Promise<boolean> {
  if (!adminConfigured(env)) return false;
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await sign(await sessionSecret(env), `${expStr}.${nonce}`);
  return timingSafeEqual(expected, sig);
}

/** Random, URL-safe code for guest links (e.g. 20 chars from a 32-symbol alphabet ≈ 100 bits). */
export function randomCode(length = 20): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no ambiguous chars (0/o, 1/l/i)
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
