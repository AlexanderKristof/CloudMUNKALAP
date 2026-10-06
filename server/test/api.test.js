'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

const PDF = Buffer.from('%PDF-1.4 teszt munkalap');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let server;
let base;
let filesDir;
let clock = new Date('2026-10-06T10:00:00').getTime();
const sentMails = [];
let mailFails = false;

before(async () => {
  filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'munkalap-test-'));
  const app = createApp(openDb(':memory:'), {
    appKey: 'titok',
    filesDir,
    now: () => clock,
    mailFrom: '"DR Industrie Szerviz" <szerviz@example.com>',
    sendMail: async (m) => {
      if (mailFails) throw new Error('SMTP nem elérhető');
      sentMails.push(m);
    },
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

async function call(method, p, { token, body, form, headers = {} } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(form ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: form || (body === undefined ? undefined : JSON.stringify(body)),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}

async function login(email, deviceId) {
  const r = await call('POST', '/login', { body: { email, deviceId, deviceName: `${email} telefonja` }, headers: { 'x-app-key': 'titok' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

function munkalap(extra = {}) {
  return {
    driSzam: '2026-101',
    ugyfel: 'Szabó Kft.',
    ugyfelEmail: 'ugyfel@szabo.hu',
    helyszin: 'Miskolc, Gyár u. 1.',
    gep: 'CNC eszterga',
    idotartam: '3 óra',
    km: '25',
    elvegzettMunka: 'Orsócsapágy csere',
    hibaLeiras: 'Kopott csapágy, javaslat: fél év múlva ellenőrzés',
    datum: 'Miskolc, 2026.10.6.',
    ...extra,
  };
}

function urlap(data, { kuldes = false, pdf = PDF, sig = PNG } = {}) {
  const f = new FormData();
  f.set('data', JSON.stringify(data));
  if (kuldes) f.set('kuldes', '1');
  if (pdf) f.set('pdf', new Blob([pdf], { type: 'application/pdf' }), 'munkalap.pdf');
  if (sig) {
    f.set('alairasUgyfel', new Blob([sig], { type: 'image/png' }), 'u.png');
    f.set('alairasSzerviz', new Blob([sig], { type: 'image/png' }), 's.png');
  }
  return f;
}

test('bejelentkezés csak e-mail címmel, alkalmazáskulccsal', async () => {
  assert.equal((await call('POST', '/login', { body: { email: 'a@b.hu' } })).status, 401);
  assert.equal((await call('POST', '/login', { body: { email: 'nem-email' }, headers: { 'x-app-key': 'titok' } })).status, 400);
  assert.equal((await call('POST', '/login', { headers: { 'x-app-key': 'titok' } })).status, 400);

  const t1 = await login('Kovacs.Peter@DRI.hu', 'dev-a');
  const t2 = await login('  kovacs.peter@dri.hu ', 'dev-b');
  const me1 = await call('GET', '/me', { token: t1 });
  const me2 = await call('GET', '/me', { token: t2 });
  assert.equal(me1.body.user.id, me2.body.user.id, 'ugyanaz az e-mail ugyanazt a felhasználót adja');
  assert.equal(me1.body.user.email, 'kovacs.peter@dri.hu');
  assert.equal(me2.body.deviceId, 'dev-b');

  assert.equal((await call('GET', '/me')).status, 401);
  await call('POST', '/logout', { token: t1 });
  assert.equal((await call('GET', '/me', { token: t1 })).status, 401);
});

test('munkalap beküldése PDF-fel és aláírásokkal, e-mail küldés a szerverről', async () => {
  const anna = await login('anna@dri.hu', 'anna-tel');
  sentMails.length = 0;

  const r = await call('PUT', '/worksheets/ml-1', { token: anna, form: urlap(munkalap(), { kuldes: true }) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.email.status, 'kuldve');
  assert.equal(r.body.item.munkalapszam, '2026-101');
  assert.equal(r.body.item.ugyfelEmail, 'ugyfel@szabo.hu');
  assert.deepEqual(r.body.item.files, { pdf: true, alairasUgyfel: true, alairasSzerviz: true });
  assert.equal(r.body.item.createdBy.email, 'anna@dri.hu');

  assert.equal(sentMails.length, 1);
  assert.equal(sentMails[0].to, 'ugyfel@szabo.hu');
  assert.equal(sentMails[0].cc, 'anna@dri.hu');
  assert.equal(sentMails[0].subject, 'DR Industrie Munkalap - DRI-2026-101');
  assert.equal(sentMails[0].attachments[0].filename, 'Munkalap_DRI_2026-101.pdf');
  assert.deepEqual(fs.readFileSync(sentMails[0].attachments[0].path), PDF);

  // Újrapróbálás (pl. megszakadt a net a válasz előtt): nem lesz új változat és nem megy ki újra az e-mail
  const retry = await call('PUT', '/worksheets/ml-1', { token: anna, form: urlap(munkalap(), { kuldes: true }) });
  assert.equal(retry.body.status, 'unchanged');
  assert.equal(retry.body.email.alreadySent, true);
  assert.equal(sentMails.length, 1);

  const pdf = await call('GET', '/worksheets/ml-1/files/pdf', { token: anna });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.type, 'application/pdf');
  assert.deepEqual(pdf.body, PDF);
  const sig = await call('GET', `/worksheets/ml-1/files/alairasUgyfel?token=${anna}`);
  assert.equal(sig.type, 'image/png');
  assert.equal((await call('GET', '/worksheets/ml-1/files/valami', { token: anna })).status, 404);

  // Újraküldés másik címre
  const resend = await call('POST', '/worksheets/ml-1/email', { token: anna, body: { to: 'masik@ceg.hu' } });
  assert.equal(resend.status, 200);
  assert.equal(sentMails.at(-1).to, 'masik@ceg.hu');
});

test('e-mail hibák: nincs ügyfél cím, SMTP hiba, rossz fájl', async () => {
  const bela = await login('bela@dri.hu', 'bela-tel');

  const nincsCim = await call('PUT', '/worksheets/ml-2', { token: bela, form: urlap(munkalap({ driSzam: '2026-102', ugyfelEmail: '' }), { kuldes: true }) });
  assert.equal(nincsCim.status, 201);
  assert.equal(nincsCim.body.email.status, 'nincs');
  assert.match(nincsCim.body.email.error, /ügyfél e-mail/);

  mailFails = true;
  const hiba = await call('PUT', '/worksheets/ml-3', { token: bela, form: urlap(munkalap({ driSzam: '2026-103' }), { kuldes: true }) });
  mailFails = false;
  assert.equal(hiba.status, 201, 'a munkalap akkor is mentődik, ha az e-mail nem megy ki');
  assert.equal(hiba.body.item.email.status, 'hiba');
  assert.match(hiba.body.item.email.error, /SMTP/);
  const ujra = await call('PUT', '/worksheets/ml-3', { token: bela, form: urlap(munkalap({ driSzam: '2026-103' }), { kuldes: true }) });
  assert.equal(ujra.body.email.status, 'kuldve', 'újrapróbáláskor a sikertelen e-mail kimegy');

  const rosszPdf = await call('PUT', '/worksheets/ml-4', { token: bela, form: urlap(munkalap(), { pdf: Buffer.from('nem pdf') }) });
  assert.equal(rosszPdf.status, 400);
  assert.equal((await call('GET', '/worksheets/ml-4', { token: bela })).status, 404, 'hibás feltöltésnél nem mentődik semmi');

  assert.equal((await call('PUT', '/worksheets/..%2Fx', { token: bela, body: { data: {} } })).status, 400);
  assert.equal((await call('PUT', '/worksheets/x', { token: bela, body: { data: [1] } })).status, 400);
});

test('módosítás, ütközés, előzmények, törlés', async () => {
  const anna = await login('anna@dri.hu', 'anna-tel');
  const bela = await login('bela@dri.hu', 'bela-tel');

  const created = await call('PUT', '/worksheets/ws-1', { token: anna, body: { data: munkalap({ driSzam: '2026-200' }) } });
  assert.equal(created.status, 201);
  assert.equal(created.body.version, 1);
  assert.equal(created.body.item.device.name, 'anna@dri.hu telefonja');

  const byBela = await call('PUT', '/worksheets/ws-1', { token: bela, body: { baseVersion: 1, data: munkalap({ driSzam: '2026-200', km: '40' }) } });
  assert.equal(byBela.body.version, 2);
  assert.equal(byBela.body.conflict, false);
  assert.equal(byBela.body.item.createdBy.email, 'anna@dri.hu');
  assert.equal(byBela.body.item.updatedBy.email, 'bela@dri.hu');

  const stale = await call('PUT', '/worksheets/ws-1', { token: anna, body: { baseVersion: 1, data: munkalap({ driSzam: '2026-200', km: '30' }) } });
  assert.equal(stale.body.conflict, true);
  const hist = await call('GET', '/worksheets/ws-1/history', { token: anna });
  assert.equal(hist.body.length, 2);
  assert.equal(hist.body[0].data.km, '40');

  await call('DELETE', '/worksheets/ws-1', { token: bela });
  const list = await call('GET', '/worksheets', { token: anna });
  assert.ok(!list.body.items.some((w) => w.id === 'ws-1'));
  const withDeleted = await call('GET', '/worksheets?includeDeleted=1', { token: anna });
  assert.ok(withDeleted.body.items.find((w) => w.id === 'ws-1').deleted);
  assert.equal((await call('DELETE', '/worksheets/nincs', { token: anna })).status, 404);
});

test('keresés felhasználó, szöveg és rögzítési dátum szerint', async () => {
  const cili = await login('cili@dri.hu', 'cili-tel');
  const dani = await login('dani@dri.hu', 'dani-tel');
  clock = new Date('2026-09-15T09:00:00').getTime();
  await call('PUT', '/worksheets/k-10', { token: cili, body: { data: munkalap({ driSzam: 'K-10', ugyfel: 'Fehér Bt.', hibaLeiras: 'tető 50% kész' }) } });
  clock = new Date('2026-10-02T08:30:00').getTime();
  await call('PUT', '/worksheets/k-11', { token: cili, body: { data: munkalap({ driSzam: 'K-11', ugyfel: 'Fekete Zrt.', gep: 'Hegesztőrobot' }) } });
  clock = new Date('2026-10-03T23:59:00').getTime();
  await call('PUT', '/worksheets/d-1', { token: dani, body: { data: munkalap({ driSzam: 'D-1', ugyfel: 'FEHÉR BT.' }) } });
  clock = new Date('2026-10-06T10:00:00').getTime();

  let r = await call('GET', '/worksheets?user=Cili@dri.hu', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-11', 'K-10'], 'legújabb elöl');

  r = await call('GET', `/worksheets?q=${encodeURIComponent('fehér')}`, { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['D-1', 'K-10']);

  r = await call('GET', `/worksheets?q=${encodeURIComponent('hegesztő')}`, { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-11']);

  r = await call('GET', '/worksheets?q=50%25', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-10']);

  r = await call('GET', '/worksheets?from=2026-10-01&to=2026-10-03', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['D-1', 'K-11']);
  assert.equal((await call('GET', '/worksheets?from=2026.10.01', { token: dani })).status, 400);

  const users = await call('GET', '/users', { token: dani });
  assert.equal(users.body.find((u) => u.email === 'cili@dri.hu').worksheetCount, 2);
});

test('szinkron több eszköz között', async () => {
  const tel1 = await login('eszter@dri.hu', 'eszter-tel');
  const tel2 = await login('feri@dri.hu', 'feri-tel');

  const start = await call('POST', '/sync', { token: tel2, body: { since: 0 } });
  const cursor2 = start.body.cursor;

  const up = await call('POST', '/sync', {
    token: tel1,
    body: {
      since: 0,
      changes: [
        { id: 'offline-1', data: munkalap({ driSzam: 'E-1' }) },
        { id: 'offline-2', data: munkalap({ driSzam: 'E-2' }) },
        { id: 'rossz', data: 'nem objektum' },
      ],
    },
  });
  assert.deepEqual(up.body.results.map((x) => x.status), ['created', 'created', 'error']);

  const down = await call('POST', '/sync', { token: tel2, body: { since: cursor2 } });
  assert.deepEqual(down.body.items.map((w) => w.id), ['offline-1', 'offline-2']);
  assert.equal(down.body.items[0].createdBy.email, 'eszter@dri.hu');

  const again = await call('POST', '/sync', { token: tel2, body: { since: down.body.cursor } });
  assert.equal(again.body.items.length, 0);

  const paged = await call('POST', '/sync', { token: tel2, body: { since: 0, limit: 1 } });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.hasMore, true);
});
