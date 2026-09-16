// Data-access layer for Cloudflare D1.
import type { GuestBulletin, PropertyInfo } from "./siba";
import {
  cleanText,
  digits,
  isIsoDate,
  normalizeDocNumber,
  normalizeDocType,
  normalizeName,
  normalizeText,
} from "./siba";

export interface PropertyRow extends PropertyInfo {
  id: number;
  slug: string;
  fax: string;
  next_file_number: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface ReservationRow {
  id: number;
  property_id: number;
  access_code: string;
  reference: string;
  guest_email: string;
  guest_phone: string;
  check_in: string;
  check_out: string | null;
  notes: string;
  status: "draft" | "submitted" | "sent" | "error" | "cancelled";
  approved: number;
  submitted_at: string | null;
  sent_at: string | null;
  last_error: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GuestRow {
  id: number;
  reservation_id: number;
  apelido: string;
  nome: string;
  nacionalidade: string;
  data_nascimento: string;
  local_nascimento: string;
  documento_identificacao: string;
  tipo_documento: string;
  pais_emissor_documento: string;
  pais_residencia_origem: string;
  local_residencia_origem: string;
  siba_status: "pending" | "sent" | "error";
  siba_sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmissionRow {
  id: number;
  reservation_id: number;
  property_id: number;
  file_number: number;
  guest_ids: string;
  endpoint: string;
  request_xml: string;
  http_status: number | null;
  response_raw: string;
  result_code: string;
  result_message: string;
  ok: number;
  triggered_by: string;
  created_at: string;
}

export const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** Phone numbers: digits only; a Portuguese country prefix (+351 / 00351) is removed; max 10 digits. */
export function phoneDigits(v: unknown): string {
  let d = digits(v);
  if (d.startsWith("00351") && d.length > 9) d = d.slice(5);
  else if (d.startsWith("351") && d.length > 9) d = d.slice(3);
  return d.slice(0, 10);
}

/** Normalises admin input for a property into SIBA-compatible values. */
export function normalizePropertyInput(input: Record<string, unknown>, existing?: PropertyRow) {
  const get = (k: string) => (input[k] !== undefined ? input[k] : existing?.[k as keyof PropertyRow]);
  const postal = cleanText(get("codigo_postal"));
  // accept "1000-234" typed into the postal code field
  let codigo_postal = digits(get("codigo_postal"), 4);
  let zona_postal = digits(get("zona_postal"), 3);
  const m = postal.match(/^(\d{4})\s*-\s*(\d{3})$/);
  if (m) {
    codigo_postal = m[1];
    if (!zona_postal) zona_postal = m[2];
  }
  const slugSource = cleanText(get("slug")) || cleanText(get("abreviatura")) || cleanText(get("nome"));
  const slug = slugSource
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "unit";
  const est = digits(get("estabelecimento"), 4);
  return {
    slug,
    codigo_unidade: digits(get("codigo_unidade"), 9),
    estabelecimento: est ? est.padStart(2, "0") : "00",
    nome: normalizeText(get("nome"), 40, false),
    abreviatura: normalizeText(get("abreviatura"), 15, false),
    morada: normalizeText(get("morada"), 40, false),
    localidade: normalizeText(get("localidade"), 30, false),
    codigo_postal,
    zona_postal,
    telefone: phoneDigits(get("telefone")),
    fax: phoneDigits(get("fax")),
    nome_contacto: normalizeText(get("nome_contacto"), 40, false),
    email_contacto: cleanText(get("email_contacto")).slice(0, 140),
    chave_activacao: cleanText(get("chave_activacao")),
    active: get("active") === undefined ? 1 : get("active") ? 1 : 0,
  };
}

export async function listProperties(db: D1Database): Promise<PropertyRow[]> {
  const r = await db.prepare("SELECT * FROM properties ORDER BY id").all<PropertyRow>();
  return r.results ?? [];
}

export async function getProperty(db: D1Database, id: number): Promise<PropertyRow | null> {
  return db.prepare("SELECT * FROM properties WHERE id = ?").bind(id).first<PropertyRow>();
}

export async function getPropertyBySlug(db: D1Database, slug: string): Promise<PropertyRow | null> {
  return db.prepare("SELECT * FROM properties WHERE slug = ? AND active = 1").bind(slug).first<PropertyRow>();
}

export async function insertProperty(db: D1Database, p: ReturnType<typeof normalizePropertyInput>): Promise<PropertyRow> {
  const r = await db
    .prepare(
      `INSERT INTO properties (slug, codigo_unidade, estabelecimento, nome, abreviatura, morada, localidade,
         codigo_postal, zona_postal, telefone, fax, nome_contacto, email_contacto, chave_activacao, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      p.slug, p.codigo_unidade, p.estabelecimento, p.nome, p.abreviatura, p.morada, p.localidade,
      p.codigo_postal, p.zona_postal, p.telefone, p.fax, p.nome_contacto, p.email_contacto, p.chave_activacao, p.active,
    )
    .first<PropertyRow>();
  if (!r) throw new Error("insert failed");
  return r;
}

export async function updateProperty(db: D1Database, id: number, p: ReturnType<typeof normalizePropertyInput>): Promise<PropertyRow> {
  const r = await db
    .prepare(
      `UPDATE properties SET slug=?, codigo_unidade=?, estabelecimento=?, nome=?, abreviatura=?, morada=?, localidade=?,
         codigo_postal=?, zona_postal=?, telefone=?, fax=?, nome_contacto=?, email_contacto=?, chave_activacao=?, active=?,
         updated_at=? WHERE id=? RETURNING *`,
    )
    .bind(
      p.slug, p.codigo_unidade, p.estabelecimento, p.nome, p.abreviatura, p.morada, p.localidade,
      p.codigo_postal, p.zona_postal, p.telefone, p.fax, p.nome_contacto, p.email_contacto, p.chave_activacao, p.active,
      nowIso(), id,
    )
    .first<PropertyRow>();
  if (!r) throw new Error("property not found");
  return r;
}

/** Atomically reserves the next Numero_Ficheiro (1..99999, wraps). */
export async function nextFileNumber(db: D1Database, propertyId: number): Promise<number> {
  const r = await db
    .prepare(
      `UPDATE properties
         SET next_file_number = CASE WHEN next_file_number >= 99999 THEN 1 ELSE next_file_number + 1 END
       WHERE id = ? RETURNING next_file_number`,
    )
    .bind(propertyId)
    .first<{ next_file_number: number }>();
  if (!r) throw new Error("property not found");
  // value returned is the *next* one; the one reserved is the previous
  return r.next_file_number === 1 ? 99999 : r.next_file_number - 1;
}

/** Public-safe subset of a property (no key, no internal counters). */
export function publicProperty(p: PropertyRow) {
  return { id: p.id, slug: p.slug, nome: p.nome, morada: p.morada, localidade: p.localidade, email_contacto: p.email_contacto, telefone: p.telefone };
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

export async function getReservation(db: D1Database, id: number): Promise<ReservationRow | null> {
  return db.prepare("SELECT * FROM reservations WHERE id = ?").bind(id).first<ReservationRow>();
}

export async function getReservationByCode(db: D1Database, code: string): Promise<ReservationRow | null> {
  return db.prepare("SELECT * FROM reservations WHERE access_code = ?").bind(code).first<ReservationRow>();
}

export async function listReservations(
  db: D1Database,
  opts: { propertyId?: number; status?: string; q?: string; limit?: number; offset?: number } = {},
): Promise<Array<ReservationRow & { property_nome: string; property_slug: string; guest_count: number; guest_names: string }>> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.propertyId) { where.push("r.property_id = ?"); binds.push(opts.propertyId); }
  if (opts.status) { where.push("r.status = ?"); binds.push(opts.status); }
  if (opts.q) {
    where.push("(r.reference LIKE ? OR r.guest_email LIKE ? OR EXISTS (SELECT 1 FROM guests g2 WHERE g2.reservation_id = r.id AND (g2.apelido LIKE ? OR g2.nome LIKE ? OR g2.documento_identificacao LIKE ?)))");
    const like = `%${opts.q}%`;
    binds.push(like, like, like.toUpperCase(), like.toUpperCase(), like.toUpperCase());
  }
  const sql = `
    SELECT r.*, p.nome AS property_nome, p.slug AS property_slug,
           (SELECT COUNT(*) FROM guests g WHERE g.reservation_id = r.id) AS guest_count,
           (SELECT GROUP_CONCAT(TRIM(g.nome || ' ' || g.apelido), ', ') FROM guests g WHERE g.reservation_id = r.id) AS guest_names
      FROM reservations r JOIN properties p ON p.id = r.property_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY r.check_in DESC, r.id DESC
     LIMIT ? OFFSET ?`;
  binds.push(Math.min(opts.limit ?? 200, 500), opts.offset ?? 0);
  const r = await db.prepare(sql).bind(...binds).all<ReservationRow & { property_nome: string; property_slug: string; guest_count: number; guest_names: string }>();
  return (r.results ?? []).map((row) => ({ ...row, guest_names: row.guest_names ?? "" }));
}

export interface ReservationInput {
  reference?: string;
  guest_email?: string;
  guest_phone?: string;
  check_in?: string;
  check_out?: string | null;
  notes?: string;
}

export function normalizeReservationInput(input: Record<string, unknown>): ReservationInput {
  const out: ReservationInput = {};
  if (input.reference !== undefined) out.reference = cleanText(input.reference).slice(0, 60);
  if (input.guest_email !== undefined) out.guest_email = cleanText(input.guest_email).slice(0, 140);
  if (input.guest_phone !== undefined) out.guest_phone = cleanText(input.guest_phone).slice(0, 30);
  if (input.check_in !== undefined) out.check_in = cleanText(input.check_in).slice(0, 10);
  if (input.check_out !== undefined) {
    const v = cleanText(input.check_out).slice(0, 10);
    out.check_out = v ? v : null;
  }
  if (input.notes !== undefined) out.notes = cleanText(input.notes).slice(0, 1000);
  return out;
}

export function validateReservationDates(check_in?: string, check_out?: string | null): string | null {
  if (!check_in || !isIsoDate(check_in)) return "Check-in date is required (YYYY-MM-DD)";
  if (check_out) {
    if (!isIsoDate(check_out)) return "Check-out date is invalid";
    if (check_out < check_in) return "Check-out must be on or after check-in";
  }
  return null;
}

export async function insertReservation(
  db: D1Database,
  propertyId: number,
  accessCode: string,
  input: ReservationInput,
  createdBy: "admin" | "guest",
): Promise<ReservationRow> {
  const r = await db
    .prepare(
      `INSERT INTO reservations (property_id, access_code, reference, guest_email, guest_phone, check_in, check_out, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(propertyId, accessCode, input.reference ?? "", input.guest_email ?? "", input.guest_phone ?? "",
      input.check_in, input.check_out ?? null, input.notes ?? "", createdBy)
    .first<ReservationRow>();
  if (!r) throw new Error("insert failed");
  return r;
}

export async function updateReservation(db: D1Database, id: number, input: ReservationInput): Promise<ReservationRow> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [k, v] of Object.entries(input)) {
    sets.push(`${k} = ?`);
    binds.push(v ?? null);
  }
  sets.push("updated_at = ?");
  binds.push(nowIso(), id);
  const r = await db.prepare(`UPDATE reservations SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...binds).first<ReservationRow>();
  if (!r) throw new Error("reservation not found");
  return r;
}

export async function setReservationStatus(
  db: D1Database,
  id: number,
  status: ReservationRow["status"],
  extra: { submitted_at?: string | null; sent_at?: string | null; last_error?: string } = {},
): Promise<void> {
  const sets = ["status = ?", "updated_at = ?"];
  const binds: unknown[] = [status, nowIso()];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    binds.push(v ?? null);
  }
  binds.push(id);
  await db.prepare(`UPDATE reservations SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

export async function approveReservation(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE reservations SET approved = 1 WHERE id = ? AND approved = 0").bind(id).run();
}

export async function deleteReservation(db: D1Database, id: number): Promise<void> {
  // D1 has foreign keys enabled, but be explicit.
  await db.batch([
    db.prepare("DELETE FROM siba_submissions WHERE reservation_id = ?").bind(id),
    db.prepare("DELETE FROM guests WHERE reservation_id = ?").bind(id),
    db.prepare("DELETE FROM reservations WHERE id = ?").bind(id),
  ]);
}

// ---------------------------------------------------------------------------
// Guests
// ---------------------------------------------------------------------------

export async function listGuests(db: D1Database, reservationId: number): Promise<GuestRow[]> {
  const r = await db.prepare("SELECT * FROM guests WHERE reservation_id = ? ORDER BY id").bind(reservationId).all<GuestRow>();
  return r.results ?? [];
}

export async function getGuest(db: D1Database, id: number): Promise<GuestRow | null> {
  return db.prepare("SELECT * FROM guests WHERE id = ?").bind(id).first<GuestRow>();
}

export type GuestInput = Omit<GuestRow, "id" | "reservation_id" | "siba_status" | "siba_sent_at" | "created_at" | "updated_at">;

/** Normalises browser input for one guest into SIBA-compatible values (does not validate completeness). */
export function normalizeGuestInput(input: Record<string, unknown>): GuestInput {
  const up3 = (v: unknown) => cleanText(v).toUpperCase().slice(0, 3);
  return {
    apelido: normalizeName(input.apelido),
    nome: normalizeName(input.nome),
    nacionalidade: up3(input.nacionalidade),
    data_nascimento: cleanText(input.data_nascimento).slice(0, 10),
    local_nascimento: normalizeText(input.local_nascimento, 30),
    documento_identificacao: normalizeDocNumber(input.documento_identificacao),
    tipo_documento: normalizeDocType(input.tipo_documento),
    pais_emissor_documento: up3(input.pais_emissor_documento),
    pais_residencia_origem: up3(input.pais_residencia_origem),
    local_residencia_origem: normalizeText(input.local_residencia_origem, 30),
  };
}

export async function insertGuest(db: D1Database, reservationId: number, g: GuestInput): Promise<GuestRow> {
  const r = await db
    .prepare(
      `INSERT INTO guests (reservation_id, apelido, nome, nacionalidade, data_nascimento, local_nascimento,
         documento_identificacao, tipo_documento, pais_emissor_documento, pais_residencia_origem, local_residencia_origem)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(reservationId, g.apelido, g.nome, g.nacionalidade, g.data_nascimento, g.local_nascimento,
      g.documento_identificacao, g.tipo_documento, g.pais_emissor_documento, g.pais_residencia_origem, g.local_residencia_origem)
    .first<GuestRow>();
  if (!r) throw new Error("insert failed");
  return r;
}

export async function updateGuest(db: D1Database, id: number, g: GuestInput, resetSiba: boolean): Promise<GuestRow> {
  const r = await db
    .prepare(
      `UPDATE guests SET apelido=?, nome=?, nacionalidade=?, data_nascimento=?, local_nascimento=?,
         documento_identificacao=?, tipo_documento=?, pais_emissor_documento=?, pais_residencia_origem=?, local_residencia_origem=?,
         siba_status = CASE WHEN ? THEN 'pending' ELSE siba_status END,
         updated_at=? WHERE id=? RETURNING *`,
    )
    .bind(g.apelido, g.nome, g.nacionalidade, g.data_nascimento, g.local_nascimento,
      g.documento_identificacao, g.tipo_documento, g.pais_emissor_documento, g.pais_residencia_origem, g.local_residencia_origem,
      resetSiba ? 1 : 0, nowIso(), id)
    .first<GuestRow>();
  if (!r) throw new Error("guest not found");
  return r;
}

export async function deleteGuest(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM guests WHERE id = ?").bind(id).run();
}

export async function markGuestsSent(db: D1Database, ids: number[], status: "sent" | "error"): Promise<void> {
  if (!ids.length) return;
  const ts = nowIso();
  await db.batch(
    ids.map((id) =>
      db.prepare("UPDATE guests SET siba_status = ?, siba_sent_at = CASE WHEN ? = 'sent' THEN ? ELSE siba_sent_at END, updated_at = ? WHERE id = ?")
        .bind(status, status, ts, ts, id),
    ),
  );
}

export function guestToBulletin(g: GuestRow, r: ReservationRow): GuestBulletin {
  return {
    apelido: g.apelido,
    nome: g.nome,
    nacionalidade: g.nacionalidade,
    data_nascimento: g.data_nascimento,
    local_nascimento: g.local_nascimento,
    documento_identificacao: g.documento_identificacao,
    tipo_documento: g.tipo_documento,
    pais_emissor_documento: g.pais_emissor_documento,
    data_entrada: r.check_in,
    data_saida: r.check_out,
    pais_residencia_origem: g.pais_residencia_origem,
    local_residencia_origem: g.local_residencia_origem,
  };
}

// ---------------------------------------------------------------------------
// Submissions (audit)
// ---------------------------------------------------------------------------

export async function insertSubmission(db: D1Database, s: Omit<SubmissionRow, "id" | "created_at">): Promise<void> {
  await db
    .prepare(
      `INSERT INTO siba_submissions (reservation_id, property_id, file_number, guest_ids, endpoint, request_xml,
         http_status, response_raw, result_code, result_message, ok, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(s.reservation_id, s.property_id, s.file_number, s.guest_ids, s.endpoint, s.request_xml,
      s.http_status, s.response_raw.slice(0, 20000), s.result_code, s.result_message.slice(0, 2000), s.ok, s.triggered_by)
    .run();
}

export async function listSubmissions(db: D1Database, reservationId: number): Promise<Omit<SubmissionRow, "request_xml" | "response_raw">[]> {
  const r = await db
    .prepare(
      `SELECT id, reservation_id, property_id, file_number, guest_ids, endpoint, http_status, result_code, result_message, ok, triggered_by, created_at
         FROM siba_submissions WHERE reservation_id = ? ORDER BY id DESC LIMIT 50`,
    )
    .bind(reservationId)
    .all<Omit<SubmissionRow, "request_xml" | "response_raw">>();
  return r.results ?? [];
}

export async function getSubmission(db: D1Database, id: number): Promise<SubmissionRow | null> {
  return db.prepare("SELECT * FROM siba_submissions WHERE id = ?").bind(id).first<SubmissionRow>();
}

export async function dashboardCounts(db: D1Database) {
  const r = await db
    .prepare(
      `SELECT
         COALESCE(SUM(status = 'draft'), 0)     AS draft,
         COALESCE(SUM(status = 'submitted'), 0) AS submitted,
         COALESCE(SUM(status = 'sent'), 0)      AS sent,
         COALESCE(SUM(status = 'error'), 0)     AS error,
         COUNT(*)                  AS total
       FROM reservations WHERE status <> 'cancelled'`,
    )
    .first<{ draft: number; submitted: number; sent: number; error: number; total: number }>();
  return r ?? { draft: 0, submitted: 0, sent: 0, error: 0, total: 0 };
}
