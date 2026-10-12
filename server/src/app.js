'use strict';

// =============================================================================
// MUNKALAP SZERVER – az összes API végpont (/api/...)
// =============================================================================
// Ez a fájl írja le, mit csinál a szerver, amikor az app vagy a böngésző kér tőle valamit:
//   POST   /api/login                       bejelentkezés e-mail címmel + alkalmazáskulccsal
//   POST   /api/logout                      kijelentkezés
//   GET    /api/me                          ki vagyok (a token alapján)
//   GET    /api/users                       felhasználók listája
//   GET    /api/worksheets                  munkalapok keresése / listázása
//   GET    /api/worksheets/:id              egy munkalap
//   GET    /api/worksheets/:id/history      korábbi változatok
//   GET    /api/worksheets/:id/files/:kind  PDF vagy aláírás letöltése
//   PUT    /api/worksheets/:id              munkalap mentése (adatok + fájlok)
//   POST   /api/worksheets                  új munkalap (a szerver ad azonosítót)
//   POST   /api/worksheets/:id/email        e-mail (újra)küldése
//   DELETE /api/worksheets/:id              törlés (csak megjelölés)
//   POST   /api/sync                        szinkron több eszköz között
//   POST   /api/dri/foglalas                DRI munkalapszám lefoglalása egy munkalaphoz
//   PUT    /api/worksheets/:id/modositas    munkalap módosítása (új PDF készül, piros "Módosítás dátuma")
//   GET    /api/worksheets/:id/valtozatok   az eredeti és a módosított változatok listája
//   GET    /api/worksheets/:id/valtozatok/:n/pdf  egy változat PDF-je (0 = eredeti)
//   /api/admin/...                          admin felület (külön jelszóval) – lásd lent
//
// Az adatbázis szerkezete a db.js-ben van, a szerver indítása és beállításai az index.js-ben.
// =============================================================================

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { munkalapPdf, ALAP_SABLON } = require('./pdf');
const adminJelszo = require('./adminjelszo');

// Az app által küldött munkalap mezők (a "data" JSON kulcsai), amiket a kereséshez külön oszlopba is kiírunk.
const SEARCH_FIELDS = {
  munkalapszam: 'driSzam',
  ugyfel: 'ugyfel',
  ugyfel_email: 'ugyfelEmail',
  helyszin: 'helyszin',
  gep: 'gep',
  datum_szoveg: 'datum',
};

// Feltölthető fájlok: mező neve a kérésben -> fájl a lemezen, adatbázis oszlop, típus.
const FILES = {
  pdf: { file: 'munkalap.pdf', column: 'has_pdf', type: 'application/pdf', magic: Buffer.from('%PDF') },
  alairasUgyfel: { file: 'alairas_ugyfel.png', column: 'has_alairas_ugyfel', type: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  alairasSzerviz: { file: 'alairas_szerviz.png', column: 'has_alairas_szerviz', type: 'image/png', magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
};

// A DRI szám formája: 7 jegyű, elöl nullákkal kiegészítve (2001 -> "0002001"), mint a papíros tömbökön.
function formatDri(szam) {
  return String(szam).padStart(7, '0');
}

// A munkalap mezői, amiket módosítani lehet (a DRI szám és az aláírások nem módosíthatók).
const MODOSITHATO_MEZOK = ['ugyfel', 'ugyfelEmail', 'helyszin', 'gep', 'idotartam', 'km', 'elvegzettMunka', 'hibaLeiras', 'datum'];

// Két munkalap-változat összehasonlítása: melyik mező változott, mi volt előtte és mi lett utána.
function kulonbsegek(elotte, utana) {
  const kulcsok = new Set([...Object.keys(elotte || {}), ...Object.keys(utana || {})]);
  const lista = [];
  for (const k of kulcsok) {
    const a = elotte && elotte[k] !== undefined && elotte[k] !== null ? String(elotte[k]) : '';
    const b = utana && utana[k] !== undefined && utana[k] !== null ? String(utana[k]) : '';
    if (a !== b) lista.push({ mezo: k, elotte: a, utana: b });
  }
  return lista;
}

// A "Megtett km" mező szabad szöveg (pl. "25", "10km", "12,5 km"): az első számot vesszük ki belőle.
// Ha nincs benne szám, null (a statisztikában "nem értelmezhető" lesz).
function kmErtek(szoveg) {
  if (szoveg === undefined || szoveg === null) return null;
  const m = String(szoveg).replace(',', '.').match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// Munkalap azonosító: csak betű, szám, - és _ (így biztonságosan lehet belőle mappanevet csinálni a lemezen).
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
// Egyszerű e-mail ellenőrzés: valami@valami
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

// A munkalap adataiból kiveszi a keresendő mezőket (SEARCH_FIELDS szerint) – ezek külön oszlopba kerülnek.
function extractSearchFields(data) {
  const out = {};
  for (const [col, key] of Object.entries(SEARCH_FIELDS)) {
    const v = data[key];
    out[col] = v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v).trim() || null;
  }
  return out;
}

// E-mail cím egységesítése: szóközök le, kisbetűsítés. Érvénytelen címre null.
// Így a "Kovacs@ceg.hu" és a "kovacs@ceg.hu " ugyanaz a felhasználó.
function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLocaleLowerCase('hu');
  return e.length <= 200 && EMAIL_PATTERN.test(e) ? e : null;
}

// Kereséshez: a % és _ jelek az SQL LIKE-ban különleges jelentésűek, ezért "semlegesítjük" őket.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// "2026-10-06" -> az adott nap kezdete (a szerver időzónájában), ezredmásodpercben
function dayStart(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? null : t;
}

// A multipart (fájlos) kérésben a "data" mező szövegként jön – itt alakítjuk vissza objektummá.
function parseJsonField(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new HttpError(400, 'A "data" mező nem érvényes JSON.');
  }
}

