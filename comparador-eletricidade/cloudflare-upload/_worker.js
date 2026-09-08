// Cloudflare Pages "advanced mode" worker (https://developers.cloudflare.com/pages/functions/advanced-mode/).
// Copied to the root of the upload bundle by scripts/build-dist.mjs. It takes over every request of the site:
//
//   /api/cnmc/<path>?<query>   -> proxied to https://comparador.cnmc.gob.es/api/publico/<path>?<query>
//   anything else              -> the static assets (env.ASSETS)
//
// Why a proxy: the browser-side "Mercado completo (CNMC en vivo)" mode queries the official comparator's JSON
// API, which rejects requests carrying a browser Origin header (no CORS). The worker forwards the GET without
// Origin/Referer, with a normal browser User-Agent, and adds CORS + caching. Only two read-only endpoints are
// allowed; the query string is restricted to the comparator's own numeric/boolean parameters.
const UPSTREAM = 'https://comparador.cnmc.gob.es/api/publico/';
const ALLOWED = new Set(['ofertas/electricidad', 'oferta']);
const CACHE_TTL = 6 * 3600;          // the CNMC list changes at most a few times a week
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/cnmc/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    const path = url.pathname.slice('/api/cnmc/'.length).replace(/\/+$/, '');
    if (!ALLOWED.has(path)) return json({ error: 'endpoint not allowed', path }, 404);
    // whitelist the parameters: names [A-Za-z]+, values numeric / boolean / short tokens
    const q = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (!/^[A-Za-z]{1,40}$/.test(k) || !/^[A-Za-z0-9.\-]{0,20}$/.test(v)) return json({ error: 'bad parameter', k }, 400);
      q.append(k, v);
    }
    const target = `${UPSTREAM}${path}?${q.toString()}`;
    const cacheKey = new Request(target, { method: 'GET' });
    const cache = caches.default;
    let res = await cache.match(cacheKey);
    if (res) {
      const h = new Headers(res.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v); h.set('X-Cache', 'HIT');
      return new Response(res.body, { status: res.status, headers: h });
    }
    let upstream;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort('timeout'), 70000);
    try {
      upstream = await fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'es-ES,es;q=0.9', 'User-Agent': UA },
        cf: { cacheTtl: 0 },
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return json({ error: `upstream unreachable: ${e?.message || e}` }, 502);
    }
    clearTimeout(timer);
    const body = await upstream.arrayBuffer();
    const ct = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    if (!upstream.ok || !/json/i.test(ct)) {
      return json({ error: `CNMC answered ${upstream.status}`, status: upstream.status, body: new TextDecoder().decode(body).slice(0, 300) }, upstream.status === 500 ? 502 : upstream.status);
    }
    res = new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL}`, 'X-Cache': 'MISS', ...CORS } });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
