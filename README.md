# CloudMUNKALAP – DR Industrie munkalap app + szerver

A munkalapprogram (Flutter app) és a hozzá tartozó, VPS-en futó szerver. Több szerelő több telefonról
küld be munkalapot, a szerver egy helyen tárolja őket, és kereshetővé teszi.

**Mi történik a „PDF GENERÁLÁS ÉS MENTÉS” gombra:**
1. Az app elkészíti a PDF-et, mint eddig.
2. Az adatokat, a két aláírást és a PDF-et elmenti a telefonra (várólista), majd felküldi a szerverre.
3. A szerver elmenti az adatbázisba. **E-mail alapból nem megy ki.** Ha a gomb fölött bepipálják a
   „PDF elküldése e-mailben az ügyfélnek” négyzetet, akkor **a szerver küldi el** a PDF-et az ügyfélnek, másolatban
   a szerelőnek. Utólag is elküldhető a „Korábbi munkalapok” képernyőről vagy a böngészős felületről.
   Az e-mail küldéshez a szerveren be kell állítani az `SMTP_USER` / `SMTP_PASS` értékeket, addig a mentés e-mail nélkül működik.
4. Ha nincs net, a munkalap a telefonon marad, és a következő alkalommal automatikusan felmegy
   (app indításkor, a következő beküldéskor vagy a „Korábbi munkalapok” megnyitásakor).
5. Megnyílik a nyomtatás / megtekintés ablak, mint eddig.

**Bejelentkezés:** e-mail címmel, jelszó nélkül, ahogy eddig. A szerver ebből tudja, ki rögzítette a munkalapot.

**Keresés:**
- **Appban:** a felső sávban az óra ikon nyitja a „Korábbi munkalapok” képernyőt. Itt keresni lehet, és meg
  lehet nyitni egy munkalap PDF-jét, aláírásait, illetve újra lehet küldeni e-mailben.
- **Böngészőben:** a szerver címét megnyitva ugyanez elérhető, számítógépről is.

## Felépítés

```
app/lib/
  main.dart                 az app (módosítva: szerverre mentés, e-mail a szerverről, új gombok)
  munkalap_api.dart         kapcsolat a szerverrel + várólista net nélküli munkához
  korabbi_munkalapok.dart   Korábbi munkalapok képernyő (keresés, PDF, e-mail újraküldés)
server/                     Node.js + Express + SQLite szerver
  src/app.js                API végpontok
  src/db.js                 adatbázis-séma
  public/index.html         böngészős kereső felület
  test/                     automata tesztek (npm test)
docker-compose.yml          telepítés Dockerrel
```

## 1. A szerver telepítése a VPS-re

### Dockerrel (ajánlott)

```bash
git clone https://github.com/AlexanderKristof/CloudMUNKALAP.git
cd CloudMUNKALAP
cp .env.example .env
nano .env                 # APP_KEY, SMTP_USER, SMTP_PASS kitöltése
docker compose up -d --build
```

- Az `APP_KEY` egy hosszú, véletlen szöveg. Előállítható például az `openssl rand -hex 24` paranccsal.
  **Ugyanezt kell beírni az appba is.**
- Az `SMTP_USER` / `SMTP_PASS` az a Gmail cím és alkalmazásjelszó, ami eddig az appban volt.
  **Javasolt új alkalmazásjelszót létrehozni, és a régit törölni**, mert a régi benne van a telefonokra
  már feltelepített appban.

Minden adat a `CloudMUNKALAP/data/` mappában van: az adatbázis (`munkalap.db`) és a PDF-ek, aláírások (`files/`).

### Docker nélkül (Node.js 20+)

```bash
cd CloudMUNKALAP/server
npm ci --omit=dev
APP_KEY=... SMTP_USER=... SMTP_PASS=... DATA_DIR=/var/lib/munkalap node src/index.js
```

Ha automatikusan indulnia kell, systemd szolgáltatás kell hozzá: `/etc/systemd/system/munkalap.service`

