'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

// A munkalap JSON-jából ezeket a mezőket emeljük ki külön oszlopba a kereséshez.
// Több lehetséges kulcsnevet is elfogadunk, mert az app mezőnevei eltérhetnek.
const SEARCH_FIELDS = {
  munkalapszam: ['munkalapszam', 'munkalapSzam', 'munkalap_szam', 'szam', 'sorszam', 'number'],
  ugyfel: ['ugyfel', 'ugyfelNev', 'ugyfel_nev', 'ugyfelnev', 'megrendelo', 'customer', 'customerName'],
  datum: ['datum', 'date', 'kelt', 'munkavegzesDatuma'],
  allapot: ['allapot', 'statusz', 'status', 'state'],
};

const MAX_NAME_LENGTH = 60;

function pickField(data, keys) {
  for (const key of keys) {
    const v = data[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'object') {
      if (typeof v.nev === 'string') return v.nev;
      if (typeof v.name === 'string') return v.name;
      continue;
    }
    return String(v);
  }
  return null;
}

function extractSearchFields(data) {
  const out = {};
  for (const [col, keys] of Object.entries(SEARCH_FIELDS)) out[col] = pickField(data, keys);
  return out;
}

function normalizeName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n || n.length > MAX_NAME_LENGTH) return null;
  return n;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
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

  const stmt = {
    userByName: db.prepare('SELECT * FROM users WHERE name_key = ulower(?)'),
    insertUser: db.prepare('INSERT INTO users(name, name_key, created_at, last_seen) VALUES (@name, ulower(@name), @now, @now)'),
    touchUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    upsertDevice: db.prepare(`
      INSERT INTO devices(id, name, last_user_id, created_at, last_seen) VALUES (@id, @name, @userId, @now, @now)
      ON CONFLICT(id) DO UPDATE SET name = COALESCE(@name, name), last_user_id = @userId, last_seen = @now`),
    insertSession: db.prepare('INSERT INTO sessions(token, user_id, device_id, created_at, last_seen) VALUES (?, ?, ?, ?, ?)'),
    sessionByToken: db.prepare(`
      SELECT s.token, s.device_id, u.id AS user_id, u.name AS user_name
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    nextSeq: db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'seq' RETURNING value"),
    wsById: db.prepare('SELECT * FROM worksheets WHERE id = ?'),
    insertWs: db.prepare(`
      INSERT INTO worksheets(id, seq, version, created_by, updated_by, device_id, munkalapszam, ugyfel, datum, allapot, data, deleted, created_at, updated_at)
      VALUES (@id, @seq, 1, @userId, @userId, @deviceId, @munkalapszam, @ugyfel, @datum, @allapot, @data, @deleted, @now, @now)`),
    updateWs: db.prepare(`
      UPDATE worksheets SET seq = @seq, version = version + 1, updated_by = @userId, device_id = @deviceId,
        munkalapszam = @munkalapszam, ugyfel = @ugyfel, datum = @datum, allapot = @allapot,
        data = @data, deleted = @deleted, updated_at = @now
      WHERE id = @id`),
    archiveWs: db.prepare(`
      INSERT INTO worksheet_history(worksheet_id, version, updated_by, device_id, data, deleted, updated_at, archived_at)
      VALUES (@id, @version, @updated_by, @device_id, @data, @deleted, @updated_at, @archivedAt)`),
    history: db.prepare(`
      SELECT h.*, u.name AS updated_by_name FROM worksheet_history h
      JOIN users u ON u.id = h.updated_by WHERE h.worksheet_id = ? ORDER BY h.version DESC`),
    users: db.prepare(`
      SELECT u.id, u.name, u.created_at, u.last_seen,
        (SELECT COUNT(*) FROM worksheets w WHERE w.created_by = u.id AND w.deleted = 0) AS worksheet_count
      FROM users u ORDER BY u.name`),
  };

  const SELECT_WS = `
    SELECT w.*, cu.name AS created_by_name, uu.name AS updated_by_name, d.name AS device_name
    FROM worksheets w
    JOIN users cu ON cu.id = w.created_by
    JOIN users uu ON uu.id = w.updated_by
    LEFT JOIN devices d ON d.id = w.device_id`;
  const wsFullById = db.prepare(`${SELECT_WS} WHERE w.id = ?`);
  const wsSince = db.prepare(`${SELECT_WS} WHERE w.seq > ? ORDER BY w.seq LIMIT ?`);

  function serialize(row) {
    return {
      id: row.id,
      version: row.version,
      seq: row.seq,
      munkalapszam: row.munkalapszam,
      ugyfel: row.ugyfel,
      datum: row.datum,
      allapot: row.allapot,
      deleted: !!row.deleted,
      createdBy: { id: row.created_by, name: row.created_by_name },
      updatedBy: { id: row.updated_by, name: row.updated_by_name },
      device: row.device_id ? { id: row.device_id, name: row.device_name } : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      data: JSON.parse(row.data),
    };
  }

  // Egy munkalap mentése (új vagy meglévő). Ha a munkalapot közben más is módosította
  // (baseVersion < aktuális verzió), a mentés megtörténik, de "conflict: true" jelzéssel,
  // az előző változat pedig a history táblába kerül.
  const saveWorksheet = db.transaction((session, { id, data, deleted = false, baseVersion = null }) => {
    if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 100)) {
      throw new HttpError(400, 'Érvénytelen munkalap azonosító.');
    }
    const existing = id ? stmt.wsById.get(id) : null;
    if (data === undefined && existing) data = JSON.parse(existing.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new HttpError(400, 'A munkalap adatának ("data") JSON objektumnak kell lennie.');
    }
    const json = JSON.stringify(data);
    const del = deleted ? 1 : 0;
    const t = now();

    if (existing && existing.data === json && existing.deleted === del) {
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
      ...extractSearchFields(data),
    };

    if (!existing) {
      stmt.insertWs.run(params);
      return { id: params.id, version: 1, seq: params.seq, status: 'created', conflict: false };
    }

    stmt.archiveWs.run({ ...existing, archivedAt: t });
    stmt.updateWs.run(params);
    const conflict = baseVersion !== null && baseVersion !== undefined && Number(baseVersion) < existing.version;
    return { id: existing.id, version: existing.version + 1, seq: params.seq, status: 'updated', conflict };
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: options.bodyLimit || '25mb' }));
  app.use((req, res, next) => {
    if (!req.body || typeof req.body !== 'object') req.body = {};
    next();
  });

  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true }));
  api.get('/config', (req, res) => res.json({ appKeyRequired: !!appKey }));

  // Bejelentkezés csak névvel: ha még nincs ilyen nevű felhasználó, létrehozzuk.
  api.post('/login', (req, res) => {
    if (appKey && (req.get('x-app-key') || req.body.appKey) !== appKey) {
      throw new HttpError(401, 'Hibás alkalmazáskulcs.');
    }
    const name = normalizeName(req.body.name);
    if (!name) throw new HttpError(400, `Add meg a neved (legfeljebb ${MAX_NAME_LENGTH} karakter).`);
    const deviceId = typeof req.body.deviceId === 'string' && req.body.deviceId.trim()
      ? req.body.deviceId.trim().slice(0, 100) : null;
    const deviceName = typeof req.body.deviceName === 'string' ? req.body.deviceName.trim().slice(0, 100) || null : null;

    const result = db.transaction(() => {
      const t = now();
      let user = stmt.userByName.get(name);
      if (!user) {
        const info = stmt.insertUser.run({ name, now: t });
        user = { id: Number(info.lastInsertRowid), name };
      } else {
        stmt.touchUser.run(t, user.id);
      }
      if (deviceId) stmt.upsertDevice.run({ id: deviceId, name: deviceName, userId: user.id, now: t });
      const token = crypto.randomBytes(24).toString('base64url');
      stmt.insertSession.run(token, user.id, deviceId, t, t);
      return { token, user: { id: user.id, name: user.name }, deviceId };
    })();
    res.json(result);
  });

  // Minden további végpont bejelentkezést igényel.
  api.use((req, res, next) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    const session = m && stmt.sessionByToken.get(m[1].trim());
    if (!session) throw new HttpError(401, 'Be kell jelentkezni.');
    const t = now();
    stmt.touchSession.run(t, session.token);
    stmt.touchUser.run(t, session.user_id);
    req.session = session;
    next();
  });

  api.get('/me', (req, res) => {
    res.json({ user: { id: req.session.user_id, name: req.session.user_name }, deviceId: req.session.device_id });
  });

  api.post('/logout', (req, res) => {
    stmt.deleteSession.run(req.session.token);
    res.json({ ok: true });
  });

  api.get('/users', (req, res) => {
    res.json(stmt.users.all().map((u) => ({
      id: u.id,
      name: u.name,
      worksheetCount: u.worksheet_count,
      createdAt: new Date(u.created_at).toISOString(),
      lastSeen: new Date(u.last_seen).toISOString(),
    })));
  });

  // Keresés / listázás.
  // Paraméterek: q (szabad szöveg), user (felhasználó id vagy név), from, to (dátum, pl. 2026-10-01),
  // allapot, device, includeDeleted=1, limit, offset
  api.get('/worksheets', (req, res) => {
    const where = [];
    const params = {};
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      where.push(`(ulower(w.munkalapszam) LIKE @q ESCAPE '\\' OR ulower(w.ugyfel) LIKE @q ESCAPE '\\' OR ulower(w.data) LIKE @q ESCAPE '\\')`);
      params.q = `%${escapeLike(q.toLocaleLowerCase('hu'))}%`;
    }
    if (req.query.user) {
      const u = String(req.query.user);
      if (/^\d+$/.test(u)) {
        where.push('w.created_by = @userId');
        params.userId = Number(u);
      } else {
        where.push('cu.name_key = ulower(@userName)');
        params.userName = u;
      }
    }
    if (req.query.from) { where.push('w.datum >= @from'); params.from = String(req.query.from); }
    if (req.query.to) { where.push('w.datum <= @to'); params.to = String(req.query.to) + '￿'; }
    if (req.query.allapot) { where.push('ulower(w.allapot) = ulower(@allapot)'); params.allapot = String(req.query.allapot); }
    if (req.query.device) { where.push('w.device_id = @device'); params.device = String(req.query.device); }
    if (!['1', 'true'].includes(String(req.query.includeDeleted))) where.push('w.deleted = 0');

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = db.prepare(`SELECT COUNT(*) AS n FROM worksheets w JOIN users cu ON cu.id = w.created_by ${whereSql}`).get(params).n;
    const rows = db.prepare(`${SELECT_WS} ${whereSql} ORDER BY w.datum DESC, w.updated_at DESC LIMIT ${limit} OFFSET ${offset}`).all(params);
    res.json({ total, limit, offset, items: rows.map(serialize) });
  });

  api.get('/worksheets/:id', (req, res) => {
    const row = wsFullById.get(req.params.id);
    if (!row) throw new HttpError(404, 'Nincs ilyen munkalap.');
    res.json(serialize(row));
  });

  api.get('/worksheets/:id/history', (req, res) => {
    res.json(stmt.history.all(req.params.id).map((h) => ({
      version: h.version,
      deleted: !!h.deleted,
      updatedBy: { id: h.updated_by, name: h.updated_by_name },
      deviceId: h.device_id,
      updatedAt: new Date(h.updated_at).toISOString(),
      data: JSON.parse(h.data),
    })));
  });

  // Új munkalap, az azonosítót a szerver adja (ha a body-ban nincs "id").
  api.post('/worksheets', (req, res) => {
    const r = saveWorksheet(req.session, { id: req.body.id, data: req.body.data });
    res.status(r.status === 'created' ? 201 : 200).json({ ...r, item: serialize(wsFullById.get(r.id)) });
  });

  // Létrehozás vagy módosítás az app által generált azonosítóval (ajánlott: UUID).
  api.put('/worksheets/:id', (req, res) => {
    const r = saveWorksheet(req.session, { id: req.params.id, data: req.body.data, baseVersion: req.body.baseVersion });
    res.status(r.status === 'created' ? 201 : 200).json({ ...r, item: serialize(wsFullById.get(r.id)) });
  });

  // Törlés: csak megjelöljük, az adat megmarad (visszaállítható, a history-ban is látszik).
  api.delete('/worksheets/:id', (req, res) => {
    if (!stmt.wsById.get(req.params.id)) throw new HttpError(404, 'Nincs ilyen munkalap.');
    res.json(saveWorksheet(req.session, { id: req.params.id, deleted: true }));
  });

  // Szinkronizálás több eszköz között egyetlen hívással:
  //  - a "changes" tömbben az eszközön offline készült / módosult munkalapok jönnek fel,
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

  app.use('/api', api);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Nincs ilyen végpont.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Túl nagy kérés.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás JSON.' });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Szerverhiba.' });
  });

  return app;
}

module.exports = { createApp, extractSearchFields };
