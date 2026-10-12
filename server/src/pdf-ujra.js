'use strict';

// =============================================================================
// MÓDOSÍTOTT MUNKALAPOK PDF-JÉNEK ÚJRAKÉSZÍTÉSE (konzolból)
// =============================================================================
// Minden módosított (nem törölt) munkalap aktuális PDF-jét újra elkészíti a mostani
// elrendezéssel, a módosítás eredeti idejével. Az eredeti és a korábbi változatok
// PDF-jeihez nem nyúl. Akkor kell, ha a PDF elrendezése javult, vagy kicserélték a sablont.
//
// Használat a VPS-en (WinSCP konzol):
//   cd /opt/munkalap/server && node src/pdf-ujra.js
// =============================================================================

const fs = require('fs');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { beallitas, dbFile, filesDir } = require('./konzol');

if (!fs.existsSync(dbFile)) {
  console.log(`Nem található az adatbázis: ${dbFile}`);
  process.exit(1);
}

const db = openDb(dbFile);
const app = createApp(db, { filesDir, sablonFile: beallitas('SABLON_FILE') || undefined }); // alapból server/assets/sablon.png
app.locals.pdfUjra().then((r) => {
  console.log(`Módosított munkalapok: ${r.osszes}, új PDF elkészült: ${r.sikeres}`);
  for (const [id, hiba] of r.hibak) console.log(`  Hiba (${id}): ${hiba}`);
  db.close();
  process.exitCode = r.hibak.length ? 1 : 0;
});