```ini
[Unit]
Description=Munkalap szerver
After=network.target

[Service]
WorkingDirectory=/opt/CloudMUNKALAP/server
EnvironmentFile=/opt/CloudMUNKALAP/.env
Environment=DATA_DIR=/var/lib/munkalap
Environment=TZ=Europe/Budapest
ExecStart=/usr/bin/node src/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Utána: `systemctl enable --now munkalap`.

### HTTPS (kötelező a telefonos apphoz)

Az Android és az iOS alapból **nem enged sima `http://` kapcsolatot**. Kell egy domain vagy aldomain,
ami a VPS IP-címére mutat, és elé egy [Caddy](https://caddyserver.com), ami magától intéz ingyenes tanúsítványt.
A `/etc/caddy/Caddyfile` tartalma:

```
munkalap.sajatdomain.hu {
    reverse_proxy localhost:3000
}
```

Ezután a `docker-compose.yml`-ben a port sort érdemes `"127.0.0.1:3000:3000"`-ra cserélni, hogy a szerver
csak a Caddy-n keresztül legyen elérhető.

### Beállítások (környezeti változók)

| Változó          | Alapérték              | Jelentés |
|------------------|------------------------|----------|
| `APP_KEY`        | nincs                  | Közös kulcs, az app ezzel jelentkezik be. **Állítsd be!** |
| `SMTP_USER`      | nincs                  | E-mail fiók a küldéshez (Gmail cím). Ha nincs megadva, az e-mail küldés ki van kapcsolva |
| `SMTP_PASS`      | nincs                  | Jelszó (Gmailnél alkalmazásjelszó) |
| `SMTP_HOST`      | `smtp.gmail.com`       | SMTP szerver |
| `SMTP_PORT`      | `465`                  | SMTP port |
| `MAIL_FROM_NAME` | `DR Industrie Szerviz` | A feladó neve az e-mailben |
| `DATA_DIR`       | `./data`               | Adatbázis és fájlok helye |
| `PORT`           | `3000`                 | Port |

### Biztonsági mentés

Ezt a két dolgot kell menteni: az adatbázist és a `files` mappát.

```bash
sqlite3 data/munkalap.db ".backup 'mentes/munkalap-$(date +%F).db'"
tar czf mentes/fajlok-$(date +%F).tar.gz data/files
```

Ezt cronból naponta érdemes futtatni.

## 2. Az app frissítése

1. Az `app/lib/` mappa három fájlját másold be a Flutter projekt `lib/` mappájába:
   `main.dart`, `munkalap_api.dart`, `korabbi_munkalapok.dart`.
2. A `munkalap_api.dart` elején írd át a két beállítást:
   ```dart
   const String kSzerverCim = 'https://munkalap.sajatdomain.hu';
   const String kAppKulcs = 'ugyanaz, mint a szerveren az APP_KEY';
   ```
3. Függőségek a `pubspec.yaml`-ban:
   ```bash
   flutter pub remove mailer
   flutter pub add http uuid path_provider
   ```
4. Az `android/app/src/main/AndroidManifest.xml`-ben legyen internet engedély (a `<manifest>` alatt, az
   `<application>` elé). Enélkül a kiadott (release) app nem éri el a szervert:
   ```xml
   <uses-permission android:name="android.permission.INTERNET"/>
   ```

**Fontos – net nélküli munka:** az app a PDF betűtípusait (`PdfGoogleFonts`) az internetről tölti le.
Net nélkül ezért már a PDF elkészítése elakad, a munkalap el sem jut a várólistáig. Ha net nélkül is
dolgoztok, a Roboto betűtípust érdemes az appba csomagolni (`assets/` mappa), és onnan betölteni.

## API röviden

Minden végpont `/api` alatt van. Belépés után a tokent `Authorization: Bearer <token>` fejlécben kell küldeni.

| Kérés | Leírás |
|-------|--------|
| `POST /api/login` `{ email, deviceId, deviceName }` + `X-App-Key` fejléc | Belépés e-mail címmel. Válasz: `{ token, user }` |
| `PUT /api/worksheets/:id` (multipart: `data`, `kuldes`, `pdf`, `alairasUgyfel`, `alairasSzerviz`) | Munkalap mentése. `kuldes=1` esetén e-mailt is küld (csak egyszer, ismételt beküldéskor nem küldi újra) |
| `GET /api/worksheets?q=&user=&from=&to=` | Keresés. A `user` lehet id vagy e-mail; `from`/`to` a rögzítés napja (`2026-10-06`) |
| `GET /api/worksheets/:id` | Egy munkalap |
| `GET /api/worksheets/:id/files/pdf` (vagy `alairasUgyfel`, `alairasSzerviz`) | Fájl letöltése |
| `POST /api/worksheets/:id/email` `{ to }` | E-mail (újra)küldése |
| `GET /api/worksheets/:id/history` | Korábbi változatok |
| `DELETE /api/worksheets/:id` | Törlés (csak megjelölés, az adat megmarad) |
| `GET /api/users` | Felhasználók és munkalapjaik száma |
| `POST /api/sync` | Szinkron több eszköz között (változások lekérése egy kurzor óta) |

A munkalap adatai (`data`) az app mezőnevei szerint: `driSzam`, `ugyfel`, `ugyfelEmail`, `helyszin`, `gep`,
`idotartam`, `km`, `elvegzettMunka`, `hibaLeiras`, `datum`.

## Fejlesztés

```bash
cd server
npm install
npm test        # automata tesztek
npm start       # http://localhost:3000
```
