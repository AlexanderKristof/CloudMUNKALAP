'use strict';

// =============================================================================
// BEÁLLÍTÁSOK A KONZOLOS PARANCSOKHOZ (admin-jelszo.js, pdf-ujra.js)
// =============================================================================
// A szolgáltatás (systemd) a /opt/munkalap/.env-ből kapja a beállításokat, a konzolból
// indított parancs viszont nem. Ezért itt magunk olvassuk be a .env fájlt, és ugyanazokat
// az alapértékeket használjuk, mint a szolgáltatás (DATA_DIR=/opt/munkalap/data).
// =============================================================================

const fs = require('fs');
const path = require('path');

const ENV_FILE = process.env.ENV_FILE || path.join(__dirname, '..', '..', '.env');
const envFajl = {};
if (fs.existsSync(ENV_FILE)) {
  for (const sor of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(sor);
    if (m) envFajl[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// Egy beállítás: előbb a környezetből, aztán a .env fájlból.
const beallitas = (kulcs) => process.env[kulcs] || envFajl[kulcs];

const dataDir = beallitas('DATA_DIR')
  || (fs.existsSync('/opt/munkalap/data') ? '/opt/munkalap/data' : path.join(process.cwd(), 'data'));
const dbFile = beallitas('DB_FILE') || path.join(dataDir, 'munkalap.db');
const filesDir = beallitas('FILES_DIR') || path.join(dataDir, 'files');

module.exports = { ENV_FILE, beallitas, dataDir, dbFile, filesDir };
