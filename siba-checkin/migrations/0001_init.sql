-- SIBA check-in database (Cloudflare D1 / SQLite)

-- Establishment ("Unidade Hoteleira") — data required by SIBA to identify the listing.
-- One row per listing; the admin edits it in the panel. Chave de Activação is stored here
-- (the database is private; it is never sent to the browser of a guest).
CREATE TABLE IF NOT EXISTS properties (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  slug                TEXT NOT NULL UNIQUE,               -- used in guest links: /r/<slug>
  codigo_unidade      TEXT NOT NULL,                      -- Código Unidade Hoteleira (NIPC), 9 digits
  estabelecimento     TEXT NOT NULL DEFAULT '00',         -- Número de ordem da Unidade Hoteleira
  nome                TEXT NOT NULL,                      -- Nome da Unidade Hoteleira (max 40)
  abreviatura         TEXT NOT NULL,                      -- Abreviatura do Nome (max 15)
  morada              TEXT NOT NULL,                      -- Morada do estabelecimento (max 40)
  localidade          TEXT NOT NULL,                      -- Localidade (max 30)
  codigo_postal       TEXT NOT NULL,                      -- Código Postal, 4 digits
  zona_postal         TEXT NOT NULL,                      -- Zona Postal, 3 digits
  telefone            TEXT NOT NULL,                      -- Telefone, digits
  fax                 TEXT NOT NULL DEFAULT '',           -- optional
  nome_contacto       TEXT NOT NULL,                      -- Nome Contacto (max 40)
  email_contacto      TEXT NOT NULL,                      -- Email Contacto (max 140)
  chave_activacao     TEXT NOT NULL,                      -- Chave de Activação (SIBA access key)
  next_file_number    INTEGER NOT NULL DEFAULT 1,         -- Numero_Ficheiro counter (1..99999)
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- A reservation = one stay (check-in/check-out) with one or more guests.
-- Guests open /r/<slug>/<access_code> (or the admin creates it) and fill their ID details.
CREATE TABLE IF NOT EXISTS reservations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id         INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  access_code         TEXT NOT NULL UNIQUE,               -- secret code in the guest link
  reference           TEXT NOT NULL DEFAULT '',           -- booking ref (Airbnb/Booking/...) optional
  guest_email         TEXT NOT NULL DEFAULT '',
  guest_phone         TEXT NOT NULL DEFAULT '',
  check_in            TEXT NOT NULL,                      -- YYYY-MM-DD
  check_out           TEXT,                               -- YYYY-MM-DD (nullable)
  notes               TEXT NOT NULL DEFAULT '',
  -- status of the whole reservation:
  --   draft      : link created, guest has not submitted yet
  --   submitted  : guest pressed "Send" (data saved), waiting to be sent to SIBA
  --   sent       : all bulletins accepted by SIBA
  --   error      : SIBA rejected the last attempt (see siba_submissions)
  --   cancelled  : cancelled by the admin
  status              TEXT NOT NULL DEFAULT 'draft',
  -- 1 when sending to SIBA was authorised (guest pressed Send with AUTO_SEND on, or the admin
  -- pressed "Send"). The scheduled job only sends approved reservations (e.g. future check-ins).
  approved            INTEGER NOT NULL DEFAULT 0,
  submitted_at        TEXT,
  sent_at             TEXT,
  last_error          TEXT NOT NULL DEFAULT '',
  created_by          TEXT NOT NULL DEFAULT 'admin',      -- 'admin' | 'guest'
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reservations_property ON reservations(property_id, check_in);
CREATE INDEX IF NOT EXISTS idx_reservations_status   ON reservations(status);

-- One row per guest = one "Boletim de Alojamento". Field names mirror the SIBA XML (BAL.XSD).
CREATE TABLE IF NOT EXISTS guests (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id            INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  apelido                   TEXT NOT NULL DEFAULT '',     -- surname (max 40)
  nome                      TEXT NOT NULL DEFAULT '',     -- given names (max 40, optional if single name)
  nacionalidade             TEXT NOT NULL DEFAULT '',     -- ICAO 3-letter code
  data_nascimento           TEXT NOT NULL DEFAULT '',     -- YYYY-MM-DD
  local_nascimento          TEXT NOT NULL DEFAULT '',     -- optional (max 30)
  documento_identificacao   TEXT NOT NULL DEFAULT '',     -- [A-Z0-9] max 16
  tipo_documento            TEXT NOT NULL DEFAULT 'P',    -- P passport | B ID card | O other
  pais_emissor_documento    TEXT NOT NULL DEFAULT '',     -- ICAO code
  pais_residencia_origem    TEXT NOT NULL DEFAULT '',     -- ICAO code
  local_residencia_origem   TEXT NOT NULL DEFAULT '',     -- city (max 30)
  -- per-guest SIBA state: pending | sent | error
  siba_status               TEXT NOT NULL DEFAULT 'pending',
  siba_sent_at              TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_guests_reservation ON guests(reservation_id);

-- Full audit log of every call made to the SIBA web service.
CREATE TABLE IF NOT EXISTS siba_submissions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id      INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id         INTEGER NOT NULL,
  file_number         INTEGER NOT NULL,                   -- Numero_Ficheiro used
  guest_ids           TEXT NOT NULL,                      -- JSON array of guest ids included
  endpoint            TEXT NOT NULL,
  request_xml         TEXT NOT NULL,                      -- MovimentoBAL XML (decoded, for auditing)
  http_status         INTEGER,
  response_raw        TEXT NOT NULL DEFAULT '',
  result_code         TEXT NOT NULL DEFAULT '',           -- '0' = success, otherwise SIBA error code
  result_message      TEXT NOT NULL DEFAULT '',
  ok                  INTEGER NOT NULL DEFAULT 0,
  triggered_by        TEXT NOT NULL DEFAULT 'guest',      -- guest | admin | cron
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_submissions_reservation ON siba_submissions(reservation_id);
