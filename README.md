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

## Munkalap módosítása, változatok

- Beküldött munkalap **módosítható** a böngészőben (részletek → „Szerkesztés”) és az appban
  (Korábbi munkalapok → munkalap → ceruza ikon).
- A **DRI szám ugyanaz marad**, az aláírások nem változnak.
- A szerver **új PDF-et készít**, rajta pirossal, a „Hely, dátum” sor mellett:
  `Módosítás dátuma: 2026.10.12. 14:35`.
- A **régi változat és a régi PDF megmarad**. A listában a módosított munkalapoknál „N× módosítva” jelzés és
  egy „Változatok ▾” lenyíló látható. Ebben minden változat megnyitható, és látszik, mi változott (régi → új).
- A szerver a PDF-hez a `server/assets/sablon.png` hátteret használja (ugyanaz a kép, mint az appban az
  `assets/sablon.png`), és a `server/fonts/` mappa Roboto betűtípusát.

## Admin felület

A böngészős felület jobb felső sarkában az **Admin** link, vagy közvetlenül: `https://munkalap.drindustrie.hu/admin.html`

- Csak az `ADMIN_EMAILS` beállításban felsorolt e-mail címekkel lehet belépni (lásd lent).
- **Első belépés:** az e-mail cím beírása után a felület jelszó beállítását kéri (legalább 8 karakter).
  Ehhez egyszer meg kell adni az alkalmazáskulcsot (`APP_KEY`) is, hogy idegen ne állíthasson be jelszót.
- A jelszó a „Jelszó” fülön módosítható. 10 hibás próbálkozás után 15 percig nem lehet belépni.
- A belépés 12 óráig érvényes.

Fülek:
| Fül | Tartalom |
|-----|----------|
| Áttekintés | munkalapok, módosítások, törlések, kiküldött e-mailek száma, munkalapok naponta, felhasználónként |
| Km és helyszínek | összes megtett km, km emberenként (összesen sorral), helyszínek (hány munkalap, km, kik jártak ott), nem értelmezhető km értékek |
| Napló | ki, mikor, mit csinált: új munkalap, módosítás (előtte → utána, mindkét PDF), törlés, visszaállítás, e-mail, admin belépés |
| Törölt munkalapok | a törölt munkalapok, visszaállítás gombbal |
| Felhasználók | ki hány munkalapot rögzített, mikor volt utoljára aktív, milyen eszközökön |
| Jelszó | jelszócsere |

A felső sávban **dátumválasztó (ettől – eddig)** és gyorsgombok (ez a hónap, előző hónap, idén, összes). Minden
fül ezt az időszakot mutatja. Az **Excel export (CSV)** gomb az időszak munkalapjait tölti le.

A km összesítés a „Megtett km” mezőben lévő első számot veszi (pl. „120 km” → 120, „45,5” → 45,5).
Ahol nincs szám, azt a „Nem értelmezhető km értékek” lista mutatja.

## Felépítés

```
app/lib/
  main.dart                 az app (módosítva: szerverre mentés, e-mail a szerverről, új gombok)
  szerver_beallitas.dart    a szerver címe és az alkalmazáskulcs (csak ezt kell átírni)
  munkalap_api.dart         kapcsolat a szerverrel + várólista net nélküli munkához
  korabbi_munkalapok.dart   Korábbi munkalapok képernyő (keresés, PDF, e-mail újraküldés)
server/                     Node.js + Express + SQLite szerver
  src/app.js                API végpontok (admin végpontok is)
  src/db.js                 adatbázis-séma
  src/pdf.js                a módosított munkalapok PDF-je
  assets/sablon.png         a PDF háttere (ide kell feltölteni, lásd lent)
  fonts/                    Roboto betűtípus a PDF-hez
  public/index.html         böngészős kereső felület
  public/admin.html         admin felület (statisztika, napló)
  test/                     automata tesztek (npm test)
docker-compose.yml          telepítés Dockerrel
```

## DRI munkalapszámok

- A számot **a szerver osztja ki**, sorban: `0002001`, `0002002`, ... (7 jegy, elöl nullákkal, mint a papíros tömbökön).
  Az első szám **0002001**, mert a papíros tömbök utolsó száma 0002000 volt.
- Az app az új munkalap megnyitásakor lefoglal egy számot, és kiírja (lakat ikonnal), de **szerkeszteni nem lehet**.
  Beküldéskor a szerver mindig a lefoglalt számot írja a munkalapra, akármit küld az app.
- **Egyszerre többen** is nyithatnak új munkalapot: a szerver a kéréseket sorban szolgálja ki, ezért két munkalap
  soha nem kaphat ugyanolyan számot (az adatbázis is tiltja).
- Ha egy munkalapot nem küldenek be, a lefoglalt szám nem vész el: az app újraindítás után és az „Új munkalap”
  gomb után is ugyanazt a számot használja, amíg a munkalapot be nem küldik.
- Törölt munkalap száma nem kerül újra kiosztásra (mint egy elrontott papírlap).
- A számláló aktuális értéke a VPS-en:
  ```bash
  cd /opt/munkalap/server && node -e "const D=require('better-sqlite3');const db=new D('/opt/munkalap/data/munkalap.db');console.log(db.prepare(\"SELECT value FROM meta WHERE key='dri_kovetkezo'\").get())"
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

**A PDF háttérképe:** a Flutter projekt `assets/sablon.png` fájlját fel kell tölteni a szerverre ide:
`server/assets/sablon.png`. Enélkül a módosítás menti az adatokat, de új PDF nem készül.

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
| `DRI_KEZDO`      | `2001`                 | Az első kiosztandó DRI szám (csak az adatbázis első létrehozásakor számít) |
| `ADMIN_EMAILS`   | nincs                  | Az admin felületre beléphető e-mail címek, vesszővel elválasztva (pl. `fonok@drindustrie.hu,iroda@drindustrie.hu`) |
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

1. Az `app/lib/` mappa fájljait másold be a Flutter projekt `lib/` mappájába:
   `main.dart`, `szerver_beallitas.dart`, `munkalap_api.dart`, `korabbi_munkalapok.dart`.
2. A `szerver_beallitas.dart`-ban írd át a két beállítást:
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
| `POST /api/dri/foglalas` `{ worksheetId }` | DRI munkalapszám lefoglalása (ugyanarra a munkalapra mindig ugyanazt adja) |
| `PUT /api/worksheets/:id/modositas` `{ data }` | Munkalap módosítása (új PDF készül, a régi változat megmarad) |
| `GET /api/worksheets/:id/valtozatok` | Az eredeti és a módosított változatok |
| `GET /api/worksheets/:id/valtozatok/:n/pdf` | Egy változat PDF-je (0 = eredeti) |
| `/api/admin/...` | Admin végpontok: `belepes`, `elso-jelszo`, `jelszo`, `attekintes`, `statisztika`, `naplo`, `torolt`, `visszaallitas/:id`, `felhasznalok`, `export.csv` |
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
