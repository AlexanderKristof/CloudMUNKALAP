// React Native minta az app és a VPS szerver összekötéséhez.
// Függőségek:  @react-native-async-storage/async-storage, react-native-get-random-values, uuid
//
//   import { MunkalapApi } from './munkalapApi';
//   const api = new MunkalapApi('https://munkalap.sajatdomain.hu', 'KULCS');
//   await api.login('Kovács Péter');
//   await api.mentes(munkalap);              // munkalap.id kötelező (MunkalapApi.ujAzonosito())
//   const valtozasok = await api.szinkron(); // indításkor / frissítéskor

import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { v4 as uuidv4 } from 'uuid';

export class MunkalapApi {
  constructor(baseUrl, appKey) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.appKey = appKey;
    this.token = null;
  }

  static ujAzonosito() {
    return uuidv4();
  }

  async _deviceId() {
    let id = await AsyncStorage.getItem('device_id');
    if (!id) {
      id = uuidv4();
      await AsyncStorage.setItem('device_id', id);
    }
    return id;
  }

  async _call(method, path, body) {
    const res = await fetch(this.baseUrl + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: 'Bearer ' + this.token } : {}),
        ...(this.appKey ? { 'X-App-Key': this.appKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Szerverhiba (${res.status})`);
    return data;
  }

  /** Igaz, ha már be van jelentkezve. */
  async betolt() {
    this.token = await AsyncStorage.getItem('token');
    return !!this.token;
  }

  /** Bejelentkezés csak névvel. */
  async login(nev, eszkozNev = 'Telefon') {
    const r = await this._call('POST', '/login', { name: nev, deviceId: await this._deviceId(), deviceName: eszkozNev });
    this.token = r.token;
    await AsyncStorage.setItem('token', r.token);
    return r.user;
  }

  async logout() {
    await this._call('POST', '/logout').catch(() => {});
    this.token = null;
    await AsyncStorage.removeItem('token');
  }

  mentes(munkalap, alapVerzio) {
    return this._call('PUT', '/worksheets/' + encodeURIComponent(munkalap.id), { data: munkalap, baseVersion: alapVerzio });
  }

  torles(id) {
    return this._call('DELETE', '/worksheets/' + encodeURIComponent(id));
  }

  /** Pl.: kereses({ q: 'Szabó' }), kereses({ user: 'Anna', from: '2026-10-01' }) */
  async kereses(szuro = {}) {
    const p = new URLSearchParams(Object.entries(szuro).filter(([, v]) => v));
    return (await this._call('GET', '/worksheets?' + p)).items;
  }

  /** Offline mentett munkalap a várólistába – a következő szinkron felküldi. */
  async sorbaAllit(munkalap, torolt = false) {
    const sor = JSON.parse((await AsyncStorage.getItem('varolista')) || '{}');
    sor[munkalap.id] = { id: munkalap.id, data: munkalap, deleted: torolt };
    await AsyncStorage.setItem('varolista', JSON.stringify(sor));
  }

  /**
   * Felküldi a várólistát, és visszaadja a más eszközökön változott munkalapokat.
   * A kapott elemeket mentsd el helyben (id alapján felülírva; deleted=true esetén töröld).
   */
  async szinkron() {
    const sor = JSON.parse((await AsyncStorage.getItem('varolista')) || '{}');
    let since = Number(await AsyncStorage.getItem('sync_cursor')) || 0;
    const kapott = [];
    let elso = true;
    for (;;) {
      const r = await this._call('POST', '/sync', { since, changes: elso ? Object.values(sor) : [] });
      if (elso) await AsyncStorage.removeItem('varolista');
      elso = false;
      kapott.push(...r.items);
      since = r.cursor;
      await AsyncStorage.setItem('sync_cursor', String(since));
      if (!r.hasMore) break;
    }
    return kapott;
  }
}
