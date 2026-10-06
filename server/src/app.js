'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');

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

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function extractSearchFields(data) {
  const out = {};
  for (const [col, key] of Object.entries(SEARCH_FIELDS)) {
    const v = data[key];
    out[col] = v === undefined || v === null || v === '' || typeof v === 'object' ? null : String(v).trim() || null;
  }
  return out;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLocaleLowerCase('hu');
  return e.length <= 200 && EMAIL_PATTERN.test(e) ? e : null;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// "2026-10-06" -> az adott nap kezdete (a szerver időzónájában), ezredmásodpercben
function dayStart(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? null : t;
}

function parseJsonField(v) {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    throw new HttpError(400, 'A "data" mező nem érvényes JSON.');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createApp(db, options = {}) {
  const appKey = options.appKey || null;
  const now = options.now || (() => Date.now());
  const filesDir = options.filesDir || path.join(process.cwd(), 'data', 'files');
  const sendMail = options.sendMail || null; // async (message) => {}, nodemailer kompatibilis üzenettel
  const mailFrom = options.mailFrom || null;

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
    users: db.prepare(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_seen,
        (SELECT COUNT(*) FROM worksheets w WHERE w.created_by = u.id AND w.deleted = 0) AS worksheet_count
      FROM users u ORDER BY u.email`),
  };

  const SELECT_WS = `
    SELECT w.*, cu.email AS created_by_email, cu.name AS created_by_name,
      uu.email AS updated_by_email, uu.name AS updated_by_name, d.name AS device_name
    FROM worksheets w
    JOIN users cu ON cu.id = w.created_by
    JOIN users uu ON uu.id = w.updated_by
    LEFT JOIN devices d ON d.id = w.device_id`;
  const wsFullById = db.prepare(`${SELECT_WS} WHERE w.id = ?`);
  const wsSince = db.prepare(`${SELECT_WS} WHERE w.seq > ? ORDER BY w.seq LIMIT ?`);

  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const person = (id, email, name) => ({ id, email, name: name || null });

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

  function checkId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new HttpError(400, 'Érvénytelen munkalap azonosító (csak betű, szám, - és _ lehet benne).');
    }
  }

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
    const json = JSON.stringify(data);
    const del = deleted ? 1 : 0;
    const t = now();
    const flags = fileFlags(existing, uploaded);

    if (existing && existing.data === json && existing.deleted === del) {
      // Ugyanaz az adat (pl. az app újrapróbálta a feltöltést): új változat nem kell, csak a fájlok frissülnek.
      stmt.updateFileFlags.run({ id: existing.id, ...flags });
      return { id: existing.id, version: existing.version, seq: existing.seq, status: 'unchanged', conflict: false };
    }

    const params = {
      id: id || crypto.randomUUID(),
      seq: stmt.nextSeq.get().value,
      userId: session.user_id,
      deviceId: session.device_id,
      data: json,
      deleted: del,
      now: t,
      ...flags,
      ...extractSearchFields(data),
    };

    if (!existing) {
      stmt.insertWs.run(params);
      return { id: params.id, version: 1, seq: params.seq, status: 'created', conflict: false };
    }

    stmt.archiveWs.run({ ...existing, archivedAt: t });
    stmt.updateWs.run(params);
    const conflict = baseVersion !== null && baseVersion !== undefined && baseVersion !== ''
      && Number(baseVersion) < existing.version;
    return { id: existing.id, version: existing.version + 1, seq: params.seq, status: 'updated', conflict };
  });

  // A munkalap PDF-jének elküldése e-mailben az ügyfélnek (vagy a megadott címre), másolatban a felhasználónak.
  async function emailWorksheet(id, session, to) {
    const row = stmt.wsById.get(id);
    const cimzett = to ? normalizeEmail(to) : normalizeEmail(row.ugyfel_email || '');
    if (!cimzett) {
      return { status: row.email_status, error: to ? 'Érvénytelen e-mail cím.' : 'Nincs megadva érvényes ügyfél e-mail cím.' };
    }
    const setStatus = (status, error) => {
      stmt.setEmailStatus.run({ id, status, error, sentAt: status === 'kuldve' ? now() : row.email_sent_at });
      return { status, error, to: cimzett };
    };
    if (!row.has_pdf) return setStatus('hiba', 'Nincs feltöltött PDF ehhez a munkalaphoz.');
    if (!sendMail || !mailFrom) return setStatus('hiba', 'Az e-mail küldés nincs beállítva a szerveren.');

    const szam = row.munkalapszam || '';
    try {
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
      return setStatus('kuldve', null);
    } catch (err) {
      console.error('E-mail küldési hiba:', err.message);
      return setStatus('hiba', String(err.message || err).slice(0, 500));
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: options.bodyLimit || '25mb' }));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: options.fileLimit || 20 * 1024 * 1024, files: Object.keys(FILES).length },
  }).fields(Object.keys(FILES).map((name) => ({ name, maxCount: 1 })));
  app.use((req, res, next) => {
    if (!req.body || typeof req.body !== 'object') req.body = {};
    next();
  });

  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true }));
  api.get('/config', (req, res) => res.json({ appKeyRequired: !!appKey, emailEnabled: !!(sendMail && mailFrom) }));

  // Bejelentkezés csak e-mail címmel: ha még nincs ilyen felhasználó, létrehozzuk.
  api.post('/login', (req, res) => {
    if (appKey && (req.get('x-app-key') || req.body.appKey) !== appKey) {
      throw new HttpError(401, 'Hibás alkalmazáskulcs.');
    }
    const email = normalizeEmail(req.body.email);
    if (!email) throw new HttpError(400, 'Adj meg egy érvényes e-mail címet.');
    const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 100) || null : null;
    const deviceId = typeof req.body.deviceId === 'string' && req.body.deviceId.trim()
      ? req.body.deviceId.trim().slice(0, 100) : null;
    const deviceName = typeof req.body.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 100) || null : null;

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

  api.get('/me', (req, res) => {
    const s = req.session;
    res.json({ user: { id: s.user_id, email: s.user_email, name: s.user_name }, deviceId: s.device_id });
  });

  api.post('/logout', (req, res) => {
    stmt.deleteSession.run(req.session.token);
    res.json({ ok: true });
  });

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
    const where = [];
    const params = {};
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const cols = ['w.munkalapszam', 'w.ugyfel', 'w.ugyfel_email', 'w.helyszin', 'w.gep', 'w.data'];
      where.push(`(${cols.map((c) => `ulower(${c}) LIKE @q ESCAPE '\\'`).join(' OR ')})`);
      params.q = `%${escapeLike(q.toLocaleLowerCase('hu'))}%`;
    }
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
    const from = req.query.from ? dayStart(String(req.query.from)) : null;
    const to = req.query.to ? dayStart(String(req.query.to)) : null;
    if (req.query.from && from === null) throw new HttpError(400, 'A "from" dátum formátuma: ÉÉÉÉ-HH-NN.');
    if (req.query.to && to === null) throw new HttpError(400, 'A "to" dátum formátuma: ÉÉÉÉ-HH-NN.');
    if (from !== null) { where.push('w.created_at >= @from'); params.from = from; }
    if (to !== null) { where.push('w.created_at < @to'); params.to = to + 24 * 3600 * 1000; }
    if (req.query.device) { where.push('w.device_id = @device'); params.device = String(req.query.device); }
    if (!['1', 'true'].includes(String(req.query.includeDeleted))) where.push('w.deleted = 0');

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM worksheets w JOIN users cu ON cu.id = w.created_by ${whereSql}`).get(params).n;
    const rows = db.prepare(`${SELECT_WS} ${whereSql} ORDER BY w.created_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params);
    res.json({ total, limit, offset, items: rows.map(serialize) });
  });

  function getRow(id) {
    const row = wsFullById.get(id);
    if (!row) throw new HttpError(404, 'Nincs ilyen munkalap.');
    return row;
  }

  api.get('/worksheets/:id', (req, res) => res.json(serialize(getRow(req.params.id))));

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
  api.get('/worksheets/:id/files/:kind', (req, res) => {
    const row = getRow(req.params.id);
    const f = Object.prototype.hasOwnProperty.call(FILES, req.params.kind) && FILES[req.params.kind];
    if (!f || !row[f.column]) throw new HttpError(404, 'Nincs ilyen fájl.');
    const name = req.params.kind === 'pdf' ? `Munkalap_DRI_${row.munkalapszam || row.id}.pdf` : f.file;
    res.type(f.type);
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
    const r = db.transaction(() => {
      const saved = saveWorksheet(req.session, { id, data, baseVersion: req.body.baseVersion, uploaded });
      writeFiles(saved.id, uploaded);
      return saved;
    })();

    let email = null;
    if (['1', 'true', true].includes(req.body.kuldes)) {
      const row = stmt.wsById.get(r.id);
      email = row.email_status === 'kuldve'
        ? { status: 'kuldve', error: null, alreadySent: true }
        : await emailWorksheet(r.id, req.session);
    }
    res.status(r.status === 'created' ? 201 : 200).json({ ...r, email, item: serialize(wsFullById.get(r.id)) });
  }

  api.put('/worksheets/:id', upload, (req, res) => handleSave(req, res, req.params.id));
  api.post('/worksheets', upload, (req, res) => handleSave(req, res, req.body.id || undefined));

  // E-mail (újra)küldése. Body: { to } – ha nincs megadva, az ügyfél e-mail címére megy.
  api.post('/worksheets/:id/email', async (req, res) => {
    getRow(req.params.id);
    const result = await emailWorksheet(req.params.id, req.session, req.body.to);
    res.status(result.status === 'kuldve' ? 200 : 422).json({ ...result, item: serialize(wsFullById.get(req.params.id)) });
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

  api.use((req, res) => res.status(404).json({ error: 'Nincs ilyen végpont.' }));

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

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

module.exports = { createApp, extractSearchFields };
