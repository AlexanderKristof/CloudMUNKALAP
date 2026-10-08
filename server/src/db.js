'use strict';

// =============================================================================
// ADATBÁZIS (SQLite) – a táblák szerkezete és az adatbázis megnyitása
// =============================================================================
// Az adatbázis egyetlen fájl: /opt/munkalap/data/munkalap.db
// A PDF-ek és aláírások NEM itt vannak, hanem fájlként: /opt/munkalap/data/files/<munkalap id>/
// Táblák:
//   users             – felhasználók (e-mail cím alapján)
//   devices           – telefonok / böngészők, amikről beléptek
//   sessions          – belépési tokenek (ki van éppen bejelentkezve)
//   worksheets        – a munkalapok (egy sor = egy munkalap)
//   worksheet_history – a munkalapok korábbi változatai (semmi nem vész el)
//   meta              – belső számláló a szinkronhoz
// A "CREATE TABLE IF NOT EXISTS" miatt az első indításkor létrejönnek, később nem nyúl hozzájuk.
// =============================================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
-- A felhasználót az e-mail címe azonosítja (jelszó nincs).
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  last_user_id INTEGER REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  device_id   TEXT REFERENCES devices(id),
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);

-- Egy sor = egy munkalap. A teljes kitöltött űrlap a "data" oszlopban van JSON-ként,
-- a kereséshez használt mezőket külön oszlopba is kiírjuk. A PDF és az aláírások
-- fájlként vannak a lemezen (FILES_DIR/<munkalap id>/), itt csak az van, hogy megvannak-e.
CREATE TABLE IF NOT EXISTS worksheets (
  id                  TEXT PRIMARY KEY,
  seq                 INTEGER NOT NULL UNIQUE,
  version             INTEGER NOT NULL DEFAULT 1,
  created_by          INTEGER NOT NULL REFERENCES users(id),
  updated_by          INTEGER NOT NULL REFERENCES users(id),
  device_id           TEXT REFERENCES devices(id),
  munkalapszam        TEXT,
  ugyfel              TEXT,
  ugyfel_email        TEXT,
  helyszin            TEXT,
  gep                 TEXT,
  datum_szoveg        TEXT,
  data                TEXT NOT NULL,
  has_pdf             INTEGER NOT NULL DEFAULT 0,
  has_alairas_ugyfel  INTEGER NOT NULL DEFAULT 0,
  has_alairas_szerviz INTEGER NOT NULL DEFAULT 0,
  email_status        TEXT NOT NULL DEFAULT 'nincs',
  email_sent_at       INTEGER,
  email_error         TEXT,
  deleted             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_created_by ON worksheets(created_by);
CREATE INDEX IF NOT EXISTS idx_ws_created_at ON worksheets(created_at);
CREATE INDEX IF NOT EXISTS idx_ws_munkalapszam ON worksheets(munkalapszam);

-- Minden felülírt / törölt változat ide kerül, így semmi nem vész el,
-- ha két eszköz egyszerre módosítja ugyanazt a munkalapot.
CREATE TABLE IF NOT EXISTS worksheet_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  worksheet_id  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  updated_by    INTEGER NOT NULL,
  device_id     TEXT,
  data          TEXT NOT NULL,
  deleted       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_ws ON worksheet_history(worksheet_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta(key, value) VALUES ('seq', 0);
`;

// Az adatbázis megnyitása (ha még nincs, létrehozza a fájlt és a táblákat).
function openDb(file) {
  // A mappa létrehozása, ha még nincs (':memory:' = csak memóriában, a tesztekhez).
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); // gyorsabb, és olvasás közben is lehet írni
  db.pragma('foreign_keys = ON'); // a táblák közti hivatkozások ellenőrzése
  db.pragma('busy_timeout = 5000'); // ha épp foglalt, max. 5 mp-et vár, mielőtt hibát ad
  // Az SQLite beépített LOWER()/NOCASE csak ASCII betűkre működik, ez az ékezeteseket is kezeli.
  db.function('ulower', { deterministic: true }, (s) => (s === null ? null : String(s).toLocaleLowerCase('hu')));
  db.exec(SCHEMA); // táblák létrehozása, ha még nincsenek
  return db;
}

module.exports = { openDb };
