'use strict';

// =============================================================================
// MUNKALAP PDF KÉSZÍTÉSE A SZERVEREN (a módosított változatokhoz)
// =============================================================================
// Az eredeti munkalap PDF-jét a telefon készíti. Ha egy munkalapot utólag módosítanak
// (a weben vagy az appban), az új PDF-et a szerver készíti el ezzel a fájllal, hogy
// a webes és az appos módosítás pontosan ugyanúgy nézzen ki.
//
// A kinézet ugyanaz, mint az appban (main.dart -> _generatePdf): a sablon.png a háttér,
// erre kerülnek a mezők ugyanazokra a helyekre, és pirossal a "Módosítás dátuma".
//
// KOORDINÁTÁK: ugyanazok a számok, mint az appban (A4 = 595 x 842 egység, "left" a bal
// széltől, "top" a lap tetejétől). A PDF-ben a függőleges tengely alulról nő, ezért a
// "top" értékeket itt átszámoljuk (lásd: alapvonal()).
// =============================================================================

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const LAP_SZ = 595; // A4 szélesség
const LAP_M = 842; // A4 magasság
const ASCENT = 1.35; // a szöveg dobozának tetejétől az alapvonalig, a betűméret arányában (az app PDF-jéhez mérve)
const SORMAGASSAG = 1.172; // Roboto sormagasság a betűméret arányában (ugyanaz, mint az appban)

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const ALAP_SABLON = path.join(__dirname, '..', 'assets', 'sablon.png');

// Egysoros mezők: [mező kulcs a munkalap adataiban, left, top] – ugyanaz, mint az appban.
const EGYSOROS = [
  ['ugyfel', 140, 136],
  ['helyszin', 225, 172],
  ['gep', 180, 209],
  ['idotartam', 245, 243],
  ['km', 190, 279],
  ['datum', 135, 610],
];
// Többsoros mezők (keretbe tördelve): [kulcs, left, top, szélesség, magasság]
const TOBBSOROS = [
  ['elvegzettMunka', 45, 360, 500, 95],
  ['hibaLeiras', 45, 500, 500, 95],
];

// "top" (a szöveg dobozának teteje felülről) -> PDF y koordináta (alapvonal alulról)
function alapvonal(top, meret) {
  return LAP_M - top - ASCENT * meret;
}

// Szöveg tördelése a megadott szélességre (szavanként; a sortöréseket megtartja).
function tordeles(szoveg, font, meret, szelesseg) {
  const sorok = [];
  for (const bekezdes of String(szoveg).split(/\r?\n/)) {
    let sor = '';
    for (const szo of bekezdes.split(/\s+/).filter(Boolean)) {
      const proba = sor ? `${sor} ${szo}` : szo;
      if (font.widthOfTextAtSize(proba, meret) <= szelesseg || !sor) {
        sor = proba;
      } else {
        sorok.push(sor);
        sor = szo;
      }
    }
    sorok.push(sor);
  }
  return sorok;
}

// Dátum magyar formában, percre pontosan: 2026.10.12. 14:35 (a szerver időzónájában – Europe/Budapest)
function datumIdo(ms) {
  const d = new Date(ms);
  const k = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${k(d.getMonth() + 1)}.${k(d.getDate())}. ${k(d.getHours())}:${k(d.getMinutes())}`;
}

/**
 * Munkalap PDF elkészítése.
 * @param {object} adatok      a munkalap mezői (driSzam, ugyfel, helyszin, ...)
 * @param {object} opciok
 *   alairasUgyfel, alairasSzerviz – PNG képek (Buffer) vagy null
 *   modositva                     – a módosítás időpontja (ms); ha meg van adva, pirossal rákerül
 *   sablonFile                    – a háttérkép elérési útja (alapból assets/sablon.png)
 * @returns {Promise<Buffer>} a kész PDF
 */
async function munkalapPdf(adatok, { alairasUgyfel = null, alairasSzerviz = null, modositva = null, sablonFile = ALAP_SABLON } = {}) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'Roboto-Regular.ttf')), { subset: true });
  const fontBold = await doc.embedFont(fs.readFileSync(path.join(FONT_DIR, 'Roboto-Bold.ttf')), { subset: true });
  const lap = doc.addPage([LAP_SZ, LAP_M]);

  // Háttér: a nyomtatvány képe, a teljes lapot kitöltve (mint az appban: BoxFit.cover).
  if (!fs.existsSync(sablonFile)) {
    throw new Error(`Hiányzik a sablon kép: ${sablonFile}`);
  }
  const hatter = await doc.embedPng(fs.readFileSync(sablonFile));
  const arany = Math.max(LAP_SZ / hatter.width, LAP_M / hatter.height);
  const hw = hatter.width * arany;
  const hh = hatter.height * arany;
  lap.drawImage(hatter, { x: (LAP_SZ - hw) / 2, y: (LAP_M - hh) / 2, width: hw, height: hh });

  const fekete = rgb(0, 0, 0);

  // Munkalap száma a "DRI-" felirat után (vastag, 11-es betű).
  if (adatok.driSzam) {
    lap.drawText(String(adatok.driSzam), { x: 474, y: alapvonal(52, 11), size: 11, font: fontBold, color: fekete });
  }

  // Egysoros mezők (10-es betű).
  for (const [kulcs, left, top] of EGYSOROS) {
    const ertek = adatok[kulcs];
    if (ertek === undefined || ertek === null || ertek === '') continue;
    lap.drawText(String(ertek).replace(/\s*\r?\n\s*/g, ' '), { x: left, y: alapvonal(top, 10), size: 10, font, color: fekete });
  }

  // Többsoros mezők: tördelve a keretbe; ami nem fér el, az lemarad (mint az appban).
  for (const [kulcs, left, top, szel, mag] of TOBBSOROS) {
    const ertek = adatok[kulcs];
    if (!ertek) continue;
    const sorok = tordeles(ertek, font, 10, szel);
    const maxSor = Math.floor(mag / (SORMAGASSAG * 10));
    sorok.slice(0, maxSor).forEach((sor, i) => {
      lap.drawText(sor, { x: left, y: alapvonal(top + i * SORMAGASSAG * 10, 10), size: 10, font, color: fekete });
    });
  }

  // Aláírások: 180 x 60-as dobozban, arányosan kicsinyítve, vízszintesen középen, alul a vonalon.
  for (const [png, left] of [[alairasUgyfel, 35], [alairasSzerviz, 372]]) {
    if (!png) continue;
    const kep = await doc.embedPng(png);
    const sk = Math.min(180 / kep.width, 60 / kep.height);
    const w = kep.width * sk;
    const h = kep.height * sk;
    lap.drawImage(kep, { x: left + (180 - w) / 2, y: LAP_M - (626 + 60), width: w, height: h });
  }

  // Módosítás jelzése pirossal, a "Hely, dátum" sor mellett jobbra.
  if (modositva) {
    lap.drawText(`Módosítás dátuma: ${datumIdo(modositva)}`, {
      x: 320, y: alapvonal(611, 10), size: 10, font: fontBold, color: rgb(0.85, 0.1, 0.1),
    });
  }

  return Buffer.from(await doc.save());
}

module.exports = { munkalapPdf, datumIdo, ALAP_SABLON };
