// Cloudflare Worker: HTTP API + static assets (public/) + cron.
//
// Public (guest) routes
//   GET  /r/:slug                         -> guest form (new reservation for a property)
//   GET  /r/:slug/:code                   -> guest form for an existing reservation (link sent by the host)
//   GET  /api/public/config               -> app name, countries, turnstile key
//   GET  /api/public/property/:slug       -> public info about a property
//   GET  /api/public/reservation/:code    -> reservation + guests (by secret code)
//   POST /api/public/reservation          -> create reservation (guest without a link)  {slug, ...}
//   PUT  /api/public/reservation/:code    -> update reservation dates/contact + guests (draft)
//   POST /api/public/reservation/:code/send -> guest presses "Send": validate, store, send to SIBA
//
// Admin routes (cookie session, password = secret ADMIN_PASSWORD)
//   POST /api/admin/login  {password}     POST /api/admin/logout     GET /api/admin/me
//   GET/POST /api/admin/properties        GET/PUT /api/admin/properties/:id
//   GET/POST /api/admin/reservations      GET/PUT/DELETE /api/admin/reservations/:id
//   POST /api/admin/reservations/:id/guests   PUT/DELETE /api/admin/guests/:id
//   POST /api/admin/reservations/:id/send     (force=true to resend already accepted)
//   GET  /api/admin/reservations/:id/submissions   GET /api/admin/submissions/:id
//   POST /api/admin/run-cron                  POST /api/admin/siba-selftest  (fictitious bulletin -> SIBA dev env)
import {
  adminConfigured,
  checkPassword,
  clearSessionCookie,
  createSessionCookie,
  isAuthenticated,
  randomCode,
} from "./auth";
import { COUNTRIES } from "./countries";
import {
  dashboardCounts,
  deleteGuest,
  deleteReservation,
  getGuest,
  getProperty,
  getPropertyBySlug,
  getReservation,
  getReservationByCode,
  getSubmission,
  insertGuest,
  insertProperty,
  insertReservation,
  listGuests,
  listProperties,
  listReservations,
  listSubmissions,
  normalizeGuestInput,
  normalizePropertyInput,
  normalizeReservationInput,
  publicProperty,
  updateGuest,
  updateProperty,
  updateReservation,
  validateReservationDates,
  setReservationStatus,
  nowIso,
  type PropertyRow,
  type ReservationRow,
} from "./db";
import { autoSendEnabled, checkReservation, runScheduled, runSelfTest, sendReservation, sibaEndpoint, sibaSelfTestEndpoint, type Env } from "./service";
import { todayIso, validateProperty } from "./siba";

const MAX_GUESTS = 12;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new HttpError(400, "Invalid JSON body");
}

function idParam(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Invalid id");
  return n;
}

function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

function sameOrigin(req: Request): boolean {
  // CSRF protection for state-changing requests: browsers send Origin (or at least Sec-Fetch-Site).
  const origin = req.headers.get("Origin");
  if (origin) return origin === new URL(req.url).origin;
  const site = req.headers.get("Sec-Fetch-Site");
  return !site || site === "same-origin" || site === "none";
}

async function verifyTurnstile(env: Env, token: unknown, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== "string" || !token) return false;
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip) body.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const data = (await res.json()) as { success?: boolean };
  return !!data.success;
}

function reservationView(r: ReservationRow, includeCode: boolean) {
  const { access_code, ...rest } = r;
  return includeCode ? r : rest;
}

async function loadReservationBundle(env: Env, r: ReservationRow, property: PropertyRow, includeCode: boolean) {
  const guests = await listGuests(env.DB, r.id);
  const checks = checkReservation(r, guests);
  return {
    reservation: reservationView(r, includeCode),
    property: publicProperty(property),
    guests,
    checks,
    today: todayIso(),
    auto_send: autoSendEnabled(env),
  };
}

