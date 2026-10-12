'use strict';

// Tesztek: munkalap módosítása, változatok + PDF-ek, admin felület (belépés, jelszó, statisztika, napló, visszaállítás, export).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { openDb } = require('../src/db');
const { execFileSync } = require('child_process');
const { createApp, kmErtek } = require('../src/app');
const adminJelszo = require('../src/adminjelszo');

// Kis fehér PNG a sablon helyett (a valódi sablon.png a szerveren van).
function png(w, h) {
  const sor = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 255)]);
  const nyers = Buffer.concat(Array.from({ length: h }, () => sor));
  const ch = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t), d])) >>> 0);
    return Buffer.concat([len, Buffer.from(t), d, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ch('IHDR', ihdr), ch('IDAT', zlib.deflateSync(nyers)), ch('IEND', Buffer.alloc(0))]);
}

let server; let base; let dir; let db;
let clock = new Date('2026-10-12T08:00:00').getTime();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'munkalap-admin-'));
  fs.writeFileSync(path.join(dir, 'sablon.png'), png(60, 85));
  db = openDb(':memory:');
  const app = createApp(db, {
    appKey: 'titok', filesDir: path.join(dir, 'files'), sablonFile: path.join(dir, 'sablon.png'),
    now: () => clock, adminEmails: ['Fonok@DRI.hu'],
  });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, p, { token, body, form, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
const login = async (email) => (await call('POST', '/login', { body: { email, deviceId: email }, headers: { 'x-app-key': 'titok' } })).body.token;
const PDF = Buffer.from('%PDF-1.4 eredeti');

function urlap(data) {
  const f = new FormData();
  f.set('data', JSON.stringify(data));
  f.set('pdf', new Blob([PDF]), 'm.pdf');
  f.set('alairasUgyfel', new Blob([png(30, 10)]), 'u.png');
  return f;
}

test('km érték kiolvasása szabad szövegből', () => {
  assert.equal(kmErtek('25'), 25);
  assert.equal(kmErtek('10km'), 10);
  assert.equal(kmErtek('12,5 km'), 12.5);
  assert.equal(kmErtek('kb. 40 km oda-vissza'), 40);
  assert.equal(kmErtek('nem tudom'), null);
  assert.equal(kmErtek(''), null);
});

test('módosítás: új változat, régi megmarad, új PDF a szerveren, DRI szám nem változik', async () => {
  const anna = await login('anna@dri.hu');
  const bela = await login('bela@dri.hu');
  const uj = await call('PUT', '/worksheets/m-1', { token: anna, form: urlap({ ugyfel: 'Szabó Kft.', km: '20', helyszin: 'Miskolc' }) });
  assert.equal(uj.status, 201);
  const dri = uj.body.item.munkalapszam;
  assert.equal(uj.body.item.modositasokSzama, 0);

  clock += 3600 * 1000;
  const mod = await call('PUT', '/worksheets/m-1/modositas', { token: bela, body: { data: { km: '35', driSzam: '1', ismeretlen: 'x' } } });
  assert.equal(mod.status, 200);
  assert.equal(mod.body.item.munkalapszam, dri, 'a DRI szám nem módosítható');
  assert.equal(mod.body.item.data.km, '35');
  assert.equal(mod.body.item.data.ismeretlen, undefined, 'csak a megengedett mezők változhatnak');
  assert.equal(mod.body.item.data.ugyfel, 'Szabó Kft.', 'a többi mező marad');
  assert.equal(mod.body.item.modositasokSzama, 1);

  // Változatok: eredeti + 1. módosítás, mindkettőhöz PDF
  const v = await call('GET', '/worksheets/m-1/valtozatok', { token: anna });
  assert.deepEqual(v.body.map((x) => x.cim), ['Eredeti', '1. módosítás']);
  assert.equal(v.body[0].data.km, '20');
  assert.equal(v.body[1].ki, 'bela@dri.hu');
  assert.deepEqual(v.body[1].valtozasok, [{ mezo: 'km', elotte: '20', utana: '35' }]);
  assert.ok(v.body.every((x) => x.pdf));

  const eredetiPdf = await call('GET', '/worksheets/m-1/valtozatok/0/pdf', { token: anna });
  assert.deepEqual(eredetiPdf.body, PDF, 'az eredeti PDF megmaradt');
  const modPdf = await call('GET', `/worksheets/m-1/valtozatok/1/pdf?token=${anna}`);
  assert.equal(modPdf.type, 'application/pdf');
  assert.ok(modPdf.body.subarray(0, 4).equals(Buffer.from('%PDF')));
  assert.notDeepEqual(modPdf.body, PDF, 'a módosított PDF-et a szerver készítette');
  // A sima PDF letöltés a legfrissebb változatot adja
  assert.deepEqual((await call('GET', '/worksheets/m-1/files/pdf', { token: anna })).body, modPdf.body);

  // Második módosítás, és ugyanazzal az adattal még egyszer: nem lesz új változat
  clock += 60 * 1000;
  await call('PUT', '/worksheets/m-1/modositas', { token: anna, body: { data: { helyszin: 'Eger' } } });
  const ujra = await call('PUT', '/worksheets/m-1/modositas', { token: anna, body: { data: { helyszin: 'Eger' } } });
  assert.equal(ujra.body.status, 'unchanged');
  const v2 = await call('GET', '/worksheets/m-1/valtozatok', { token: anna });
  assert.deepEqual(v2.body.map((x) => x.cim), ['Eredeti', '1. módosítás', '2. módosítás']);
  assert.equal((await call('GET', '/worksheets/m-1/valtozatok/1/pdf', { token: anna })).status, 200, 'a köztes változat PDF-je is megvan');
  assert.equal((await call('GET', '/worksheets/m-1/valtozatok/9/pdf', { token: anna })).status, 404);

  // Az appból újraküldött (módosított) munkalap is módosításnak számít
  const appbol = await call('PUT', '/worksheets/m-1', { token: anna, form: urlap({ ugyfel: 'Szabó Kft.', km: '35', helyszin: 'Eger', gep: 'CNC' }) });
  assert.equal(appbol.body.item.modositasokSzama, 3);

  // Törölt munkalap nem módosítható
  await call('DELETE', '/worksheets/m-1', { token: anna });
  assert.equal((await call('PUT', '/worksheets/m-1/modositas', { token: anna, body: { data: { km: '1' } } })).status, 400);
});

test('admin: jelszó csak a szerveren, belépés, hibás jelszó, jelszócsere, kilépés', async () => {
  const anna = await login('anna@dri.hu');
  assert.equal((await call('GET', '/admin/attekintes', { token: anna })).status, 401, 'sima felhasználó nem admin');

  const nemAdmin = await call('POST', '/admin/belepes', { body: { email: 'anna@dri.hu', jelszo: 'barmi12345' } });
  assert.equal(nemAdmin.status, 401);
  // Jelszó nélkül nem lehet belépni, és a weben jelszót sem lehet adni (alkalmazáskulccsal sem)
  const nincsJelszo = await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'barmi12345' } });
  assert.equal(nincsJelszo.status, 401);
  assert.equal(nincsJelszo.body.error, nemAdmin.body.error, 'kívülről nem derül ki, ki admin');
  const web = await call('POST', '/admin/elso-jelszo', { body: { email: 'fonok@dri.hu', jelszo: 'Jelszo1234', appKey: 'titok' } });
  assert.notEqual(web.status, 200);
  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'Jelszo1234' } })).status, 401);

  // A jelszót a szerveren állítják be (ezt csinálja a konzolos parancs is)
  assert.throws(() => adminJelszo.jelszoMentes(db, 'fonok@dri.hu', 'rovid'));
  adminJelszo.jelszoMentes(db, 'fonok@dri.hu', 'Jelszo1234');

  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'rossz-jelszo' } })).status, 401);
  const be = await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'Jelszo1234' } });
  assert.equal(be.status, 200);
  const t = be.body.token;
  assert.equal((await call('GET', '/admin/me', { token: t })).body.email, 'fonok@dri.hu');

  assert.equal((await call('POST', '/admin/jelszo', { token: t, body: { regi: 'rossz', uj: 'UjJelszo123' } })).status, 400);
  assert.equal((await call('POST', '/admin/jelszo', { token: t, body: { regi: 'Jelszo1234', uj: 'UjJelszo123' } })).status, 200);
  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'Jelszo1234' } })).status, 401, 'régi jelszó már nem jó');
  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'UjJelszo123' } })).status, 200);

  await call('POST', '/admin/kilepes', { token: t });
  assert.equal((await call('GET', '/admin/me', { token: t })).status, 401);

  // Túl sok hibás jelszó -> átmeneti tiltás
  for (let i = 0; i < 10; i++) await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'rossz' } });
  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'UjJelszo123' } })).status, 429);
  clock += 16 * 60 * 1000;
  assert.equal((await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'UjJelszo123' } })).status, 200, '15 perc után újra lehet');
});

