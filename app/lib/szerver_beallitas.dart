// =============================================================================
// SZERVER BEÁLLÍTÁSOK
// =============================================================================
// Csak ezt a fájlt kell átírni, ha a szerver címe vagy az alkalmazáskulcs változik.
// Külön fájlban van, hogy a többi fájl cseréje (frissítés) ne írja felül a kulcsot.
//
// FIGYELEM: a kulcsot ne tedd ki nyilvános helyre (pl. nyilvános GitHub repó),
// mert aki ismeri, hozzáfér a munkalapokhoz.
// =============================================================================

/// A VPS-en futó munkalap szerver címe (HTTPS, a végén perjel nélkül).
const String kSzerverCim = 'https://munkalap.drindustrie.hu';

/// Az alkalmazáskulcs: a szerveren a /opt/munkalap/.env fájl APP_KEY= utáni része.
/// A két érték pontosan egyezzen, különben a szerver elutasítja a belépést.
const String kAppKulcs = 'IDE_JON_AZ_APP_KEY';
