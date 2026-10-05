'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  const app = createApp(openDb(':memory:'), { appKey: 'titok' });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function login(name, deviceId) {
  const r = await call('POST', '/login', { body: { name, deviceId, deviceName: `${name} telefonja` }, headers: { 'x-app-key': 'titok' } });
  assert.equal(r.status, 200);
  return r.body.token;
}

test('bejelentkezés csak névvel, alkalmazáskulccsal', async () => {
  assert.equal((await call('POST', '/login', { body: { name: 'Péter' } })).status, 401);
  assert.equal((await call('POST', '/login', { body: { name: '  ' }, headers: { 'x-app-key': 'titok' } })).status, 400);
  assert.equal((await call('POST', '/login', { headers: { 'x-app-key': 'titok' } })).status, 400);

  const t1 = await login('Kovács Péter', 'dev-a');
  const t2 = await login('kovács  péter', 'dev-b');
  const me1 = await call('GET', '/me', { token: t1 });
  const me2 = await call('GET', '/me', { token: t2 });
  assert.equal(me1.body.user.id, me2.body.user.id, 'ugyanaz a név ugyanazt a felhasználót adja');
  assert.equal(me2.body.deviceId, 'dev-b');

  assert.equal((await call('GET', '/me')).status, 401);
  await call('POST', '/logout', { token: t1 });
  assert.equal((await call('GET', '/me', { token: t1 })).status, 401);
});

test('mentés, módosítás, ütközés, előzmények, törlés', async () => {
  const anna = await login('Anna', 'anna-tel');
  const bela = await login('Béla', 'bela-tel');

  const created = await call('PUT', '/worksheets/ws-1', {
    token: anna,
    body: { data: { munkalapszam: 'ML-001', ugyfel: 'Szabó Kft.', datum: '2026-10-01', allapot: 'nyitott', leiras: 'Kazán javítás' } },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.version, 1);
  assert.equal(created.body.item.createdBy.name, 'Anna');
  assert.equal(created.body.item.device.name, 'Anna telefonja');

  const same = await call('PUT', '/worksheets/ws-1', { token: anna, body: { data: created.body.item.data } });
  assert.equal(same.body.status, 'unchanged');

  const byBela = await call('PUT', '/worksheets/ws-1', {
    token: bela, body: { baseVersion: 1, data: { ...created.body.item.data, allapot: 'kész' } },
  });
  assert.equal(byBela.body.version, 2);
  assert.equal(byBela.body.conflict, false);
  assert.equal(byBela.body.item.createdBy.name, 'Anna');
  assert.equal(byBela.body.item.updatedBy.name, 'Béla');

  // Anna még az 1-es verzióból dolgozott -> ütközés jelzés, de nem vész el semmi
  const stale = await call('PUT', '/worksheets/ws-1', {
    token: anna, baseVersion: 1, body: { baseVersion: 1, data: { ...created.body.item.data, leiras: 'Kazán + radiátor' } },
  });
  assert.equal(stale.body.conflict, true);
  const hist = await call('GET', '/worksheets/ws-1/history', { token: anna });
  assert.equal(hist.body.length, 2);
  assert.equal(hist.body[0].data.allapot, 'kész');

  const del = await call('DELETE', '/worksheets/ws-1', { token: bela });
  assert.equal(del.body.status, 'updated');
  const list = await call('GET', '/worksheets', { token: anna });
  assert.ok(!list.body.items.some((w) => w.id === 'ws-1'));
  const withDeleted = await call('GET', '/worksheets?includeDeleted=1', { token: anna });
  assert.ok(withDeleted.body.items.find((w) => w.id === 'ws-1').deleted);

  assert.equal((await call('PUT', '/worksheets/x', { token: anna, body: { data: [1] } })).status, 400);
  assert.equal((await call('DELETE', '/worksheets/nincs', { token: anna })).status, 404);
});

test('keresés név, szöveg, dátum és állapot szerint', async () => {
  const cili = await login('Cili', 'cili-tel');
  const dani = await login('Dani', 'dani-tel');
  await call('POST', '/worksheets', { token: cili, body: { data: { szam: 'K-10', ugyfelNev: 'Fehér Bt.', date: '2026-09-15', status: 'kész', megjegyzes: 'tető 50% kész' } } });
  await call('POST', '/worksheets', { token: cili, body: { data: { szam: 'K-11', ugyfelNev: 'Fekete Zrt.', date: '2026-10-02T08:30', status: 'nyitott' } } });
  await call('POST', '/worksheets', { token: dani, body: { data: { szam: 'D-1', ugyfel: { nev: 'Fehér Bt.' }, datum: '2026-10-03' } } });

  let r = await call('GET', '/worksheets?user=Cili', { token: dani });
  assert.equal(r.body.total, 2);
  assert.equal(r.body.items[0].munkalapszam, 'K-11', 'legújabb dátum elöl');

  r = await call('GET', `/worksheets?q=${encodeURIComponent('fehér')}`, { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam).sort(), ['D-1', 'K-10']);

  r = await call('GET', '/worksheets?q=50%25', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-10']);

  r = await call('GET', '/worksheets?from=2026-10-01&to=2026-10-02', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-11']);

  r = await call('GET', '/worksheets?allapot=KÉSZ&user=Cili', { token: dani });
  assert.deepEqual(r.body.items.map((w) => w.munkalapszam), ['K-10']);

  const users = await call('GET', '/users', { token: dani });
  assert.equal(users.body.find((u) => u.name === 'Cili').worksheetCount, 2);
});

test('szinkron több eszköz között', async () => {
  const tel1 = await login('Eszter', 'eszter-tel');
  const tel2 = await login('Feri', 'feri-tel');

  const start = await call('POST', '/sync', { token: tel2, body: { since: 0 } });
  const cursor2 = start.body.cursor;

  const up = await call('POST', '/sync', {
    token: tel1,
    body: {
      since: 0,
      changes: [
        { id: 'offline-1', data: { munkalapszam: 'E-1', ugyfel: 'Kis Kft.' } },
        { id: 'offline-2', data: { munkalapszam: 'E-2' } },
        { id: 'rossz', data: 'nem objektum' },
      ],
    },
  });
  assert.deepEqual(up.body.results.map((x) => x.status), ['created', 'created', 'error']);

  const down = await call('POST', '/sync', { token: tel2, body: { since: cursor2 } });
  assert.deepEqual(down.body.items.map((w) => w.id), ['offline-1', 'offline-2']);
  assert.equal(down.body.items[0].createdBy.name, 'Eszter');

  const again = await call('POST', '/sync', { token: tel2, body: { since: down.body.cursor } });
  assert.equal(again.body.items.length, 0);
  assert.equal(again.body.cursor, down.body.cursor);

  const paged = await call('POST', '/sync', { token: tel2, body: { since: 0, limit: 1 } });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.hasMore, true);
});