test('admin: statisztika, áttekintés, napló, visszaállítás, felhasználók, CSV', async () => {
  const adminBe = async () => (await call('POST', '/admin/belepes', { body: { email: 'fonok@dri.hu', jelszo: 'UjJelszo123' } })).body.token;
  const cili = await login('cili@dri.hu');
  const dani = await login('dani@dri.hu');
  clock = new Date('2026-11-03T09:00:00').getTime();
  await call('PUT', '/worksheets/s-1', { token: cili, body: { data: { ugyfel: 'A', helyszin: 'Miskolc', km: '25' } } });
  await call('PUT', '/worksheets/s-2', { token: cili, body: { data: { ugyfel: 'B', helyszin: 'miskolc ', km: '12,5 km' } } });
  await call('PUT', '/worksheets/s-3', { token: dani, body: { data: { ugyfel: 'C', helyszin: 'Eger', km: 'nem tudom' } } });
  clock = new Date('2026-11-20T09:00:00').getTime();
  await call('PUT', '/worksheets/s-4', { token: dani, body: { data: { ugyfel: 'D', helyszin: 'Eger', km: '100' } } });
  const t = await adminBe(); // az admin belépés 12 óráig érvényes, ezért az óra előreállítása után lépünk be

  const st = await call('GET', '/admin/statisztika?from=2026-11-01&to=2026-11-10', { token: t });
  assert.equal(st.status, 200);
  assert.equal(st.body.osszKm, 37.5);
  assert.equal(st.body.munkalapok, 3);
  assert.deepEqual(st.body.emberek.map((e) => [e.email, e.km, e.munkalap]), [['cili@dri.hu', 37.5, 2], ['dani@dri.hu', 0, 1]]);
  const miskolc = st.body.helyszinek.find((h) => h.helyszin.trim().toLowerCase() === 'miskolc');
  assert.equal(miskolc.munkalap, 2, 'kis/nagybetű és szóköz nem számít');
  assert.equal(st.body.ertelmezhetetlenKm.length, 1);
  assert.equal((await call('GET', '/admin/statisztika?from=2026-11-01&to=2026-11-30', { token: t })).body.osszKm, 137.5);

  const at = await call('GET', '/admin/attekintes?from=2026-11-01&to=2026-11-30', { token: t });
  assert.equal(at.body.munkalapok, 4);
  assert.equal(at.body.aktivFelhasznalok, 2);
  assert.deepEqual(at.body.napiBontas, [{ nap: '2026-11-03', db: 3 }, { nap: '2026-11-20', db: 1 }]);

  // Módosítás és törlés -> napló előtte / utána
  clock += 1000;
  await call('PUT', '/worksheets/s-4/modositas', { token: cili, body: { data: { km: '110', helyszin: 'Eger, gyár' } } });
  await call('DELETE', '/worksheets/s-3', { token: dani });
  const n = await call('GET', '/admin/naplo?from=2026-11-20&to=2026-11-20', { token: t });
  const mod = n.body.items.find((x) => x.tipus === 'modositas');
  assert.equal(mod.ki, 'cili@dri.hu');
  assert.equal(mod.valtozat, 1);
  assert.deepEqual(mod.valtozasok.sort((a, b) => a.mezo.localeCompare(b.mezo)),
    [{ mezo: 'helyszin', elotte: 'Eger', utana: 'Eger, gyár' }, { mezo: 'km', elotte: '100', utana: '110' }]);
  assert.ok(n.body.items.some((x) => x.tipus === 'torles' && x.ki === 'dani@dri.hu'));
  const csakMod = await call('GET', '/admin/naplo?tipus=modositas&q=cili', { token: t });
  assert.ok(csakMod.body.items.every((x) => x.tipus === 'modositas' && x.ki === 'cili@dri.hu'));
  const v = await call('GET', '/admin/munkalap/s-4/valtozatok', { token: t });
  assert.equal(v.body.valtozatok.length, 2);

  // Törölt munkalap visszaállítása
  const torolt = await call('GET', '/admin/torolt', { token: t });
  assert.ok(torolt.body.some((w) => w.id === 's-3'));
  const vissza = await call('POST', '/admin/visszaallitas/s-3', { token: t });
  assert.equal(vissza.body.deleted, false);
  assert.equal(vissza.body.modositasokSzama, 0, 'a visszaállítás nem módosítás');
  assert.ok((await call('GET', '/admin/naplo?tipus=visszaallitas', { token: t })).body.items.some((x) => x.ki === 'fonok@dri.hu'));

  const f = await call('GET', '/admin/felhasznalok', { token: t });
  assert.ok(f.body.find((u) => u.email === 'cili@dri.hu').munkalap >= 2);

  const csv = await call('GET', `/admin/export.csv?from=2026-11-01&to=2026-11-30&token=${t}`);
  assert.equal(csv.status, 200);
  const sorok = csv.body.toString('utf8').replace(/^﻿/, '').split('\r\n');
  assert.equal(sorok.length, 5, 'fejléc + 4 munkalap');
  assert.match(sorok[0], /^DRI szám;Rögzítve;Rögzítette/);
});