/** Replaces the guest list of a reservation with the given array (create/update/delete as needed). */
async function syncGuests(env: Env, reservation: ReservationRow, guestsInput: unknown, allowDeletingSent: boolean) {
  if (!Array.isArray(guestsInput)) return;
  if (guestsInput.length > MAX_GUESTS) throw new HttpError(400, `Maximum ${MAX_GUESTS} guests per reservation`);
  const existing = await listGuests(env.DB, reservation.id);
  const keep = new Set<number>();
  for (const raw of guestsInput) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const data = normalizeGuestInput(item);
    const id = Number(item.id);
    const current = Number.isInteger(id) ? existing.find((g) => g.id === id) : undefined;
    if (current) {
      const changed = (Object.keys(data) as Array<keyof typeof data>).some((k) => current[k] !== data[k]);
      if (changed) await updateGuest(env.DB, current.id, data, current.siba_status === "sent" ? false : true);
      keep.add(current.id);
    } else {
      // ignore completely empty rows
      const empty = Object.values(data).every((v) => !v || v === "P");
      if (empty) continue;
      const g = await insertGuest(env.DB, reservation.id, data);
      keep.add(g.id);
    }
  }
  for (const g of existing) {
    if (keep.has(g.id)) continue;
    if (g.siba_status === "sent" && !allowDeletingSent) continue; // guests already reported cannot be removed by the guest
    await deleteGuest(env.DB, g.id);
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

async function handlePublic(req: Request, env: Env, path: string[]): Promise<Response> {
  const method = req.method;
  const [head, arg, action] = path; // after /api/public/

  if (head === "config" && method === "GET") {
    return json({
      app_name: env.APP_NAME ?? "Check-in",
      countries: COUNTRIES,
      turnstile_site_key: env.TURNSTILE_SITE_KEY ?? "",
      auto_send: autoSendEnabled(env),
      today: todayIso(),
    });
  }

  if (head === "property" && arg && method === "GET") {
    const p = await getPropertyBySlug(env.DB, arg);
    if (!p) throw new HttpError(404, "Property not found");
    return json({ property: publicProperty(p) });
  }

  if (head === "reservation" && !arg && method === "POST") {
    if (!sameOrigin(req)) throw new HttpError(403, "Forbidden");
    const body = await readJson(req);
    if (!(await verifyTurnstile(env, body.turnstile_token, req.headers.get("CF-Connecting-IP")))) throw new HttpError(400, "Anti-bot verification failed");
    const p = await getPropertyBySlug(env.DB, String(body.slug ?? ""));
    if (!p) throw new HttpError(404, "Property not found");
    const input = normalizeReservationInput(body);
    const dateErr = validateReservationDates(input.check_in, input.check_out);
    if (dateErr) throw new HttpError(400, dateErr);
    const r = await insertReservation(env.DB, p.id, randomCode(), input, "guest");
    await syncGuests(env, r, body.guests, false);
    return json(await loadReservationBundle(env, r, p, true), 201);
  }

  if (head === "reservation" && arg) {
    const r = await getReservationByCode(env.DB, arg);
    if (!r) throw new HttpError(404, "Reservation not found");
    const p = await getProperty(env.DB, r.property_id);
    if (!p) throw new HttpError(404, "Property not found");

    if (!action && method === "GET") return json(await loadReservationBundle(env, r, p, true));

    if (!action && method === "PUT") {
      if (!sameOrigin(req)) throw new HttpError(403, "Forbidden");
      if (r.status === "cancelled") throw new HttpError(409, "This reservation was cancelled");
      const body = await readJson(req);
      const input = normalizeReservationInput(body);
      // guests may correct dates only while nothing has been reported yet
      if (r.status === "sent" || r.status === "error") { delete input.check_in; delete input.check_out; }
      const dateErr = validateReservationDates(input.check_in ?? r.check_in, input.check_out === undefined ? r.check_out : input.check_out);
      if (dateErr) throw new HttpError(400, dateErr);
      const updated = Object.keys(input).length ? await updateReservation(env.DB, r.id, input) : r;
      await syncGuests(env, updated, body.guests, false);
      return json(await loadReservationBundle(env, updated, p, true));
    }

    if (action === "send" && method === "POST") {
      if (!sameOrigin(req)) throw new HttpError(403, "Forbidden");
      if (r.status === "cancelled") throw new HttpError(409, "This reservation was cancelled");
      const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
      if (!(await verifyTurnstile(env, body.turnstile_token, req.headers.get("CF-Connecting-IP")))) throw new HttpError(400, "Anti-bot verification failed");
      // Save any last edits sent together with the button press
      const input = normalizeReservationInput(body);
      if (r.status === "sent" || r.status === "error") { delete input.check_in; delete input.check_out; }
      let current = Object.keys(input).length ? await updateReservation(env.DB, r.id, input) : r;
      await syncGuests(env, current, body.guests, false);

      const guests = await listGuests(env.DB, current.id);
      if (!guests.length) throw new HttpError(400, "Add at least one guest");
      const checks = checkReservation(current, guests);
      const invalid = checks.filter((c) => c.errors.some((e) => !(e.field === "data_entrada" && current.check_in > todayIso())));
      if (invalid.length) {
        return json({ ok: false, message: "Please complete the highlighted fields", ...(await loadReservationBundle(env, current, p, true)) }, 422);
      }
      // Mark as submitted by the guest
      await setReservationStatus(env.DB, current.id, current.status === "sent" ? "sent" : "submitted", { submitted_at: current.submitted_at ?? nowIso() });
      current = (await getReservation(env.DB, current.id)) as ReservationRow;

      let result: Awaited<ReturnType<typeof sendReservation>> | null = null;
      if (autoSendEnabled(env)) {
        result = await sendReservation(env, current, "guest");
        current = (await getReservation(env.DB, current.id)) as ReservationRow;
      }
      const bundle = await loadReservationBundle(env, current, p, true);
      return json({
        ok: true,
        message: result
          ? result.ok
            ? result.message
            : "Your details were saved. The host will review and complete the submission."
          : "Your details were saved and will be sent by the host.",
        siba_ok: result?.ok ?? null,
        ...bundle,
      });
    }
  }

  throw new HttpError(404, "Not found");
}

// ---------------------------------------------------------------------------
// admin API
// ---------------------------------------------------------------------------

async function handleAdmin(req: Request, env: Env, path: string[]): Promise<Response> {
  const method = req.method;
  const [head, arg, action] = path; // after /api/admin/
  const secure = isSecure(req);

  if (head === "login" && method === "POST") {
    if (!sameOrigin(req)) throw new HttpError(403, "Forbidden");
    if (!adminConfigured(env)) throw new HttpError(503, "ADMIN_PASSWORD secret is not configured (min. 6 characters)");
    const body = await readJson(req);
    if (!checkPassword(env, String(body.password ?? ""))) {
      await new Promise((r) => setTimeout(r, 400)); // slow down brute force a little
      throw new HttpError(401, "Wrong password");
    }
    return json({ ok: true }, 200, { "Set-Cookie": await createSessionCookie(env, secure) });
  }
  if (head === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(secure) });
  }
  if (head === "me" && method === "GET") {
    return json({ authenticated: await isAuthenticated(req, env), configured: adminConfigured(env) });
  }

  if (!(await isAuthenticated(req, env))) throw new HttpError(401, "Authentication required");
  if (method !== "GET" && !sameOrigin(req)) throw new HttpError(403, "Forbidden");

  // ---- dashboard
  if (head === "dashboard" && method === "GET") {
    const [counts, properties] = await Promise.all([dashboardCounts(env.DB), listProperties(env.DB)]);
    return json({
      counts,
      properties: properties.map((p) => ({ ...p, chave_activacao: p.chave_activacao ? "••••" + p.chave_activacao.slice(-3) : "", errors: validateProperty(p) })),
      siba_endpoint: sibaEndpoint(env),
      siba_selftest_endpoint: sibaSelfTestEndpoint(env),
      auto_send: autoSendEnabled(env),
      today: todayIso(),
    });
  }

  // ---- properties
  if (head === "properties") {
    if (!arg && method === "GET") {
      const rows = await listProperties(env.DB);
      return json({ properties: rows.map((p) => ({ ...p, errors: validateProperty(p) })) });
    }
    if (!arg && method === "POST") {
      const body = await readJson(req);
      const data = normalizePropertyInput(body);
      const errors = validateProperty(data);
      if (errors.length) throw new HttpError(422, "Please fix the highlighted fields", { errors });
      if (await env.DB.prepare("SELECT 1 FROM properties WHERE slug = ?").bind(data.slug).first()) throw new HttpError(409, "Slug already in use", { errors: [{ field: "slug", message: "Already in use" }] });
      const p = await insertProperty(env.DB, data);
      return json({ property: p, errors: [] }, 201);
    }
    if (arg && method === "GET") {
      const p = await getProperty(env.DB, idParam(arg));
      if (!p) throw new HttpError(404, "Property not found");
      return json({ property: p, errors: validateProperty(p) });
    }
    if (arg && method === "PUT") {
      const id = idParam(arg);
      const existing = await getProperty(env.DB, id);
      if (!existing) throw new HttpError(404, "Property not found");
      const body = await readJson(req);
      if (typeof body.chave_activacao === "string" && /^•+/.test(body.chave_activacao)) delete body.chave_activacao; // masked value untouched
      const data = normalizePropertyInput(body, existing);
      const errors = validateProperty(data);
      if (errors.length) throw new HttpError(422, "Please fix the highlighted fields", { errors });
      const clash = await env.DB.prepare("SELECT id FROM properties WHERE slug = ? AND id <> ?").bind(data.slug, id).first();
      if (clash) throw new HttpError(409, "Slug already in use", { errors: [{ field: "slug", message: "Already in use" }] });
      const p = await updateProperty(env.DB, id, data);
      return json({ property: p, errors: [] });
    }
  }

  // ---- reservations
  if (head === "reservations") {
    if (!arg && method === "GET") {
      const u = new URL(req.url);
      const rows = await listReservations(env.DB, {
        propertyId: Number(u.searchParams.get("property_id")) || undefined,
        status: u.searchParams.get("status") || undefined,
        q: u.searchParams.get("q")?.trim() || undefined,
        limit: Number(u.searchParams.get("limit")) || 200,
        offset: Number(u.searchParams.get("offset")) || 0,
      });
      return json({ reservations: rows });
    }
    if (!arg && method === "POST") {
      const body = await readJson(req);
      const p = await getProperty(env.DB, Number(body.property_id));
      if (!p) throw new HttpError(400, "Choose a property");
      const input = normalizeReservationInput(body);
      const dateErr = validateReservationDates(input.check_in, input.check_out);
      if (dateErr) throw new HttpError(400, dateErr);
      const r = await insertReservation(env.DB, p.id, randomCode(), input, "admin");
      await syncGuests(env, r, body.guests, true);
      return json(await adminBundle(env, r, p), 201);
    }
    if (arg) {
      const id = idParam(arg);
      const r = await getReservation(env.DB, id);
      if (!r) throw new HttpError(404, "Reservation not found");
      const p = (await getProperty(env.DB, r.property_id)) as PropertyRow;

      if (!action && method === "GET") return json(await adminBundle(env, r, p));
      if (!action && method === "PUT") {
        const body = await readJson(req);
        const input = normalizeReservationInput(body);
        const dateErr = validateReservationDates(input.check_in ?? r.check_in, input.check_out === undefined ? r.check_out : input.check_out);
        if (dateErr) throw new HttpError(400, dateErr);
        let updated = Object.keys(input).length ? await updateReservation(env.DB, id, input) : r;
        if (typeof body.status === "string" && ["draft", "submitted", "cancelled"].includes(body.status) && body.status !== updated.status) {
          await setReservationStatus(env.DB, id, body.status as ReservationRow["status"], { last_error: "" });
          updated = (await getReservation(env.DB, id)) as ReservationRow;
        }
        await syncGuests(env, updated, body.guests, true);
        return json(await adminBundle(env, updated, p));
      }
      if (!action && method === "DELETE") {
        await deleteReservation(env.DB, id);
        return json({ ok: true });
      }
      if (action === "guests" && method === "POST") {
        const body = await readJson(req);
        const count = (await listGuests(env.DB, id)).length;
        if (count >= MAX_GUESTS) throw new HttpError(400, `Maximum ${MAX_GUESTS} guests per reservation`);
        const g = await insertGuest(env.DB, id, normalizeGuestInput(body));
        return json({ guest: g }, 201);
      }
      if (action === "send" && method === "POST") {
        const body = await readJson(req).catch(() => ({} as Record<string, unknown>));
        // Save edits sent with the button press, then send.
        const input = normalizeReservationInput(body);
        let current = Object.keys(input).length ? await updateReservation(env.DB, id, input) : r;
        await syncGuests(env, current, body.guests, true);
        current = (await getReservation(env.DB, id)) as ReservationRow;
        const result = await sendReservation(env, current, "admin", { force: body.force === true });
        const fresh = (await getReservation(env.DB, id)) as ReservationRow;
        return json({ result, ...(await adminBundle(env, fresh, p)) }, result.ok ? 200 : 422);
      }
      if (action === "submissions" && method === "GET") {
        return json({ submissions: await listSubmissions(env.DB, id) });
      }
    }
  }

  // ---- guests
  if (head === "guests" && arg) {
    const id = idParam(arg);
    const g = await getGuest(env.DB, id);
    if (!g) throw new HttpError(404, "Guest not found");
    if (method === "PUT") {
      const body = await readJson(req);
      const updated = await updateGuest(env.DB, id, normalizeGuestInput(body), g.siba_status !== "sent");
      return json({ guest: updated });
    }
    if (method === "DELETE") {
      await deleteGuest(env.DB, id);
      return json({ ok: true });
    }
  }

  // ---- submissions detail
  if (head === "submissions" && arg && method === "GET") {
    const s = await getSubmission(env.DB, idParam(arg));
    if (!s) throw new HttpError(404, "Submission not found");
    return json({ submission: s });
  }

  if (head === "run-cron" && method === "POST") {
    return json(await runScheduled(env));
  }
  if (head === "siba-selftest" && method === "POST") {
    return json(await runSelfTest(env));
  }

  throw new HttpError(404, "Not found");
}

