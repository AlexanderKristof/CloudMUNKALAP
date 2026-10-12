'use strict';

// =============================================================================
// ADMIN JELSZÓ BEÁLLÍTÁSA A SZERVEREN (konzolból)
// =============================================================================
// Admin jelszót csak itt, a VPS-en lehet adni (első jelszó, vagy ha elfelejtették).
// A weben nem lehet, így aki csak az e-mail címet tudja, nem tud jelszót beállítani.
//
// Használat a VPS-en (WinSCP konzol):
//   cd /opt/munkalap/server && node src/admin-jelszo.js valaki@drindustrie.hu
//
// Kiír egy új, ideiglenes jelszót. Ezzel lehet belépni az admin felületre, és ott a
// "Jelszó" fülön érdemes rögtön sajátra cserélni. A régi jelszó és az addigi
// belépések érvényüket vesztik. A beállítás bekerül a naplóba.
// =============================================================================

const fs = require('fs');
const { openDb } = require('./db');
const { jelszoMentes, veletlenJelszo } = require('./adminjelszo');

const { ENV_FILE, beallitas, dbFile } = require('./konzol');

const email = String(process.argv[2] || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.log('Használat: node src/admin-jelszo.js valaki@drindustrie.hu');
  process.exit(1);
}

// Csak az ADMIN_EMAILS-ben szereplő cím léphet be az admin felületre – ha nincs benne, szólunk.
const adminok = String(beallitas('ADMIN_EMAILS') || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
if (!adminok.includes(email)) {
  console.log(`Ez a cím nincs benne az ADMIN_EMAILS beállításban (${ENV_FILE}).`);
  console.log('Előbb írd be oda, és indítsd újra a szervert: systemctl restart munkalap');
  process.exit(1);
}

// Ugyanaz az adatbázis, amit a szerver használ (lásd konzol.js).
if (!fs.existsSync(dbFile)) {
  console.log(`Nem található az adatbázis: ${dbFile}`);
  process.exit(1);
}

const db = openDb(dbFile);
const jelszo = veletlenJelszo();
const most = Date.now();
db.transaction(() => {
  jelszoMentes(db, email, jelszo, most);
  db.prepare('DELETE FROM admin_sessions WHERE email = ?').run(email); // a régi belépések megszűnnek
  db.prepare("INSERT INTO naplo(ts, tipus, ki, megjegyzes) VALUES (?, 'admin_jelszo', ?, ?)")
    .run(most, email, 'Jelszó beállítva a szerveren (konzolból)');
})();
db.close();

console.log(`Admin jelszó beállítva: ${email}`);
console.log(`Ideiglenes jelszó: ${jelszo}`);
console.log('Belépés után a "Jelszó" fülön cseréld sajátra.');
