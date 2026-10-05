'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || './data/munkalap.db';

const db = openDb(DB_FILE);
const app = createApp(db, {
  appKey: process.env.APP_KEY || null,
  bodyLimit: process.env.BODY_LIMIT || '25mb',
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Munkalap szerver fut: http://${HOST}:${PORT} (adatbázis: ${DB_FILE})`);
  if (!process.env.APP_KEY) console.warn('Figyelem: APP_KEY nincs beállítva, bárki bejelentkezhet, aki eléri a szervert.');
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
