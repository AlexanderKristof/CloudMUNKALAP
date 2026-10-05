'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL UNIQUE,
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

-- Egy sor = egy munkalap. A teljes munkalap a "data" oszlopban van JSON-ként,
-- a kereséshez használt mezőket külön oszlopba is kiírjuk.
CREATE TABLE IF NOT EXISTS worksheets (
  id            TEXT PRIMARY KEY,
  seq           INTEGER NOT NULL UNIQUE,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    INTEGER NOT NULL REFERENCES users(id),
  updated_by    INTEGER NOT NULL REFERENCES users(id),
  device_id     TEXT REFERENCES devices(id),
  munkalapszam  TEXT,
  ugyfel        TEXT,
  datum         TEXT,
  allapot       TEXT,
  data          TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ws_created_by ON worksheets(created_by);
CREATE INDEX IF NOT EXISTS idx_ws_datum ON worksheets(datum);
CREATE INDEX IF NOT EXISTS idx_ws_ugyfel ON worksheets(ugyfel);

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

function openDb(file) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Az SQLite beépített LOWER()/NOCASE csak ASCII betűkre működik, ez az ékezeteseket is kezeli.
  db.function('ulower', { deterministic: true }, (s) => (s === null ? null : String(s).toLocaleLowerCase('hu')));
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
