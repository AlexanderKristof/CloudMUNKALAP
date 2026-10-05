# CloudMUNKALAP – szerver a munkalapprogramhoz

Ez a VPS-en futó szerver és adatbázis a munkalapprogram mobilalkalmazáshoz. Több ember
több telefonról tud rá menteni, a szerver pedig egy helyen tárolja és kereshetővé teszi a munkalapokat.

- **Bejelentkezés csak névvel**, jelszó nélkül. A név arra kell, hogy látszódjon, ki rögzítette
  vagy módosította a munkalapot. Ugyanaz a név (kis- és nagybetűtől függetlenül) mindig ugyanazt a felhasználót jelenti.
- **Közös alkalmazáskulcs (`APP_KEY`)**: a VPS az internetről bárki számára elérhető, ezért egy közös
  kulcsot kell beírni az appba. Enélkül bárki tudna adatot írni a szerverre. Ezt nem a felhasználóknak
  kell megjegyezniük, egyszer kerül bele az appba.
- **Minden munkalapnál eltárolja**, ki hozta létre, ki módosította utoljára, melyik eszközről és mikor.
- **Szinkron több eszköz között**: offline mentett munkalapok felküldése, a másoktól jött változások letöltése, mindez egy hívással.
- **Semmi nem vész el**: minden felülírt vagy törölt változat bekerül az előzményekbe. A törlés csak megjelölés.
- **Keresés** név, szabad szöveg, dátum, állapot és eszköz szerint. A böngészős felület a szerver címén érhető el.
- Az adatbázis **SQLite**, egyetlen fájl (`data/munkalap.db`), így a mentés egy fájl másolása.

## Felépítés

```
server/            Node.js + Express szerver
  src/db.js          adatbázis-séma
  src/app.js         API végpontok
  public/index.html  böngészős kereső felület
  test/              automata tesztek (npm test)
kliens-minta/      minta kód az app bekötéséhez (Flutter és React Native)
docker-compose.yml telepítés Dockerrel
```

## Telepítés a VPS-re

### A) Dockerrel (ajánlott)

```bash
git clone https://github.com/AlexanderKristof/CloudMUNKALAP.git
cd CloudMUNKALAP
cp .env.example .env
nano .env            # APP_KEY=egy hosszú véletlen szöveg, pl. az: openssl rand -hex 24 kimenete
docker compose up -d --build
```

Az adatbázis a `CloudMUNKALAP/data/munkalap.db` fájlban lesz.

### B) Docker nélkül (Node.js 20+)

```bash
cd CloudMUNKALAP/server
npm ci --omit=dev
APP_KEY=a-kulcsod PORT=3000 DB_FILE=/var/lib/munkalap/munkalap.db node src/index.js
```

Ha automatikusan indulnia kell, systemd szolgáltatás kell hozzá, például `/etc/systemd/system/munkalap.service` néven:

