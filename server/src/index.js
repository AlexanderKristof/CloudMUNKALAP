'use strict';

const path = require('path');
const nodemailer = require('nodemailer');
const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'munkalap.db');
const FILES_DIR = process.env.FILES_DIR || path.join(DATA_DIR, 'files');

// E-mail küldés (pl. Gmail: SMTP_USER = a gmail cím, SMTP_PASS = alkalmazásjelszó).
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

const db = openDb(DB_FILE);
const app = createApp(db, {
  appKey: process.env.APP_KEY || null,
  bodyLimit: process.env.BODY_LIMIT || '25mb',
  filesDir: FILES_DIR,
  sendMail,
  mailFrom,
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Munkalap szerver fut: http://${HOST}:${PORT} (adatbázis: ${DB_FILE}, fájlok: ${FILES_DIR})`);
  if (!process.env.APP_KEY) console.warn('Figyelem: APP_KEY nincs beállítva, bárki bejelentkezhet, aki eléri a szervert.');
  if (!sendMail) console.warn('Figyelem: SMTP_USER / SMTP_PASS nincs beállítva, e-mail küldés kikapcsolva.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