test('konzolos parancs: admin jelszó beállítása a VPS-en', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'munkalap-cli-'));
  try {
    const dbFile = path.join(d, 'munkalap.db');
    openDb(dbFile).close();
    fs.writeFileSync(path.join(d, '.env'), 'APP_KEY=x\r\nADMIN_EMAILS=fonok@dri.hu, iroda@dri.hu\r\n');
    const futtat = (email) => {
      try {
        return { kod: 0, ki: execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'admin-jelszo.js'), email],
          { env: { ...process.env, ENV_FILE: path.join(d, '.env'), DB_FILE: dbFile, ADMIN_EMAILS: '' }, encoding: 'utf8' }) };
      } catch (err) {
        return { kod: err.status, ki: err.stdout };
      }
    };
    // Nem admin cím: nem állít be semmit
    assert.equal(futtat('valaki@dri.hu').kod, 1);
    // Admin cím: ideiglenes jelszót ad, ami működik
    const r = futtat('Iroda@DRI.hu');
    assert.equal(r.kod, 0, r.ki);
    const jelszo = /Ideiglenes jelszó: (\S+)/.exec(r.ki)[1];
    assert.ok(jelszo.length >= 8);
    const d2 = openDb(dbFile);
    assert.ok(adminJelszo.jelszoJo(d2, 'iroda@dri.hu', jelszo));
    assert.ok(!adminJelszo.jelszoJo(d2, 'iroda@dri.hu', 'rossz'));
    assert.equal(d2.prepare("SELECT COUNT(*) AS n FROM naplo WHERE tipus = 'admin_jelszo'").get().n, 1);
    d2.close();
    // Újrafuttatva új jelszó, a régi már nem jó
    const r2 = futtat('iroda@dri.hu');
    const d3 = openDb(dbFile);
    assert.ok(!adminJelszo.jelszoJo(d3, 'iroda@dri.hu', jelszo));
    assert.ok(adminJelszo.jelszoJo(d3, 'iroda@dri.hu', /Ideiglenes jelszó: (\S+)/.exec(r2.ki)[1]));
    d3.close();
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('hiányzó sablon: a módosított PDF később magától pótlódik, JPG sablon is jó', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'munkalap-sablon-'));
  const sablon = path.join(d, 'sablon.png');
  const app = createApp(openDb(':memory:'), { appKey: 'k', filesDir: path.join(d, 'files'), sablonFile: sablon });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const b = `http://127.0.0.1:${srv.address().port}/api`;
  const kerd = async (method, p, { token, body } = {}) => {
    const res = await fetch(b + p, { method, headers: { 'content-type': 'application/json', 'x-app-key': 'k', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.arrayBuffer() };
  };
  try {
    const t = (await kerd('POST', '/login', { body: { email: 'x@dri.hu', deviceId: 'd' } })).body.token;
    await kerd('PUT', '/worksheets/p-1', { token: t, body: { data: { ugyfel: 'A', km: '1' } } });
    const m = await kerd('PUT', '/worksheets/p-1/modositas', { token: t, body: { data: { km: '2' } } });
    assert.equal(m.status, 200, 'a módosítás a PDF hibája ellenére is mentődik');
    let v = (await kerd('GET', '/worksheets/p-1/valtozatok', { token: t })).body;
    assert.equal(v[1].pdf, false);
    assert.match(v[1].pdfHiba, /sablon/);

    // Rossz formátumú sablon: érthető hibaüzenet
    fs.writeFileSync(sablon, 'nem kép');
    v = (await kerd('GET', '/worksheets/p-1/valtozatok', { token: t })).body;
    assert.match(v[1].pdfHiba, /nem PNG és nem JPG/);

    // A sablon feltöltése után a következő megnyitáskor elkészül (JPG is jó)
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'sablon.jpg'), sablon);
    v = (await kerd('GET', '/worksheets/p-1/valtozatok', { token: t })).body;
    assert.equal(v[1].pdf, true);
    assert.equal(v[1].pdfHiba, undefined);
    const pdf = await kerd('GET', '/worksheets/p-1/valtozatok/1/pdf', { token: t });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(pdf.body).subarray(0, 4).toString(), '%PDF');
  } finally {
    srv.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('konzolos parancs: módosított PDF-ek újrakészítése', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'munkalap-ujra-'));
  try {
    const dbFile = path.join(d, 'munkalap.db');
    const filesDir = path.join(d, 'files');
    fs.writeFileSync(path.join(d, 'sablon.png'), png(60, 85));
    const db2 = openDb(dbFile);
    const app = createApp(db2, { appKey: 'k', filesDir, sablonFile: path.join(d, 'sablon.png') });
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const b = `http://127.0.0.1:${srv.address().port}/api`;
    const kerd = (method, p, token, body) => fetch(b + p, { method, headers: { 'content-type': 'application/json', 'x-app-key': 'k', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
    const t = (await kerd('POST', '/login', null, { email: 'x@dri.hu', deviceId: 'd' })).token;
    await kerd('PUT', '/worksheets/u-1', t, { data: { ugyfel: 'A' } });
    await kerd('PUT', '/worksheets/u-2', t, { data: { ugyfel: 'B' } });
    await kerd('PUT', '/worksheets/u-1/modositas', t, { data: { ugyfel: 'A2' } });
    srv.close(); db2.close();
    const pdfFajl = path.join(filesDir, 'u-1', 'munkalap.pdf');
    fs.writeFileSync(pdfFajl, '%PDF regi');
    const ki = execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'pdf-ujra.js')], {
      env: { ...process.env, ENV_FILE: path.join(d, 'nincs.env'), DB_FILE: dbFile, FILES_DIR: filesDir, SABLON_FILE: path.join(d, 'sablon.png') }, encoding: 'utf8' });
    assert.match(ki, /Módosított munkalapok: 1, új PDF elkészült: 1/);
    assert.ok(fs.statSync(pdfFajl).size > 1000, 'a régi PDF helyett új készült');
    assert.ok(!fs.existsSync(path.join(filesDir, 'u-2', 'munkalap.pdf')), 'a nem módosítotthoz nem nyúl');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});