// Hiba, ami a felhasználónak szól: HTTP státuszkód + magyar üzenet (pl. 400 "Érvénytelen ...").
// A lenti hibakezelő ezt JSON-ként küldi vissza: { "error": "..." }
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A szerver alkalmazás létrehozása. Az index.js hívja meg az adatbázissal és a beállításokkal;
// a tesztek ugyanígy, csak memóriában tartott adatbázissal.
function createApp(db, options = {}) {
  const appKey = options.appKey || null; // közös alkalmazáskulcs (APP_KEY), null = nincs védelem
  const now = options.now || (() => Date.now()); // aktuális idő (a tesztekben "megállítható")
  const filesDir = path.resolve(options.filesDir || path.join(process.cwd(), 'data', 'files'));
  const sendMail = options.sendMail || null; // async (message) => {}, nodemailer kompatibilis üzenettel
  const mailFrom = options.mailFrom || null; // feladó, pl. "DR Industrie Szerviz" <szerviz@...>
  const sablonFile = options.sablonFile || ALAP_SABLON; // a nyomtatvány háttérképe a szerveren készülő PDF-ekhez
  // Az adminok e-mail címei (ADMIN_EMAILS a .env-ben, vesszővel elválasztva).
  const adminEmails = (options.adminEmails || []).map(normalizeEmail).filter(Boolean);

  // Előre elkészített SQL lekérdezések (gyorsabb és biztonságos: a paraméterek nem keveredhetnek az SQL-be).
  const stmt = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    insertUser: db.prepare('INSERT INTO users(email, name, created_at, last_seen) VALUES (@email, @name, @now, @now)'),
    touchUser: db.prepare('UPDATE users SET last_seen = @now, name = COALESCE(@name, name) WHERE id = @id'),
    upsertDevice: db.prepare(`
      INSERT INTO devices(id, name, last_user_id, created_at, last_seen) VALUES (@id, @name, @userId, @now, @now)
      ON CONFLICT(id) DO UPDATE SET name = COALESCE(@name, name), last_user_id = @userId, last_seen = @now`),
    insertSession: db.prepare('INSERT INTO sessions(token, user_id, device_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
    sessionByToken: db.prepare(`
      SELECT s.token, s.device_id, u.id AS user_id, u.email AS user_email, u.name AS user_name
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
    touchUserSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    nextSeq: db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value"),
    wsById: db.prepare('SELECT * FROM worksheets WHERE id = ?'),
    insertWs: db.prepare(`
      INSERT INTO worksheets(id, seq, version, created_by, updated_by, device_id,
        munkalapszam, ugyfel, ugyfel_email, helyszin, gep, datum_szoveg, data,
        has_pdf, has_alairas_ugyfel, has_alairas_szerviz, deleted, created_at, updated_at)
      VALUES (@id, @seq, 1, @userId, @userId, @deviceId,
        @munkalapszam, @ugyfel, @ugyfel_email, @helyszin, @gep, @datum_szoveg, @data,
        @has_pdf, @has_alairas_ugyfel, @has_alairas_szerviz, @deleted, @now, @now)`),
    updateWs: db.prepare(`
      UPDATE worksheets SET seq = @seq, version = version + 1, updated_by = @userId, device_id = @deviceId,
        munkalapszam = @munkalapszam, ugyfel = @ugyfel, ugyfel_email = @ugyfel_email, helyszin = @helyszin,
        gep = @gep, datum_szoveg = @datum_szoveg, data = @data,
        has_pdf = @has_pdf, has_alairas_ugyfel = @has_alairas_ugyfel, has_alairas_szerviz = @has_alairas_szerviz,
        deleted = @deleted, updated_at = @now
      WHERE id = @id`),
    updateFileFlags: db.prepare(`
      UPDATE worksheets SET has_pdf = @has_pdf, has_alairas_ugyfel = @has_alairas_ugyfel,
        has_alairas_szerviz = @has_alairas_szerviz WHERE id = @id`),
    archiveWs: db.prepare(`
      INSERT INTO worksheet_history(worksheet_id, version, updated_by, device_id, data, deleted, updated_at, archived_at)
      VALUES (@id, @version, @updated_by, @device_id, @data, @deleted, @updated_at, @archivedAt)`),
    setEmailStatus: db.prepare('UPDATE worksheets SET email_status = @status, email_sent_at = @sentAt, email_error = @error WHERE id = @id'),
    history: db.prepare(`
      SELECT h.*, u.email AS updated_by_email, u.name AS updated_by_name FROM worksheet_history h
      JOIN users u ON u.id = h.updated_by WHERE h.worksheet_id = ? ORDER BY h.version DESC`),
    // --- Napló ---
    insertNaplo: db.prepare(`
      INSERT INTO naplo(ts, tipus, worksheet_id, ki, elotte, utana, elotte_pdf, megjegyzes)
      VALUES (@ts, @tipus, @worksheetId, @ki, @elotte, @utana, @elottePdf, @megjegyzes)`),
    modositasokByWs: db.prepare("SELECT * FROM naplo WHERE worksheet_id = ? AND tipus = 'modositas' ORDER BY id"),
    // --- DRI munkalapszámok ---
    foglalasByWs: db.prepare('SELECT * FROM dri_foglalasok WHERE worksheet_id = ?'),
    // A számláló növelése és a régi érték visszaadása (ez lesz a kiosztott szám).
    kovetkezoDri: db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'dri_kovetkezo' RETURNING value - 1 AS szam"),
    insertFoglalas: db.prepare(`
      INSERT INTO dri_foglalasok(szam, worksheet_id, user_id, device_id, created_at)
      VALUES (@szam, @worksheetId, @userId, @deviceId, @now)`),
    users: db.prepare(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_seen,
        (SELECT COUNT(*) FROM worksheets w WHERE w.created_by = u.id AND w.deleted = 0) AS worksheet_count
      FROM users u ORDER BY u.email`),
  };

  // Munkalap lekérdezés a felhasználók nevével / e-mailjével és az eszköz nevével együtt.
  const SELECT_WS = `
    SELECT w.*, cu.email AS created_by_email, cu.name AS created_by_name,
      uu.email AS updated_by_email, uu.name AS updated_by_name, d.name AS device_name,
      (SELECT COUNT(*) FROM naplo n WHERE n.worksheet_id = w.id AND n.tipus = 'modositas') AS mod_db
    FROM worksheets w
    JOIN users cu ON cu.id = w.created_by
    JOIN users uu ON uu.id = w.updated_by
    LEFT JOIN devices d ON d.id = w.device_id`;
  const wsFullById = db.prepare(`${SELECT_WS} WHERE w.id = ?`);
  const wsSince = db.prepare(`${SELECT_WS} WHERE w.seq > ? ORDER BY w.seq LIMIT ?`);

  // Időbélyeg (ezredmásodperc) -> szabványos dátum szöveg, pl. "2026-10-08T07:30:00.000Z"
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const person = (id, email, name) => ({ id, email, name: name || null });

  // Adatbázis sor -> az appnak / böngészőnek küldött JSON formátum.
  function serialize(row) {
    return {
      id: row.id,
      version: row.version,
      seq: row.seq,
      munkalapszam: row.munkalapszam,
      ugyfel: row.ugyfel,
      ugyfelEmail: row.ugyfel_email,
      helyszin: row.helyszin,
      gep: row.gep,
      datum: row.datum_szoveg,
      deleted: !!row.deleted,
      modositasokSzama: row.mod_db || 0, // hányszor módosították (0 = eredeti)
      files: {
        pdf: !!row.has_pdf,
        alairasUgyfel: !!row.has_alairas_ugyfel,
        alairasSzerviz: !!row.has_alairas_szerviz,
      },
      email: { status: row.email_status, sentAt: iso(row.email_sent_at), error: row.email_error },
      createdBy: person(row.created_by, row.created_by_email, row.created_by_name),
      updatedBy: person(row.updated_by, row.updated_by_email, row.updated_by_name),
      device: row.device_id ? { id: row.device_id, name: row.device_name } : null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      data: JSON.parse(row.data),
    };
  }

  // Ellenőrzi a munkalap azonosítót (lásd ID_PATTERN), különben 400-as hiba.
  function checkId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new HttpError(400, 'Érvénytelen munkalap azonosító (csak betű, szám, - és _ lehet benne).');
    }
  }

  // Melyik fájl van meg a munkalaphoz (has_pdf stb.): ami most jött, az biztosan;
  // ami nem jött most, annál a korábbi állapot marad.
  function fileFlags(existing, uploaded) {
    const flags = {};
    for (const [field, f] of Object.entries(FILES)) {
      flags[f.column] = uploaded[field] ? 1 : (existing ? existing[f.column] : 0);
    }
    return flags;
  }

  // A feltöltött fájlokat előbb ideiglenes néven írjuk ki, aztán átnevezzük, így félkész fájl nem marad.
  function writeFiles(id, uploaded) {
    const entries = Object.entries(uploaded);
    if (!entries.length) return;
    const dir = path.join(filesDir, id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [field, buf] of entries) {
      const target = path.join(dir, FILES[field].file);
      const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, target);
    }
  }

  // A kérésben érkezett fájlok kiolvasása. Biztonsági ellenőrzés: a fájl eleje ("magic" bájtok)
  // alapján megnézzük, hogy tényleg PDF / PNG-e, hogy ne lehessen mást feltölteni.
  function readUploadedFiles(req) {
    const uploaded = {};
    for (const [field, f] of Object.entries(FILES)) {
      const file = req.files && req.files[field] && req.files[field][0];
      if (!file) continue;
      if (!file.buffer.subarray(0, f.magic.length).equals(f.magic)) {
        throw new HttpError(400, `A(z) "${field}" fájl nem ${f.type === 'application/pdf' ? 'PDF' : 'PNG kép'}.`);
      }
      uploaded[field] = file.buffer;
    }
    return uploaded;
  }

  // DRI szám lefoglalása egy munkalaphoz. Ha a munkalapnak már van száma, azt adja vissza
  // (így ugyanaz a munkalap soha nem kap két számot). Tranzakcióban fut, ezért ha egyszerre
  // többen kérnek, a kérések sorban követik egymást, és mindenki más számot kap.
  const driFoglalas = db.transaction((session, worksheetId) => {
    const meglevo = stmt.foglalasByWs.get(worksheetId);
    if (meglevo) return meglevo.szam;
    const { szam } = stmt.kovetkezoDri.get();
    stmt.insertFoglalas.run({
      szam, worksheetId, userId: session.user_id, deviceId: session.device_id, now: now(),
    });
    return szam;
  });

  // Bejegyzés a naplóba.
  function naplo(tipus, { worksheetId = null, ki = null, elotte = null, utana = null, elottePdf = null, megjegyzes = null } = {}) {
    stmt.insertNaplo.run({ ts: now(), tipus, worksheetId, ki, elotte, utana, elottePdf, megjegyzes });
  }

  // Egy munkalap mentése (új vagy meglévő). Ha a munkalapot közben más is módosította
  // (baseVersion < aktuális verzió), a mentés megtörténik, de "conflict: true" jelzéssel,
  // az előző változat pedig a history táblába kerül.
  const saveWorksheet = db.transaction((session, { id, data, deleted = false, baseVersion = null, uploaded = {} }) => {
    if (id !== undefined) checkId(id);
    const existing = id ? stmt.wsById.get(id) : null;
    if (data === undefined && existing) data = JSON.parse(existing.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpError(400, 'A munkalap adatának ("data") JSON objektumnak kell lennie.');
    }
    id = id || crypto.randomUUID(); // ha az app nem adott azonosítót, a szerver generál

    // A DRI számot NEM az app küldi: mindig a szerver által kiosztott számot írjuk be,
    // akármit is küldött az app (így nem lehet átírni és nem lehet kétszer ugyanaz).
    const foglalas = stmt.foglalasByWs.get(id);
    if (foglalas) {
      data = { ...data, driSzam: formatDri(foglalas.szam) };
    } else if (existing) {
      // Régi (a számkiosztás előtti) munkalap: a meglévő száma marad, nem módosítható.
      data = { ...data, driSzam: JSON.parse(existing.data).driSzam };
    } else {
      // Új munkalap foglalás nélkül (pl. a böngészőből): most kap számot.
      data = { ...data, driSzam: formatDri(driFoglalas(session, id)) };
    }

    const json = JSON.stringify(data);
    const del = deleted ? 1 : 0;
    const t = now();
    const flags = fileFlags(existing, uploaded);

    // Ha az adat semmit nem változott (pl. az app újraküldte, mert megszakadt a net):
    if (existing && existing.data === json && existing.deleted === del) {
      // Ugyanaz az adat (pl. az app újrapróbálta a feltöltést): új változat nem kell, csak a fájlok frissülnek.
      stmt.updateFileFlags.run({ id: existing.id, ...flags });
      return { id: existing.id, version: existing.version, seq: existing.seq, status: 'unchanged', conflict: false };
    }

    // A mentendő sor adatai.
    const params = {
      id,
      seq: stmt.nextSeq.get().value, // folyamatosan növekvő sorszám a szinkronhoz ("mi változott azóta")
      userId: session.user_id,
      deviceId: session.device_id,
      data: json,
      deleted: del,
      now: t,
      ...flags,
      ...extractSearchFields(data),
    };

    // Új munkalap -> beszúrás.
    if (!existing) {
      stmt.insertWs.run(params);
      naplo('letrehozas', { worksheetId: params.id, ki: session.user_email, utana: json });
      return { id: params.id, version: 1, seq: params.seq, status: 'created', conflict: false };
    }

    // Meglévő munkalap -> a régi változatot előbb elmentjük az előzményekbe, aztán felülírjuk.
    const adatValtozott = existing.data !== json;
    let elottePdf = null;
    if (adatValtozott) {
      // A módosítás előtti PDF megmarad más néven (munkalap_v<verzió>.pdf), hogy később is megnézhető legyen.
      const regi = path.join(filesDir, id, FILES.pdf.file);
      if (fs.existsSync(regi)) {
        elottePdf = `munkalap_v${existing.version}.pdf`;
        fs.renameSync(regi, path.join(filesDir, id, elottePdf));
      }
    }
    stmt.archiveWs.run({ ...existing, archivedAt: t });
    stmt.updateWs.run(params);
    if (adatValtozott) {
      naplo('modositas', { worksheetId: id, ki: session.user_email, elotte: existing.data, utana: json, elottePdf });
    } else if (del && !existing.deleted) {
      naplo('torles', { worksheetId: id, ki: session.user_email, elotte: existing.data });
    } else if (!del && existing.deleted) {
      naplo('visszaallitas', { worksheetId: id, ki: session.user_email, utana: json });
    }
    const conflict = baseVersion !== null && baseVersion !== undefined && baseVersion !== ''
      && Number(baseVersion) < existing.version;
    return { id: existing.id, version: existing.version + 1, seq: params.seq, status: 'updated', conflict, adatValtozott };
  });

  // Módosított munkalap PDF-jének elkészítése a szerveren (a régi aláírásokkal és a piros
  // "Módosítás dátuma" felirattal). Ha nem sikerül (pl. hiányzik a sablon.png), a hibát naplózza,
  // és az app által feltöltött PDF marad (ha volt).
  const pdfHibak = new Map(); // munkalap id -> miért nem sikerült a módosított PDF (pl. hiányzik a sablon)

  // Ha egy módosított munkalap aktuális PDF-je hiányzik (pl. a módosításkor még nem volt fent a sablon),
  // akkor most elkészítjük. Így a hiba javítása után a PDF magától pótlódik, nem kell újra módosítani.
  async function pdfPotlas(id) {
    const row = stmt.wsById.get(id);
    if (!row || row.deleted || !stmt.modositasokByWs.all(id).length) return;
    if (fs.existsSync(path.join(filesDir, id, FILES.pdf.file))) return;
    await modositottPdf(id);
  }

  async function modositottPdf(id) {
    const row = stmt.wsById.get(id);
    const dir = path.join(filesDir, id);
    const olvas = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f)) : null);
    try {
      const pdf = await munkalapPdf(JSON.parse(row.data), {
        alairasUgyfel: row.has_alairas_ugyfel ? olvas(FILES.alairasUgyfel.file) : null,
        alairasSzerviz: row.has_alairas_szerviz ? olvas(FILES.alairasSzerviz.file) : null,
        modositva: row.updated_at,
        sablonFile,
      });
      writeFiles(id, { pdf });
      stmt.updateFileFlags.run({ id, has_pdf: 1, has_alairas_ugyfel: row.has_alairas_ugyfel, has_alairas_szerviz: row.has_alairas_szerviz });
      pdfHibak.delete(id);
      return true;
    } catch (err) {
      console.error('Módosított PDF készítési hiba:', err.message);
      pdfHibak.set(id, err.message); // a felületen megjelenik, miért nincs PDF
      const vanPdf = fs.existsSync(path.join(dir, FILES.pdf.file)) ? 1 : 0;
      stmt.updateFileFlags.run({ id, has_pdf: vanPdf, has_alairas_ugyfel: row.has_alairas_ugyfel, has_alairas_szerviz: row.has_alairas_szerviz });
      return false;
    }
  }

  // Egy munkalap változatainak listája: az eredeti és minden módosítás, időrendben.
  // Mindegyiknél: ki és mikor, a teljes tartalom, mi változott az előzőhöz képest, és melyik PDF tartozik hozzá.
  function valtozatok(row) {
    const mods = stmt.modositasokByWs.all(row.id);
    const lista = [];
    const eredetiAdat = mods.length ? mods[0].elotte : row.data;
    lista.push({
      sorszam: 0,
      cim: 'Eredeti',
      ts: iso(row.created_at),
      ki: row.created_by_email || null,
      data: JSON.parse(eredetiAdat),
      pdfFajl: mods.length ? mods[0].elotte_pdf : (row.has_pdf ? FILES.pdf.file : null),
    });
    mods.forEach((m, i) => {
      lista.push({
        sorszam: i + 1,
        cim: `${i + 1}. módosítás`,
        ts: iso(m.ts),
        ki: m.ki,
        data: JSON.parse(m.utana),
        pdfFajl: i + 1 < mods.length ? mods[i + 1].elotte_pdf : (row.has_pdf ? FILES.pdf.file : null),
      });
    });
    return lista.map((v, i) => ({
      sorszam: v.sorszam,
      cim: v.cim,
      ts: v.ts,
      ki: v.ki,
      data: v.data,
      pdf: !!(v.pdfFajl && fs.existsSync(path.join(filesDir, row.id, v.pdfFajl))),
      _pdfFajl: v.pdfFajl,
      valtozasok: i === 0 ? [] : kulonbsegek(lista[i - 1].data, v.data),
      // Az utolsó (aktuális) változatnál: ha nincs PDF, miért nem sikerült elkészíteni
      ...(i === lista.length - 1 && i > 0 && pdfHibak.has(row.id) ? { pdfHiba: pdfHibak.get(row.id) } : {}),
    }));
  }

  // Egy változat PDF-jének elküldése a böngészőnek / appnak.
  function valtozatPdfKuldes(res, row, n) {
    const v = valtozatok(row).find((x) => x.sorszam === Number(n));
    if (!v || !v.pdf) throw new HttpError(404, 'Ehhez a változathoz nincs PDF.');
    const nev = `Munkalap_DRI_${row.munkalapszam || row.id}${v.sorszam ? `_modositas_${v.sorszam}` : ''}.pdf`;
    res.type('application/pdf');
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(nev)}`);
    res.sendFile(path.join(filesDir, row.id, v._pdfFajl));
  }

  // A munkalap PDF-jének elküldése e-mailben az ügyfélnek (vagy a megadott címre), másolatban a felhasználónak.
  // Az eredmény { status: 'kuldve' | 'hiba' | ..., error, to }, és az állapot az adatbázisba is bekerül.
  async function emailWorksheet(id, session, to) {
    const row = stmt.wsById.get(id);
    const cimzett = to ? normalizeEmail(to) : normalizeEmail(row.ugyfel_email || '');
    if (!cimzett) {
      return { status: row.email_status, error: to ? 'Érvénytelen e-mail cím.' : 'Nincs megadva érvényes ügyfél e-mail cím.' };
    }
    // Az e-mail állapot mentése az adatbázisba (ez látszik a listákban zöld / piros ikonként).
    const setStatus = (status, error) => {
      stmt.setEmailStatus.run({ id, status, error, sentAt: status === 'kuldve' ? now() : row.email_sent_at });
      return { status, error, to: cimzett };
    };
    if (!row.has_pdf) return setStatus('hiba', 'Nincs feltöltött PDF ehhez a munkalaphoz.');
    if (!sendMail || !mailFrom) return setStatus('hiba', 'Az e-mail küldés nincs beállítva a szerveren.');

    const szam = row.munkalapszam || '';
    try {
      // A levél tartalma – itt lehet a tárgyat és a szöveget módosítani.
      await sendMail({
        from: mailFrom,
        to: cimzett,
        cc: session.user_email !== cimzett ? session.user_email : undefined,
        subject: `DR Industrie Munkalap - DRI-${szam}`,
        text: `Tisztelt Ügyfelünk!\n\nMellékelten küldjük a(z) DRI-${szam} számú elvégzett munkalapot.\n\nÜdvözlettel,\nDR Industrie Kft.`,
        attachments: [{
          filename: `Munkalap_DRI_${szam.replace(/[^\p{L}\p{N}_-]+/gu, '_')}.pdf`,
          path: path.join(filesDir, id, FILES.pdf.file),
          contentType: 'application/pdf',
        }],
      });
      naplo('email', { worksheetId: id, ki: session.user_email, megjegyzes: `Elküldve: ${cimzett}` });
      return setStatus('kuldve', null);
    } catch (err) {
      console.error('E-mail küldési hiba:', err.message);
      return setStatus('hiba', String(err.message || err).slice(0, 500));
    }
  }

  // --- Az Express webszerver beállítása ---
  const app = express();
  app.disable('x-powered-by'); // ne árulja el a szerver típusát a válaszokban
  app.set('trust proxy', true); // a Caddy (HTTPS) mögött fut, tőle jön a valódi IP cím
  app.use(express.json({ limit: options.bodyLimit || '25mb' })); // JSON kérések feldolgozása
  // Fájlfeltöltés (multipart) feldolgozása: a fájlok a memóriába kerülnek, max. 20 MB / fájl.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.fileLimit || 20 * 1024 * 1024, files: Object.keys(FILES).length },
  }).fields(Object.keys(FILES).map((name) => ({ name, maxCount: 1 })));
  // Ha a kérésnek nincs törzse, üres objektum legyen (így nem kell mindenhol külön ellenőrizni).
  app.use((req, res, next) => {
    if (!req.body || typeof req.body !== 'object') req.body = {};
    next();
  });

  // Az /api/... útvonalak gyűjtője.
  const api = express.Router();

  // Állapotjelzés: "működik a szerver?" (curl .../api/health -> {"ok":true})
  api.get('/health', (req, res) => res.json({ ok: true }));
  // A böngészős felület ebből tudja, kell-e kulcsot kérni, és be van-e állítva az e-mail.
  api.get('/config', (req, res) => res.json({ appKeyRequired: !!appKey, emailEnabled: !!(sendMail && mailFrom) }));

  // Bejelentkezés csak e-mail címmel: ha még nincs ilyen felhasználó, létrehozzuk.
  api.post('/login', (req, res) => {
    // 1. Alkalmazáskulcs ellenőrzése (az app fejlécben, a böngésző a törzsben küldi).
    if (appKey && (req.get('x-app-key') || req.body.appKey) !== appKey) {
      throw new HttpError(401, 'Hibás alkalmazáskulcs.');
    }
    const email = normalizeEmail(req.body.email);
    if (!email) throw new HttpError(400, 'Adj meg egy érvényes e-mail címet.');
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) || null : null;
    const deviceId = typeof req.body.deviceId === 'string' && req.body.deviceId.trim()
      ? req.body.deviceId.trim().slice(0, 100) : null;
    const deviceName = typeof req.body.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 100) || null : null;

    // 2. Felhasználó megkeresése vagy létrehozása, eszköz megjegyzése, új token kiadása.
    const result = db.transaction(() => {
      const t = now();
      let user = stmt.userByEmail.get(email);
      if (!user) {
        const info = stmt.insertUser.run({ email, name, now: t });
        user = { id: Number(info.lastInsertRowid), email, name };
      } else {
        stmt.touchUser.run({ id: user.id, name, now: t });
      }
      if (deviceId) stmt.upsertDevice.run({ id: deviceId, name: deviceName, userId: user.id, now: t });
      // A token egy 32 karakteres véletlen szöveg – ezzel azonosítja magát az app a további kéréseknél.
      const token = crypto.randomBytes(24).toString('base64url');
      stmt.insertSession.run(token, user.id, deviceId, t, t);
      return { token, user: { id: user.id, email: user.email, name: name || user.name || null }, deviceId };
    })();
    res.json(result);
  });

  // Minden további végpont bejelentkezést igényel. A fájl letöltéseknél a token
  // "?token=" paraméterben is jöhet, hogy a böngészőben <img> / link is működjön.
  api.use((req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const token = m ? m[1].trim() : (req.method === 'GET' && typeof req.query.token === 'string' ? req.query.token : null);
    const session = token && stmt.sessionByToken.get(token);
    if (!session) throw new HttpError(401, 'Be kell jelentkezni.');
    const t = now();
    stmt.touchSession.run(t, session.token);
    stmt.touchUserSeen.run(t, session.user_id);
    req.session = session;
    next();
  });

  // Ki vagyok? (a token alapján)
  api.get('/me', (req, res) => {
    const s = req.session;
    res.json({ user: { id: s.user_id, email: s.user_email, name: s.user_name }, deviceId: s.device_id });
  });

  // Kijelentkezés: a token törlése, utána már nem használható.
  api.post('/logout', (req, res) => {
    stmt.deleteSession.run(req.session.token);
    res.json({ ok: true });
  });

  // Felhasználók listája a munkalapjaik számával (a böngészős "Mindenki" szűrőhöz).
  api.get('/users', (req, res) => {
    res.json(stmt.users.all().map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      worksheetCount: u.worksheet_count,
      createdAt: iso(u.created_at),
      lastSeen: iso(u.last_seen),
    })));
  });

  // Keresés / listázás.
  // Paraméterek: q (szabad szöveg), user (felhasználó id vagy e-mail), from, to (a rögzítés napja, pl. 2026-10-01),
  // device, includeDeleted=1, limit, offset
  api.get('/worksheets', (req, res) => {
    // A feltételeket (WHERE) darabonként gyűjtjük össze, a megadott szűrők alapján.
    const where = [];
    const params = {};
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    // Szabad szöveg: kis/nagybetűtől függetlenül keres a fő mezőkben és a teljes munkalap tartalomban.
    if (q) {
      const cols = ['w.munkalapszam', 'w.ugyfel', 'w.ugyfel_email', 'w.helyszin', 'w.gep', 'w.data'];
      where.push(`(${cols.map((c) => `ulower(${c}) LIKE @q ESCAPE '\\'`).join(' OR ')})`);
      params.q = `%${escapeLike(q.toLocaleLowerCase('hu'))}%`;
    }
    // Felhasználó szerint (azonosító szám vagy e-mail cím).
    if (req.query.user) {
      const u = String(req.query.user);
      if (/^\d+$/.test(u)) {
        where.push('w.created_by = @userId');
        params.userId = Number(u);
      } else {
        where.push('cu.email = @userEmail');
        params.userEmail = u.trim().toLocaleLowerCase('hu');
      }
    }
    // Dátum szerint (a rögzítés napja; a "to" napot is beleértve).
    const from = req.query.from ? dayStart(String(req.query.from)) : null;
    const to = req.query.to ? dayStart(String(req.query.to)) : null;
    if (req.query.from && from === null) throw new HttpError(400, 'A "from" dátum formátuma: ÉÉÉÉ-HH-NN.');
    if (req.query.to && to === null) throw new HttpError(400, 'A "to" dátum formátuma: ÉÉÉÉ-HH-NN.');
    if (from !== null) { where.push('w.created_at >= @from'); params.from = from; }
    if (to !== null) { where.push('w.created_at < @to'); params.to = to + 24 * 3600 * 1000; }
    if (req.query.device) { where.push('w.device_id = @device'); params.device = String(req.query.device); }
    // A törölt munkalapok alapból nem látszanak.
    if (!['1', 'true'].includes(String(req.query.includeDeleted))) where.push('w.deleted = 0');

    // Lapozás: egyszerre legfeljebb 1000 találat.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Összes találat száma + az aktuális oldal, a legújabb elöl.
    const total = db.prepare(`SELECT COUNT(*) AS n FROM worksheets w JOIN users cu ON cu.id = w.created_by ${whereSql}`).get(params).n;
    const rows = db.prepare(`${SELECT_WS} ${whereSql} ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params);
    res.json({ total, limit, offset, items: rows.map(serialize) });
  });

  // Egy munkalap lekérése azonosító alapján, vagy 404-es hiba, ha nincs ilyen.
  function getRow(id) {
    const row = wsFullById.get(id);
    if (!row) throw new HttpError(404, 'Nincs ilyen munkalap.');
    return row;
  }

  // Egy munkalap minden adata.
  api.get('/worksheets/:id', (req, res) => res.json(serialize(getRow(req.params.id))));

  // Egy munkalap korábbi változatai (minden módosítás és törlés előtti állapot).
  api.get('/worksheets/:id/history', (req, res) => {
    res.json(stmt.history.all(req.params.id).map((h) => ({
      version: h.version,
      deleted: !!h.deleted,
      updatedBy: person(h.updated_by, h.updated_by_email, h.updated_by_name),
      deviceId: h.device_id,
      updatedAt: iso(h.updated_at),
      data: JSON.parse(h.data),
    })));
  });

  // Fájl letöltése: pdf, alairasUgyfel, alairasSzerviz
  api.get('/worksheets/:id/files/:kind', async (req, res) => {
    if (req.params.kind === 'pdf') await pdfPotlas(getRow(req.params.id).id);
    const row = getRow(req.params.id);
    const f = Object.prototype.hasOwnProperty.call(FILES, req.params.kind) && FILES[req.params.kind];
    if (!f || !row[f.column]) throw new HttpError(404, 'Nincs ilyen fájl.');
    const name = req.params.kind === 'pdf' ? `Munkalap_DRI_${row.munkalapszam || row.id}.pdf` : f.file;
    res.type(f.type);
    // "inline": a böngésző megnyitja (nem csak letölti), a fájlnév pl. Munkalap_DRI_101.pdf
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.sendFile(path.join(filesDir, row.id, f.file));
  });

  // Mentés (új vagy módosítás) az app által generált azonosítóval.
  // Jöhet JSON-ként ({ data, baseVersion, kuldes }) vagy multipart/form-data-ként:
  //   data = a munkalap JSON szövegként, baseVersion, kuldes=1 (e-mail küldés az ügyfélnek),
  //   fájlok: pdf, alairasUgyfel, alairasSzerviz
  async function handleSave(req, res, id) {
    const uploaded = readUploadedFiles(req);
    const data = parseJsonField(req.body.data);
    // Adatbázis mentés és fájlírás egy tranzakcióban: ha a fájlírás nem sikerül,
    // az adatbázis módosítás is visszavonódik (nem marad félkész munkalap).
    const r = db.transaction(() => {
      const saved = saveWorksheet(req.session, { id, data, baseVersion: req.body.baseVersion, uploaded });
      writeFiles(saved.id, uploaded);
      return saved;
    })();

    // Ha egy meglévő munkalap tartalma változott, a szerver készíti el az új PDF-et
    // (piros "Módosítás dátuma" felirattal), az app által küldött helyett.
    if (r.status === 'updated' && r.adatValtozott) await modositottPdf(r.id);

    // E-mail küldés, ha kérték. Ha már egyszer sikeresen kiment, nem küldjük újra
    // (pl. ha az app a megszakadt net miatt újraküldte a munkalapot).
    let email = null;
    if (['1', 'true', true].includes(req.body.kuldes)) {
      const row = stmt.wsById.get(r.id);
      email = row.email_status === 'kuldve'
        ? { status: 'kuldve', error: null, alreadySent: true }
        : await emailWorksheet(r.id, req.session);
    }
    // 201 = új munkalap jött létre, 200 = meglévő frissült / nem változott
    res.status(r.status === 'created' ? 201 : 200).json({ ...r, email, item: serialize(wsFullById.get(r.id)) });
  }

  // A végpontok, amik a fenti mentést használják ("upload" = előbb a fájlfeltöltés feldolgozása).
  api.put('/worksheets/:id', upload, (req, res) => handleSave(req, res, req.params.id));
  api.post('/worksheets', upload, (req, res) => handleSave(req, res, req.body.id || undefined));

  // E-mail (újra)küldése. Body: { to } – ha nincs megadva, az ügyfél e-mail címére megy.
  api.post('/worksheets/:id/email', async (req, res) => {
    getRow(req.params.id);
    const result = await emailWorksheet(req.params.id, req.session, req.body.to);
    res.status(result.status === 'kuldve' ? 200 : 422).json({ ...result, item: serialize(wsFullById.get(req.params.id)) });
  });

  // Munkalap módosítása (webes felület és app). Body: { data: { ugyfel, helyszin, km, ... } }
  // Csak a MODOSITHATO_MEZOK változhatnak; a DRI szám és az aláírások maradnak.
  // A régi változat és a régi PDF megmarad, az új PDF-et a szerver készíti el.
  api.put('/worksheets/:id/modositas', async (req, res) => {
    const row = getRow(req.params.id);
    if (row.deleted) throw new HttpError(400, 'Törölt munkalapot nem lehet módosítani.');
    const uj = req.body.data;
    if (!uj || typeof uj !== 'object' || Array.isArray(uj)) throw new HttpError(400, 'Hiányzik a módosított adat ("data").');
    const data = JSON.parse(row.data);
    for (const k of MODOSITHATO_MEZOK) {
      if (uj[k] !== undefined) data[k] = uj[k] === null ? '' : String(uj[k]).slice(0, 5000);
    }
    const r = saveWorksheet(req.session, { id: row.id, data, baseVersion: req.body.baseVersion });
    if (r.status === 'updated' && r.adatValtozott) await modositottPdf(row.id);
    res.json({ ...r, item: serialize(wsFullById.get(row.id)) });
  });

  // Az eredeti és a módosított változatok listája (a PDF-ek a következő végponton érhetők el).
  api.get('/worksheets/:id/valtozatok', async (req, res) => {
    await pdfPotlas(getRow(req.params.id).id);
    const row = getRow(req.params.id);
    res.json(valtozatok(row).map(({ _pdfFajl, ...v }) => v));
  });

  // Egy változat PDF-je. n = 0 az eredeti, 1 az első módosítás, ...
  api.get('/worksheets/:id/valtozatok/:n/pdf', async (req, res) => {
    await pdfPotlas(getRow(req.params.id).id);
    valtozatPdfKuldes(res, getRow(req.params.id), req.params.n);
  });

  // Törlés: csak megjelöljük, az adat és a fájlok megmaradnak.
  api.delete('/worksheets/:id', (req, res) => {
    getRow(req.params.id);
    res.json(saveWorksheet(req.session, { id: req.params.id, deleted: true }));
  });

  // Szinkronizálás több eszköz között egyetlen hívással:
  //  - a "changes" tömbben az eszközön offline készült / módosult munkalapok jönnek fel (fájlok nélkül),
  //  - válaszként minden olyan munkalap visszajön, ami a "since" kurzor óta változott
  //    (bárki, bármelyik eszközről), plusz az új kurzor, amit az app eltárol a következő híváshoz.
  api.post('/sync', (req, res) => {
    const changes = Array.isArray(req.body.changes) ? req.body.changes : [];
    const since = Math.max(parseInt(req.body.since, 10) || 0, 0);
    const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 500, 1), 2000);

    const results = changes.map((c) => {
      try {
        if (!c || typeof c.id !== 'string') throw new HttpError(400, 'Minden változásnak kell "id".');
        return saveWorksheet(req.session, { id: c.id, data: c.data, deleted: !!c.deleted, baseVersion: c.baseVersion });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return { id: c && c.id, status: 'error', error: err.message };
      }
    });

    const rows = wsSince.all(since, limit + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(serialize);
    const cursor = items.length ? items[items.length - 1].seq : since;
    res.json({ results, items, cursor, hasMore });
  });

  // DRI munkalapszám lefoglalása. Body: { worksheetId } – az app az új munkalap megnyitásakor kéri,
  // hogy a szám már kitöltés közben látsszon (szerkeszteni nem lehet). Ugyanarra a munkalapra
  // többször kérve mindig ugyanazt a számot adja.
  api.post('/dri/foglalas', (req, res) => {
    const worksheetId = req.body.worksheetId;
    checkId(worksheetId);
    const existing = stmt.wsById.get(worksheetId);
    if (existing && !stmt.foglalasByWs.get(worksheetId)) {
      // Régi munkalap, aminek még kézzel beírt száma van: azt adjuk vissza.
      return res.json({ worksheetId, driSzam: JSON.parse(existing.data).driSzam || null });
    }
    const szam = driFoglalas(req.session, worksheetId);
    res.json({ worksheetId, driSzam: formatDri(szam) });
  });

  // Ismeretlen /api/... cím -> 404
  api.use((req, res) => res.status(404).json({ error: 'Nincs ilyen végpont.' }));

  // ===========================================================================
  // ADMIN FELÜLET (/api/admin/...)
  // ===========================================================================
  // Csak az ADMIN_EMAILS-ben (.env) felsorolt e-mail címekkel lehet belépni, saját jelszóval.
  // A jelszót a VPS-en, konzolból kell beállítani (node src/admin-jelszo.js <email>) – a weben nem lehet,
  // így aki csak az e-mail címet tudja, nem tud jelszót adni magának. Belépés után az admin
  // a saját jelszavát megváltoztathatja. Az admin belépés 12 óráig érvényes.
  function adminRouter() {
    const r = express.Router();
    const ADMIN_ERVENYES = 12 * 3600 * 1000; // 12 óra
    const sikertelen = new Map(); // e-mail -> { db, eddig } – túl sok hibás jelszó esetén 15 percre letilt

    const st = {
      sessionUj: db.prepare('INSERT INTO admin_sessions(token, email, created_at, expires_at) VALUES (?, ?, ?, ?)'),
      session: db.prepare('SELECT * FROM admin_sessions WHERE token = ? AND expires_at > ?'),
      sessionTorles: db.prepare('DELETE FROM admin_sessions WHERE token = ?'),
      lejartTorles: db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?'),
    };

    // Jelszó ellenőrzése / mentése (src/adminjelszo.js – ugyanazt használja a konzolos parancs is).
    const jelszoJo = (email, jelszo) => adminJelszo.jelszoJo(db, email, jelszo);
    const jelszoBeallit = (email, jelszo) => {
      try {
        adminJelszo.jelszoMentes(db, email, jelszo, now());
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    };
    const ujSession = (email) => {
      const token = crypto.randomBytes(24).toString('base64url');
      const t = now();
      st.lejartTorles.run(t);
      st.sessionUj.run(token, email, t, t + ADMIN_ERVENYES);
      return token;
    };

    // Belépés: { email, jelszo }. Ha az adminnak még nincs jelszava, ugyanúgy "hibás" a válasz
    // (így kívülről nem derül ki, melyik cím admin és melyik nem).
    r.post('/belepes', (req, res) => {
      const email = normalizeEmail(req.body.email);
      const tilt = email && sikertelen.get(email);
      if (tilt && tilt.db >= 10 && tilt.eddig > now()) {
        throw new HttpError(429, 'Túl sok sikertelen próbálkozás. Próbáld újra 15 perc múlva.');
      }
      if (!email || !adminEmails.includes(email)) throw new HttpError(401, 'Hibás e-mail cím vagy jelszó.');
      if (!jelszoJo(email, req.body.jelszo)) {
        const x = sikertelen.get(email) || { db: 0, eddig: 0 };
        sikertelen.set(email, { db: x.db + 1, eddig: now() + 15 * 60 * 1000 });
        naplo('admin_hibas_jelszo', { ki: email });
        throw new HttpError(401, 'Hibás e-mail cím vagy jelszó.');
      }
      sikertelen.delete(email);
      naplo('admin_belepes', { ki: email });
      res.json({ token: ujSession(email), email });
    });

    // Innentől minden admin végponthoz érvényes admin belépés kell
    // ("Authorization: Bearer <token>", fájl letöltésnél "?token=" is lehet).
    r.use((req, res, next) => {
      const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      const token = m ? m[1].trim() : (req.method === 'GET' && typeof req.query.token === 'string' ? req.query.token : null);
      const s = token && st.session.get(token, now());
      if (!s || !adminEmails.includes(s.email)) throw new HttpError(401, 'Admin belépés szükséges.');
      req.admin = s;
      next();
    });

    r.get('/me', (req, res) => res.json({ email: req.admin.email, lejar: iso(req.admin.expires_at) }));

    r.post('/kilepes', (req, res) => {
      st.sessionTorles.run(req.admin.token);
      res.json({ ok: true });
    });

    // Jelszócsere: { regi, uj }
    r.post('/jelszo', (req, res) => {
      if (!jelszoJo(req.admin.email, req.body.regi)) throw new HttpError(400, 'A jelenlegi jelszó nem jó.');
      jelszoBeallit(req.admin.email, req.body.uj);
      naplo('admin_jelszo', { ki: req.admin.email, megjegyzes: 'Jelszó megváltoztatva' });
      res.json({ ok: true });
    });

    // Időszak a lekérdezésekhez: from / to (ÉÉÉÉ-HH-NN, a "to" napot is beleértve).
    const idoszak = (q) => {
      const from = q.from ? dayStart(String(q.from)) : null;
      const to = q.to ? dayStart(String(q.to)) : null;
      if ((q.from && from === null) || (q.to && to === null)) throw new HttpError(400, 'A dátum formátuma: ÉÉÉÉ-HH-NN.');
      return { from: from ?? 0, to: to !== null ? to + 24 * 3600 * 1000 : 8640000000000000 };
    };

    // Az időszakban rögzített (nem törölt) munkalapok a rögzítő e-mail címével.
    const munkalapokIdoszakban = db.prepare(`
      SELECT w.*, u.email AS created_by_email FROM worksheets w JOIN users u ON u.id = w.created_by
      WHERE w.deleted = 0 AND w.created_at >= ? AND w.created_at < ? ORDER BY w.created_at`);

    // Áttekintés: darabszámok, napi bontás, felhasználónkénti összesítés.
    r.get('/attekintes', (req, res) => {
      const { from, to } = idoszak(req.query);
      const sorok = munkalapokIdoszakban.all(from, to);
      const esemeny = db.prepare('SELECT tipus, COUNT(*) AS db FROM naplo WHERE ts >= ? AND ts < ? GROUP BY tipus').all(from, to);
      const esemenyDb = Object.fromEntries(esemeny.map((e) => [e.tipus, e.db]));
      const napok = {};
      const emberek = {};
      for (const w of sorok) {
        const d = new Date(w.created_at);
        const nap = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        napok[nap] = (napok[nap] || 0) + 1;
        const e = emberek[w.created_by_email] || (emberek[w.created_by_email] = { email: w.created_by_email, munkalap: 0, utolso: 0 });
        e.munkalap++;
        e.utolso = Math.max(e.utolso, w.created_at);
      }
      res.json({
        munkalapok: sorok.length,
        modositasok: esemenyDb.modositas || 0,
        torlesek: esemenyDb.torles || 0,
        emailek: esemenyDb.email || 0,
        aktivFelhasznalok: Object.keys(emberek).length,
        napiBontas: Object.entries(napok).map(([nap, db]) => ({ nap, db })),
        emberek: Object.values(emberek).sort((a, b) => b.munkalap - a.munkalap).map((e) => ({ ...e, utolso: iso(e.utolso) })),
      });
    });

    // Km statisztika: összes km, emberenként, helyszínenként (az időszakban rögzített munkalapokból).
    r.get('/statisztika', (req, res) => {
      const { from, to } = idoszak(req.query);
      const sorok = munkalapokIdoszakban.all(from, to);
      let osszKm = 0;
      const emberek = {};
      const helyszinek = {};
      const ertelmezhetetlen = [];
      for (const w of sorok) {
        const data = JSON.parse(w.data);
        const km = kmErtek(data.km);
        if (km === null && data.km) ertelmezhetetlen.push({ id: w.id, driSzam: w.munkalapszam, km: data.km, ki: w.created_by_email });
        const k = km || 0;
        osszKm += k;
        const e = emberek[w.created_by_email] || (emberek[w.created_by_email] = { email: w.created_by_email, km: 0, munkalap: 0 });
        e.km += k;
        e.munkalap++;
        const hNev = (w.helyszin || '').trim() || '(nincs megadva)';
        const hKulcs = hNev.toLocaleLowerCase('hu');
        const h = helyszinek[hKulcs] || (helyszinek[hKulcs] = { helyszin: hNev, munkalap: 0, km: 0, kik: new Set(), utolso: 0 });
        h.munkalap++;
        h.km += k;
        h.kik.add(w.created_by_email);
        h.utolso = Math.max(h.utolso, w.created_at);
      }
      const kerekit = (x) => Math.round(x * 10) / 10;
      res.json({
        osszKm: kerekit(osszKm),
        munkalapok: sorok.length,
        emberek: Object.values(emberek).sort((a, b) => b.km - a.km).map((e) => ({ ...e, km: kerekit(e.km) })),
        helyszinek: Object.values(helyszinek).sort((a, b) => b.munkalap - a.munkalap)
          .map((h) => ({ helyszin: h.helyszin, munkalap: h.munkalap, km: kerekit(h.km), kik: [...h.kik], utolso: iso(h.utolso) })),
        ertelmezhetetlenKm: ertelmezhetetlen,
      });
    });

    // Napló: események időrendben (legújabb elöl), módosításnál a változott mezők előtte / utána.
    // Szűrők: from, to, tipus (letrehozas, modositas, torles, visszaallitas, email, admin_belepes ...), q (DRI szám / e-mail / ügyfél)
    r.get('/naplo', (req, res) => {
      const { from, to } = idoszak(req.query);
      const where = ['n.ts >= @from', 'n.ts < @to'];
      const params = { from, to };
      if (req.query.tipus) { where.push('n.tipus = @tipus'); params.tipus = String(req.query.tipus); }
      if (req.query.q) {
        where.push("(ulower(n.ki) LIKE @q ESCAPE '\\' OR ulower(w.munkalapszam) LIKE @q ESCAPE '\\' OR ulower(w.ugyfel) LIKE @q ESCAPE '\\')");
        params.q = `%${escapeLike(String(req.query.q).trim().toLocaleLowerCase('hu'))}%`;
      }
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const alap = `FROM naplo n LEFT JOIN worksheets w ON w.id = n.worksheet_id WHERE ${where.join(' AND ')}`;
      const total = db.prepare(`SELECT COUNT(*) AS db ${alap}`).get(params).db;
      const sorok = db.prepare(`
        SELECT n.*, w.munkalapszam, w.ugyfel,
          (SELECT COUNT(*) FROM naplo n2 WHERE n2.worksheet_id = n.worksheet_id AND n2.tipus = 'modositas' AND n2.id <= n.id) AS mod_sorszam
        ${alap} ORDER BY n.id DESC LIMIT ${limit} OFFSET ${offset}`).all(params);
      res.json({
        total,
        items: sorok.map((n) => ({
          id: n.id,
          ts: iso(n.ts),
          tipus: n.tipus,
          ki: n.ki,
          worksheetId: n.worksheet_id,
          driSzam: n.munkalapszam,
          ugyfel: n.ugyfel,
          megjegyzes: n.megjegyzes,
          // Módosításnál: melyik változat előtte (sorszám-1) és utána (sorszám) – a PDF-ekhez
          valtozat: n.tipus === 'modositas' ? n.mod_sorszam : null,
          elottePdf: !!n.elotte_pdf, // van-e PDF a módosítás előtti változathoz
          valtozasok: n.tipus === 'modositas' ? kulonbsegek(JSON.parse(n.elotte), JSON.parse(n.utana)) : [],
        })),
      });
    });

    // Egy munkalap változatai és PDF-jei az adminnak (ugyanaz, mint a sima felületen).
    r.get('/munkalap/:id/valtozatok', async (req, res) => {
      await pdfPotlas(getRow(req.params.id).id);
      const row = getRow(req.params.id);
      res.json({ item: serialize(row), valtozatok: valtozatok(row).map(({ _pdfFajl, ...v }) => v) });
    });
    r.get('/munkalap/:id/valtozatok/:n/pdf', async (req, res) => {
      await pdfPotlas(getRow(req.params.id).id);
      valtozatPdfKuldes(res, getRow(req.params.id), req.params.n);
    });

    // Törölt munkalapok listája és visszaállítás.
    r.get('/torolt', (req, res) => {
      const sorok = db.prepare(`${SELECT_WS} WHERE w.deleted = 1 ORDER BY w.updated_at DESC`).all();
      res.json(sorok.map(serialize));
    });
    r.post('/visszaallitas/:id', (req, res) => {
      const row = getRow(req.params.id);
      if (!row.deleted) throw new HttpError(400, 'Ez a munkalap nincs törölve.');
      // Az admin műveletet egy (szükség esetén létrehozott) felhasználóhoz kötjük az admin e-mail címével.
      let u = stmt.userByEmail.get(req.admin.email);
      if (!u) {
        const info = stmt.insertUser.run({ email: req.admin.email, name: null, now: now() });
        u = { id: Number(info.lastInsertRowid) };
      }
      saveWorksheet({ user_id: u.id, device_id: null, user_email: req.admin.email }, { id: row.id, deleted: false });
      res.json(serialize(wsFullById.get(row.id)));
    });

    // Felhasználók: munkalapok száma, utolsó aktivitás, eszközök.
    r.get('/felhasznalok', (req, res) => {
      const sorok = db.prepare(`
        SELECT u.id, u.email, u.created_at, u.last_seen,
          (SELECT COUNT(*) FROM worksheets w WHERE w.created_by = u.id AND w.deleted = 0) AS munkalap,
          (SELECT GROUP_CONCAT(COALESCE(d.name, d.id), ' | ') FROM devices d WHERE d.last_user_id = u.id) AS eszkozok
        FROM users u ORDER BY u.last_seen DESC`).all();
      res.json(sorok.map((u) => ({
        email: u.email, munkalap: u.munkalap, eszkozok: u.eszkozok || '',
        elsoBelepes: iso(u.created_at), utolsoAktivitas: iso(u.last_seen), admin: adminEmails.includes(u.email),
      })));
    });

    // CSV export az időszak munkalapjairól (Excelben megnyitható: pontosvesszővel elválasztva, UTF-8).
    r.get('/export.csv', (req, res) => {
      const { from, to } = idoszak(req.query);
      const sorok = munkalapokIdoszakban.all(from, to);
      const fej = ['DRI szám', 'Rögzítve', 'Rögzítette', 'Ügyfél', 'Ügyfél e-mail', 'Helyszín', 'Gép', 'Időtartam', 'Km', 'Km (szám)', 'Elvégzett munka', 'Hiba leírása', 'Hely, dátum', 'Módosítások', 'E-mail'];
      const cella = (v) => {
        const x = v === undefined || v === null ? '' : String(v);
        return /[";\n\r]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x;
      };
      const modDb = db.prepare("SELECT COUNT(*) AS db FROM naplo WHERE worksheet_id = ? AND tipus = 'modositas'");
      const sorokCsv = sorok.map((w) => {
        const d = JSON.parse(w.data);
        return [d.driSzam, new Date(w.created_at).toLocaleString('hu-HU'), w.created_by_email, d.ugyfel, d.ugyfelEmail, d.helyszin,
          d.gep, d.idotartam, d.km, kmErtek(d.km) ?? '', d.elvegzettMunka, d.hibaLeiras, d.datum, modDb.get(w.id).db, w.email_status]
          .map(cella).join(';');
      });
      res.type('text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="munkalapok_${req.query.from || 'kezdet'}_${req.query.to || 'ma'}.csv"`);
      res.send('﻿' + [fej.join(';'), ...sorokCsv].join('\r\n'));
    });

    return r;
  }

  app.use('/api/admin', adminRouter());
  app.use('/api', api);
  // Minden más cím: a böngészős felület fájljai a public mappából (index.html).
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Hibakezelő: minden hibát JSON-ként küld vissza { "error": "..." } formában.
  // Az ismeretlen hibák (programhiba) a szerver naplójába kerülnek: journalctl -u munkalap
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Túl nagy kérés vagy fájl.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás JSON.' });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Hibás fájlfeltöltés: ${err.message}` });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Szerverhiba.' });
  });

  return app;
}

module.exports = { createApp, extractSearchFields, formatDri, kmErtek, kulonbsegek };
