'use strict';

// =============================================================================
// A SZERVER INDÍTÁSA
// =============================================================================
// Ezt futtatja a VPS-en a "munkalap" szolgáltatás (systemd): node src/index.js
// A beállításokat környezeti változókból olvassa, ezek a /opt/munkalap/.env fájlban vannak
// (APP_KEY, SMTP_USER, SMTP_PASS ...). Módosítás után: systemctl restart munkalap
// =============================================================================

const path = require('path');
const nodemailer = require('nodemailer');
const { openDb } = require('./db');
const { createApp } = require('./app');

// --- Beállítások (ha nincs megadva, az alapértelmezett érték érvényes) ---
const PORT = Number(process.env.PORT) || 3000; // ezen a porton fut (a Caddy ide továbbít)
const HOST = process.env.HOST || '0.0.0.0'; // 127.0.0.1 = csak a VPS-ről érhető el (a Caddy-n át)
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'munkalap.db'); // az adatbázis fájl
const FILES_DIR = process.env.FILES_DIR || path.join(DATA_DIR, 'files'); // PDF-ek és aláírások mappája

// E-mail küldés (pl. Gmail: SMTP_USER = a gmail cím, SMTP_PASS = alkalmazásjelszó).
// Ha nincs megadva, a sendMail null marad, és az e-mail küldés ki van kapcsolva.
let sendMail = null;
const mailFrom = process.env.MAIL_FROM
  || (process.env.SMTP_USER ? `"${process.env.MAIL_FROM_NAME || 'DR Industrie Szerviz'}" <${process.env.SMTP_USER}>` : null);
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  const port = Number(process.env.SMTP_PORT) || 465;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  sendMail = (message) => transport.sendMail(message);
}

// Adatbázis megnyitása és a szerver létrehozása (app.js).
// DRI_KEZDO: az első kiosztandó munkalapszám (csak az adatbázis első létrehozásakor számít).
const db = openDb(DB_FILE, { driKezdo: Number(process.env.DRI_KEZDO) || 2001 });
const app = createApp(db, {
  appKey: process.env.APP_KEY || null,
  bodyLimit: process.env.BODY_LIMIT || '25mb',
  filesDir: FILES_DIR,
  sendMail,
  mailFrom,
});

// Indítás. Az üzenetek a naplóban látszanak: journalctl -u munkalap -n 20
const server = app.listen(PORT, HOST, () => {
  console.log(`Munkalap szerver fut: http://${HOST}:${PORT} (adatbázis: ${DB_FILE}, fájlok: ${FILES_DIR})`);
  if (!process.env.APP_KEY) console.warn('Figyelem: APP_KEY nincs beállítva, bárki bejelentkezhet, aki eléri a szervert.');
  if (!sendMail) console.warn('Figyelem: SMTP_USER / SMTP_PASS nincs beállítva, e-mail küldés kikapcsolva.');
});

// Leállításkor (systemctl stop / restart) szépen lezárjuk az adatbázist, hogy ne sérüljön.
function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