async function adminBundle(env: Env, r: ReservationRow, p: PropertyRow) {
  const guests = await listGuests(env.DB, r.id);
  return {
    reservation: r,
    property: publicProperty(p),
    property_errors: validateProperty(p),
    guests,
    checks: checkReservation(r, guests),
    submissions: await listSubmissions(env.DB, r.id),
    today: todayIso(),
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurity(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    try {
      if (parts[0] === "api") {
        if (parts[1] === "public") return withSecurity(await handlePublic(req, env, parts.slice(2)));
        if (parts[1] === "admin") return withSecurity(await handleAdmin(req, env, parts.slice(2)));
        if (parts[1] === "health") return json({ ok: true, time: nowIso() });
        throw new HttpError(404, "Not found");
      }

      // Pretty guest links: /r/<slug> and /r/<slug>/<code> -> guest form page
      if (parts[0] === "r") {
        const page = await env.ASSETS.fetch(new Request(new URL("/checkin.html", url.origin), { headers: req.headers }));
        return withSecurity(page);
      }
      // /admin -> admin panel page
      if (parts[0] === "admin") {
        const page = await env.ASSETS.fetch(new Request(new URL("/admin.html", url.origin), { headers: req.headers }));
        return withSecurity(new Response(page.body, { ...page, headers: { ...Object.fromEntries(page.headers), "X-Robots-Tag": "noindex" } }));
      }

      // everything else: static assets (index.html etc.)
      const asset = await env.ASSETS.fetch(req);
      if (asset.status !== 404) return withSecurity(asset);
      return withSecurity(new Response("Not found", { status: 404 }));
    } catch (err) {
      if (err instanceof HttpError) return withSecurity(json({ ok: false, error: err.message, ...(err.extra ?? {}) }, err.status));
      console.error("Unhandled error", err);
      const message = err instanceof Error ? err.message : "Internal error";
      return withSecurity(json({ ok: false, error: message }, 500));
    } finally {
      void ctx;
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runScheduled(env).then((r) => console.log(`[cron] processed=${r.processed} sent=${r.sent} failed=${r.failed}`)),
    );
  },
} satisfies ExportedHandler<Env>;
