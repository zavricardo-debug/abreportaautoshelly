// Business logic shared by the guest form, the admin panel and the scheduled job.
import {
  approveReservation,
  getProperty,
  guestToBulletin,
  insertSubmission,
  listGuests,
  markGuestsSent,
  nextFileNumber,
  nowIso,
  setReservationStatus,
  type GuestRow,
  type PropertyRow,
  type ReservationRow,
} from "./db";
import { PORTUGAL } from "./countries";
import {
  SIBA_ENDPOINTS,
  SIBA_TEST_UNIT,
  selfTestBulletin,
  sendToSiba,
  todayIso,
  validateGuest,
  validateProperty,
  type FieldError,
} from "./siba";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_NAME?: string;
  SIBA_ENV?: string;
  SIBA_ENDPOINT?: string;
  AUTO_SEND?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

export function sibaEndpoint(env: Env): string {
  if (env.SIBA_ENDPOINT) return env.SIBA_ENDPOINT;
  return env.SIBA_ENV === "development" ? SIBA_ENDPOINTS.development : SIBA_ENDPOINTS.production;
}

/** Endpoint used by the connectivity self-test: never production (an explicit SIBA_ENDPOINT override wins). */
export function sibaSelfTestEndpoint(env: Env): string {
  return env.SIBA_ENDPOINT || SIBA_ENDPOINTS.development;
}

export interface SelfTestResult {
  ok: boolean;
  code: string;
  message: string;
  endpoint: string;
  http_status: number;
  duration_ms: number;
  file_number: number;
  request_xml: string;
  response_raw: string;
}

/**
 * Sends one fictitious bulletin for SEF's fictitious test unit to the SIBA *development* environment.
 * Proves that the Worker can reach SIBA (DNS/TLS), that the SOAP call is accepted and that the XML
 * passes SIBA's validation. Uses neither the real activation key nor any real guest, and nothing is
 * stored in the database.
 */
export async function runSelfTest(env: Env): Promise<SelfTestResult> {
  const endpoint = sibaSelfTestEndpoint(env);
  const fileNumber = (Math.floor(Date.now() / 1000) % 99998) + 1; // shared test unit: any 1..99999 will do
  const started = Date.now();
  const outcome = await sendToSiba(endpoint, SIBA_TEST_UNIT, [selfTestBulletin()], fileNumber);
  return {
    ok: outcome.ok,
    code: outcome.code,
    message: outcome.message,
    endpoint,
    http_status: outcome.httpStatus,
    duration_ms: Date.now() - started,
    file_number: fileNumber,
    request_xml: outcome.requestXml,
    response_raw: outcome.responseRaw.slice(0, 4000),
  };
}

export function autoSendEnabled(env: Env): boolean {
  return (env.AUTO_SEND ?? "true").toLowerCase() !== "false";
}

export interface GuestCheck {
  guest_id: number;
  errors: FieldError[];
  /** Portuguese nationals are not reported to SIBA (only registered locally). */
  skip_siba: boolean;
}

/** Validates every guest of a reservation; returns per-guest errors. */
export function checkReservation(reservation: ReservationRow, guests: GuestRow[], today = todayIso()): GuestCheck[] {
  return guests.map((g) => ({
    guest_id: g.id,
    skip_siba: g.nacionalidade === PORTUGAL,
    errors: validateGuest(guestToBulletin(g, reservation), today),
  }));
}

export interface SendResult {
  ok: boolean;
  status: ReservationRow["status"];
  message: string;
  code?: string;
  sent_guest_ids: number[];
  skipped_guest_ids: number[];
  errors?: Array<{ guest_id: number; errors: FieldError[] }>;
  property_errors?: FieldError[];
  deferred?: boolean; // check-in date in the future -> will be sent by the cron
}

/**
 * Sends all pending (not yet accepted) bulletins of a reservation to SIBA.
 *  - validates the establishment and each guest first
 *  - skips Portuguese nationals (not reported to SIBA)
 *  - if the check-in date is still in the future, keeps the reservation as "submitted" (cron sends it later)
 *  - records the full request/response in siba_submissions
 */
