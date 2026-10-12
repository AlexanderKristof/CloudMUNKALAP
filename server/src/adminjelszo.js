'use strict';

// =============================================================================
// ADMIN JELSZAVAK
// =============================================================================
// A jelszó titkosítása és ellenőrzése. Ezt használja a szerver (belépés, jelszócsere)
// és a konzolos parancs is (src/admin-jelszo.js), amivel a VPS-en lehet jelszót adni.
// A jelszó maga sehol nincs eltárolva: scrypt + véletlen "só" alapján csak egy
// ellenőrző kód kerül az adatbázisba.
// =============================================================================

const crypto = require('crypto');

const MIN_HOSSZ = 8; // a jelszó legalább ennyi karakter

const hashel = (jelszo, salt) => crypto.scryptSync(String(jelszo), salt, 64).toString('hex');

// Jelszó elmentése (új vagy csere). Rövid jelszónál hibát dob.
function jelszoMentes(db, email, jelszo, most = Date.now()) {
  if (typeof jelszo !== 'string' || jelszo.length < MIN_HOSSZ) {
    throw new Error(`A jelszó legalább ${MIN_HOSSZ} karakter legyen.`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO admin_jelszavak(email, hash, salt, updated_at) VALUES (@email, @hash, @salt, @most)
    ON CONFLICT(email) DO UPDATE SET hash = @hash, salt = @salt, updated_at = @most`)
    .run({ email, hash: hashel(jelszo, salt), salt, most });
}

// Igaz, ha a jelszó jó. Ha az adminnak még nincs jelszava, hamis.
function jelszoJo(db, email, jelszo) {
  const sor = db.prepare('SELECT * FROM admin_jelszavak WHERE email = ?').get(email);
  if (!sor) return false;
  const a = Buffer.from(hashel(jelszo, sor.salt), 'hex');
  const b = Buffer.from(sor.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Véletlen, könnyen begépelhető ideiglenes jelszó (nincs benne 0/O, 1/l/I).
function veletlenJelszo(hossz = 12) {
  const betuk = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(hossz), (b) => betuk[b % betuk.length]).join('');
}

module.exports = { jelszoMentes, jelszoJo, veletlenJelszo, MIN_HOSSZ };