```ini
[Unit]
Description=Munkalap szerver
After=network.target

[Service]
WorkingDirectory=/opt/CloudMUNKALAP/server
Environment=APP_KEY=a-kulcsod
Environment=DB_FILE=/var/lib/munkalap/munkalap.db
ExecStart=/usr/bin/node src/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Utána: `systemctl enable --now munkalap`.

### HTTPS (fontos!)

Az Android és az iOS alapból **nem enged sima `http://` kapcsolatot**, ezért a szervert HTTPS mögé kell tenni.
A legegyszerűbb a [Caddy](https://caddyserver.com), mert magától intéz ingyenes tanúsítványt. Ehhez kell egy
domain vagy aldomain, ami a VPS IP-címére mutat. A `/etc/caddy/Caddyfile` tartalma:

```
munkalap.sajatdomain.hu {
    reverse_proxy localhost:3000
}
```

Ezután a `docker-compose.yml`-ben a port sort érdemes `"127.0.0.1:3000:3000"`-ra cserélni, hogy a szerver
csak a Caddy-n keresztül legyen elérhető.

### Beállítások (környezeti változók)

| Változó      | Alapérték            | Jelentés |
|--------------|----------------------|----------|
| `APP_KEY`    | nincs                | Közös kulcs, ezt kell az appnak küldenie belépéskor. **Állítsd be!** |
| `PORT`       | `3000`               | Port |
| `DB_FILE`    | `./data/munkalap.db` | Az adatbázis fájl helye |
| `BODY_LIMIT` | `25mb`               | Egy kérés maximális mérete (pl. ha fotó vagy aláírás is van a munkalapban) |

### Biztonsági mentés

```bash
sqlite3 data/munkalap.db ".backup 'mentes-$(date +%F).db'"
```

Ezt cronból naponta érdemes futtatni.

## Az app bekötése

A `kliens-minta/` mappában van egy kész osztály Flutterhez (`munkalap_api.dart`) és egy React Native-hoz
(`munkalapApi.js`). A lépések:

1. **Első indításkor** kérd be a nevet, és hívd meg a `login(nev)`-et. A token el lesz mentve, így
   legközelebb a `betolt()` igazat ad, és nem kell újra belépni.
2. **Új munkalapnál** generálj azonosítót (`ujAzonosito()`, UUID), és tedd bele a munkalap `id` mezőjébe.
   Mivel az azonosítót a telefon adja, offline is lehet munkalapot létrehozni, és két telefon sem ütközik.
3. **Mentéskor**: ha van net, `mentes(munkalap)`. Ha nincs, `sorbaAllit(munkalap)`.
4. **Indításkor vagy frissítéskor**: `szinkron()`. Felküldi a várólistát, és visszaadja a más eszközökön
   változott munkalapokat. Ezeket id alapján írd felül a helyi tárolóban, a `deleted: true` jelzésűeket töröld.

A szerver a munkalapot **úgy tárolja, ahogy az app küldi** (tetszőleges JSON objektum). A kereséshez
ezeket a mezőket külön is kiemeli, ha megtalálja őket:

| Oszlop         | Elfogadott mezőnevek a munkalapban |
|----------------|------------------------------------|
| `munkalapszam` | `munkalapszam`, `munkalapSzam`, `szam`, `sorszam`, `number` |
| `ugyfel`       | `ugyfel`, `ugyfelNev`, `ugyfelnev`, `megrendelo`, `customer`, `customerName` (vagy `{ "nev": ... }` objektum) |
| `datum`        | `datum`, `date`, `kelt`, `munkavegzesDatuma` (ajánlott formátum: `2026-10-05`) |
| `allapot`      | `allapot`, `statusz`, `status`, `state` |

A szabad szöveges keresés a munkalap teljes tartalmában keres.

## API röviden

Minden végpont `/api` alatt van. A belépés után a tokent `Authorization: Bearer <token>` fejlécben kell küldeni.

| Kérés | Leírás |
|-------|--------|
| `POST /api/login` `{ name, deviceId, deviceName }` + `X-App-Key` fejléc | Belépés névvel. Válasz: `{ token, user }` |
| `POST /api/logout` | Kilépés |
| `GET /api/me` | Ki vagyok |
| `GET /api/users` | Felhasználók és a munkalapjaik száma |
| `GET /api/worksheets?q=&user=&from=&to=&allapot=&device=&limit=&offset=` | Keresés. A `user` lehet id vagy név |
| `GET /api/worksheets/:id` | Egy munkalap |
| `GET /api/worksheets/:id/history` | Korábbi változatok |
| `PUT /api/worksheets/:id` `{ data, baseVersion }` | Mentés (új vagy módosítás) |
| `POST /api/worksheets` `{ data }` | Új munkalap, az azonosítót a szerver adja |
| `DELETE /api/worksheets/:id` | Törlés (csak megjelölés) |
| `POST /api/sync` `{ since, changes: [{ id, data, deleted, baseVersion }] }` | Szinkron. Válasz: `{ results, items, cursor, hasMore }` |

**Ütközés:** ha két telefon ugyanazt a munkalapot módosítja, az utolsó mentés lesz az aktuális. Ha az app
elküldi a `baseVersion`-t (azt a verziószámot, amiből a módosítás kiindult), és közben valaki más már
mentett, a válaszban `conflict: true` jön. Ilyenkor az app figyelmeztethet, a korábbi változat pedig ott
van a `/history` alatt.

## Fejlesztés

```bash
cd server
npm install
npm test        # automata tesztek
npm start       # http://localhost:3000
```