export async function sendReservation(
  env: Env,
  reservation: ReservationRow,
  triggeredBy: "guest" | "admin" | "cron",
  opts: { force?: boolean } = {},
): Promise<SendResult> {
  const db = env.DB;
  const property = await getProperty(db, reservation.property_id);
  if (!property) return { ok: false, status: reservation.status, message: "Property not found", sent_guest_ids: [], skipped_guest_ids: [] };

  const propErrors = validateProperty(property);
  if (propErrors.length) {
    const msg = "Establishment data incomplete: " + propErrors.map((e) => e.message).join("; ");
    await setReservationStatus(db, reservation.id, "error", { last_error: msg });
    return { ok: false, status: "error", message: msg, property_errors: propErrors, sent_guest_ids: [], skipped_guest_ids: [] };
  }

  const guests = await listGuests(db, reservation.id);
  if (!guests.length) {
    return { ok: false, status: reservation.status, message: "Add at least one guest before sending", sent_guest_ids: [], skipped_guest_ids: [] };
  }
  // Whoever reached this point (guest with AUTO_SEND on, admin, cron) authorised the transmission.
  await approveReservation(db, reservation.id);

  const today = todayIso();
  const checks = checkReservation(reservation, guests, today);
  const skipped = checks.filter((c) => c.skip_siba).map((c) => c.guest_id);
  const pendingGuests = guests.filter((g) => g.nacionalidade !== PORTUGAL && (opts.force || g.siba_status !== "sent"));

  // Validation errors (ignore the "check-in in the future" error here; handled as deferral below)
  const hardErrors = checks
    .filter((c) => !c.skip_siba && pendingGuests.some((g) => g.id === c.guest_id))
    .map((c) => ({ guest_id: c.guest_id, errors: c.errors.filter((e) => !(e.field === "data_entrada" && reservation.check_in > today)) }))
    .filter((c) => c.errors.length);
  if (hardErrors.length) {
    const msg = "Some guest details are missing or invalid";
    await setReservationStatus(db, reservation.id, reservation.status === "draft" ? "draft" : "error", { last_error: msg });
    return { ok: false, status: reservation.status === "draft" ? "draft" : "error", message: msg, errors: hardErrors, sent_guest_ids: [], skipped_guest_ids: skipped };
  }

  if (!pendingGuests.length) {
    // Nothing to send: either everything was already accepted or all guests are Portuguese.
    const allSent = guests.every((g) => g.siba_status === "sent" || g.nacionalidade === PORTUGAL);
    const status: ReservationRow["status"] = allSent ? "sent" : reservation.status;
    if (allSent && reservation.status !== "sent") {
      await setReservationStatus(db, reservation.id, "sent", { sent_at: reservation.sent_at ?? nowIso(), last_error: "" });
    }
    const msg = skipped.length === guests.length
      ? "Only Portuguese nationals: registered locally, nothing to report to SIBA"
      : "All bulletins were already accepted by SIBA";
    return { ok: true, status, message: msg, sent_guest_ids: [], skipped_guest_ids: skipped };
  }

  if (reservation.check_in > today) {
    // SIBA rejects Data_Entrada in the future. Keep it queued; cron will send it on the check-in day.
    await setReservationStatus(db, reservation.id, "submitted", {
      submitted_at: reservation.submitted_at ?? nowIso(),
      last_error: "",
    });
    return {
      ok: true,
      status: "submitted",
      deferred: true,
      message: `Saved. It will be sent to SIBA automatically on the check-in date (${reservation.check_in}).`,
      sent_guest_ids: [],
      skipped_guest_ids: skipped,
    };
  }

  const fileNumber = await nextFileNumber(db, property.id);
  const bulletins = pendingGuests.map((g) => guestToBulletin(g, reservation));
  const outcome = await sendToSiba(sibaEndpoint(env), propertyForSiba(property), bulletins, fileNumber);

  await insertSubmission(db, {
    reservation_id: reservation.id,
    property_id: property.id,
    file_number: fileNumber,
    guest_ids: JSON.stringify(pendingGuests.map((g) => g.id)),
    endpoint: outcome.endpoint,
    request_xml: outcome.requestXml,
    http_status: outcome.httpStatus || null,
    response_raw: outcome.responseRaw,
    result_code: outcome.code,
    result_message: outcome.message,
    ok: outcome.ok ? 1 : 0,
    triggered_by: triggeredBy,
  });

  if (outcome.ok) {
    await markGuestsSent(db, pendingGuests.map((g) => g.id), "sent");
    await setReservationStatus(db, reservation.id, "sent", {
      submitted_at: reservation.submitted_at ?? nowIso(),
      sent_at: nowIso(),
      last_error: "",
    });
    return {
      ok: true,
      status: "sent",
      message: `Accepted by SIBA (file #${fileNumber}). A confirmation e-mail is sent by SIBA to ${property.email_contacto}.`,
      code: "0",
      sent_guest_ids: pendingGuests.map((g) => g.id),
      skipped_guest_ids: skipped,
    };
  }

  await markGuestsSent(db, pendingGuests.map((g) => g.id), "error");
  const msg = `SIBA error ${outcome.code}: ${outcome.message}`;
  await setReservationStatus(db, reservation.id, "error", {
    submitted_at: reservation.submitted_at ?? nowIso(),
    last_error: msg,
  });
  return { ok: false, status: "error", message: msg, code: outcome.code, sent_guest_ids: [], skipped_guest_ids: skipped };
}

function propertyForSiba(p: PropertyRow) {
  return {
    codigo_unidade: p.codigo_unidade,
    estabelecimento: p.estabelecimento,
    nome: p.nome,
    abreviatura: p.abreviatura,
    morada: p.morada,
    localidade: p.localidade,
    codigo_postal: p.codigo_postal,
    zona_postal: p.zona_postal,
    telefone: p.telefone,
    fax: p.fax,
    nome_contacto: p.nome_contacto,
    email_contacto: p.email_contacto,
    chave_activacao: p.chave_activacao,
  };
}

/**
 * Scheduled job: send approved reservations whose check-in day has arrived and retry transient errors.
 * Reservations submitted by guests while AUTO_SEND=false are not approved and therefore wait for the admin.
 */
export async function runScheduled(env: Env): Promise<{ processed: number; sent: number; failed: number }> {
  const today = todayIso();
  const rows = await env.DB
    .prepare(
      `SELECT * FROM reservations
        WHERE status IN ('submitted', 'error') AND approved = 1 AND check_in <= ?
        ORDER BY check_in ASC LIMIT 50`,
    )
    .bind(today)
    .all<ReservationRow>();
  let sent = 0;
  let failed = 0;
  for (const r of rows.results ?? []) {
    // Don't hammer SIBA with data-validation errors: only retry errors that look transient
    // or reservations that were never attempted.
    if (r.status === "error" && !/NETWORK|HTTP_5|SOAP_FAULT|Could not reach/i.test(r.last_error)) continue;
    const res = await sendReservation(env, r, "cron");
    if (res.ok && res.status === "sent") sent++;
    else if (!res.ok) failed++;
  }
  return { processed: rows.results?.length ?? 0, sent, failed };
}
