// =============================================================================
// KORÁBBI MUNKALAPOK (óra ikon a munkalap képernyő tetején)
// =============================================================================
// Két képernyő van ebben a fájlban:
//   1. KorabbiMunkalapokScreen – lista a szerveren lévő munkalapokról, keresővel
//   2. MunkalapReszletekScreen – egy munkalap részletei: mezők, aláírások,
//      PDF megnyitása, e-mail küldése, törlés, módosítás, korábbi változatok
//   3. MunkalapSzerkesztesScreen – egy beküldött munkalap módosítása
//      (a DRI szám ugyanaz marad, a szerver új PDF-et készít pirossal a módosítás idejével)
// Az adatokat a szerverről kérjük le (munkalap_api.dart), ezért ehhez net kell.
// =============================================================================

import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import 'munkalap_api.dart';

// ---------------------------------------------------------------------------
// KORÁBBI MUNKALAPOK – keresés a szerveren
// ---------------------------------------------------------------------------
// Felül kereső mező (szám, ügyfél, gép, helyszín... alapján), alatta egy kapcsoló
// a saját munkalapokra, lent a lista. Lehúzással frissíthető.
class KorabbiMunkalapokScreen extends StatefulWidget {
  const KorabbiMunkalapokScreen({super.key});

  @override
  State<KorabbiMunkalapokScreen> createState() => _KorabbiMunkalapokScreenState();
}

class _KorabbiMunkalapokScreenState extends State<KorabbiMunkalapokScreen> {
  final TextEditingController _keresoController = TextEditingController(); // a kereső mező szövege
  Timer? _kesleltetes; // gépelés közben vár egy kicsit, mielőtt keres (ne minden betűnél kérdezzen)
  List<Map<String, dynamic>> _lista = []; // a szervertől kapott munkalapok
  bool _tolt = true; // igaz, amíg a lista töltődik (forgó jel)
  bool _csakSajat = false; // "Csak a saját munkalapjaim" kapcsoló
  String? _hiba; // ha nem sikerült elérni a szervert, itt a hibaüzenet
  int _varolista = 0; // hány munkalap vár még a telefonon feltöltésre

  /// A képernyő megnyitásakor azonnal betöltjük a listát.
  @override
  void initState() {
    super.initState();
    _frissit();
  }

  @override
  void dispose() {
    _kesleltetes?.cancel();
    _keresoController.dispose();
    super.dispose();
  }

  /// A lista frissítése: előbb felküldjük a telefonon várakozó munkalapokat,
  /// aztán lekérjük a szerverről a keresésnek megfelelő listát.
  Future<void> _frissit() async {
    setState(() {
      _tolt = true;
      _hiba = null;
    });
    final api = MunkalapApi.instance;
    try {
      await api.varolistaKuldes();
      final lista = await api.kereses(q: _keresoController.text, csakSajat: _csakSajat);
      final varolista = await api.varolistaHossz();
      if (!mounted) return;
      setState(() {
        _lista = lista;
        _varolista = varolista;
      });
    } catch (e) {
      final varolista = await api.varolistaHossz();
      if (!mounted) return;
      setState(() {
        _hiba = 'Nem sikerült elérni a szervert: $e';
        _varolista = varolista;
      });
    } finally {
      if (mounted) setState(() => _tolt = false);
    }
  }

  /// Gépeléskor hívódik: 0,4 mp-et vár az utolsó leütés után, és csak utána keres.
  void _keresesValtozott(String _) {
    _kesleltetes?.cancel();
    _kesleltetes = Timer(const Duration(milliseconds: 400), _frissit);
  }

  /// A szerver dátumát (pl. "2026-10-08T07:30:00.000Z") magyar formára alakítja: "2026.10.08. 09:30".
  String _datum(String? iso) {
    if (iso == null) return '';
    final d = DateTime.parse(iso).toLocal();
    String k(int n) => n.toString().padLeft(2, '0');
    return '${d.year}.${k(d.month)}.${k(d.day)}. ${k(d.hour)}:${k(d.minute)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Korábbi munkalapok'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: TextField(
              controller: _keresoController,
              onChanged: _keresesValtozott,
              decoration: const InputDecoration(
                hintText: 'Keresés: szám, ügyfél, gép, helyszín...',
                prefixIcon: Icon(Icons.search),
                border: OutlineInputBorder(),
                isDense: true,
              ),
            ),
          ),
          SwitchListTile(
            title: const Text('Csak a saját munkalapjaim'),
            value: _csakSajat,
            onChanged: (v) {
              setState(() => _csakSajat = v);
              _frissit();
            },
          ),
          // Sárga sáv, ha a telefonon még van fel nem töltött munkalap
          if (_varolista > 0)
            Container(
              width: double.infinity,
              color: Colors.amber.shade100,
              padding: const EdgeInsets.all(8),
              child: Text('$_varolista munkalap még a telefonon vár feltöltésre (nincs net).'),
            ),
          if (_hiba != null)
            Padding(padding: const EdgeInsets.all(12), child: Text(_hiba!, style: const TextStyle(color: Colors.red))),
          // A lista (lehúzással frissíthető)
          Expanded(
            child: RefreshIndicator(
              onRefresh: _frissit,
              child: _tolt && _lista.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : ListView.separated(
                      physics: const AlwaysScrollableScrollPhysics(),
                      itemCount: _lista.length,
                      separatorBuilder: (_, _) => const Divider(height: 1),
                      itemBuilder: (context, i) {
                        final w = _lista[i];
                        final email = w['email'] as Map<String, dynamic>;
                        final rogzitette = w['createdBy'] as Map<String, dynamic>;
                        // Egy sor: szám + ügyfél, alatta gép, helyszín, dátum, ki rögzítette;
                        // jobbra az e-mail állapota (zöld = elküldve, piros = hiba, szürke = nem ment ki)
                        return ListTile(
                          title: Text('DRI-${w['munkalapszam'] ?? ''}  ${w['ugyfel'] ?? ''}'),
                          subtitle: Text([
                            if ((w['gep'] ?? '').toString().isNotEmpty) w['gep'],
                            if ((w['helyszin'] ?? '').toString().isNotEmpty) w['helyszin'],
                            '${_datum(w['createdAt'] as String?)} · ${rogzitette['email']}',
                            // Ha módosították: hányszor (a régi változatok a részleteknél nézhetők meg)
                            if (((w['modositasokSzama'] as num?) ?? 0) > 0) '✎ ${w['modositasokSzama']}× módosítva',
                          ].join('\n')),
                          isThreeLine: true,
                          trailing: Icon(
                            email['status'] == 'kuldve' ? Icons.mark_email_read : Icons.mail_outline,
                            color: email['status'] == 'kuldve'
                                ? Colors.green
                                : (email['status'] == 'hiba' ? Colors.red : Colors.grey),
                          ),
                          // Koppintásra megnyílik a részletek képernyő; visszatéréskor frissül a lista
                          // (pl. ha közben törölték a munkalapot)
                          onTap: () async {
                            await Navigator.push(
                              context,
                              MaterialPageRoute(builder: (_) => MunkalapReszletekScreen(munkalap: w)),
                            );
                            _frissit();
                          },
                        );
                      },
                    ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// EGY MUNKALAP RÉSZLETEI
// ---------------------------------------------------------------------------
// Fent: ki rögzítette, e-mail állapot, PDF és E-mail gomb. Alatta a mezők, az
// aláírások és (ha módosították) a korábbi változatok, mindegyik a saját PDF-jével.
// Jobb felül: ceruza = módosítás, kuka = törlés megerősítő kérdéssel.
class MunkalapReszletekScreen extends StatefulWidget {
  /// A munkalap adatai, ahogy a szerver a listában küldte (id, munkalapszam, data, files, email...).
  final Map<String, dynamic> munkalap;
  const MunkalapReszletekScreen({super.key, required this.munkalap});

  @override
  State<MunkalapReszletekScreen> createState() => _MunkalapReszletekScreenState();
}

class _MunkalapReszletekScreenState extends State<MunkalapReszletekScreen> {
  bool _dolgozik = false; // igaz, amíg egy művelet fut (PDF letöltés, e-mail, törlés) – a gombok tiltva
  // Az aláírás képek letöltése: egyszer töltjük le őket, nem minden képernyőfrissítésnél.
  final Map<String, Future<Uint8List>> _alairasok = {};

  /// A megjelenítendő mezők: [kulcs a munkalap adataiban, felirat]. Az üres mezőket nem mutatjuk.
  static const _mezok = [
    ['ugyfel', 'Ügyfél'],
    ['ugyfelEmail', 'Ügyfél e-mail'],
    ['helyszin', 'Munkavégzés helye'],
    ['gep', 'Gép típusa'],
    ['idotartam', 'Időtartam'],
    ['km', 'Megtett km'],
    ['elvegzettMunka', 'Elvégzett munka'],
    ['hibaLeiras', 'Hiba leírása + javaslat'],
    ['datum', 'Hely, dátum'],
  ];

  /// A megjelenített munkalap. Módosítás után a szerver által visszaküldött új változatra cseréljük.
  late Map<String, dynamic> _w = widget.munkalap;

  /// A változatok listája a szerverről (csak ha a munkalapot már módosították).
  Future<List<Map<String, dynamic>>>? _valtozatok;

  @override
  void initState() {
    super.initState();
    _valtozatokBetoltese();
  }

  /// A változatok lekérése a szerverről – csak ha van mit mutatni (legalább egy módosítás).
  void _valtozatokBetoltese() {
    _valtozatok = ((_w['modositasokSzama'] as num?) ?? 0) > 0
        ? MunkalapApi.instance.valtozatok(_w['id'] as String)
        : null;
  }

  /// Ceruza ikon: megnyitja a szerkesztő képernyőt. Ha ott elmentették a módosítást,
  /// a szerver visszaküldi a frissített munkalapot, és azt mutatjuk tovább.
  Future<void> _szerkesztes() async {
    final uj = await Navigator.push<Map<String, dynamic>>(
      context,
      MaterialPageRoute(builder: (_) => MunkalapSzerkesztesScreen(munkalap: _w)),
    );
    if (uj == null || !mounted) return;
    setState(() {
      _w = uj;
      _valtozatokBetoltese();
    });
    _uzenet('Módosítás mentve. Az új PDF-en pirossal szerepel a módosítás ideje.');
  }

  /// Egy régebbi (vagy az aktuális) változat PDF-jének megnyitása.
  Future<void> _valtozatPdf(Map<String, dynamic> v) async {
    setState(() => _dolgozik = true);
    try {
      final sorszam = (v['sorszam'] as num).toInt();
      final bytes = await MunkalapApi.instance.valtozatPdf(_w['id'] as String, sorszam);
      await Printing.layoutPdf(
        onLayout: (_) async => bytes,
        name: 'Munkalap_DRI_${_w['munkalapszam'] ?? ''}${sorszam > 0 ? '_modositas_$sorszam' : ''}',
      );
    } catch (e) {
      _uzenet('Nem sikerült letölteni a PDF-et: $e');
    } finally {
      if (mounted) setState(() => _dolgozik = false);
    }
  }

  /// A változatok listája: eredeti + módosítások, mindegyiknél ki és mikor, mi változott, és PDF gomb.
  Widget _valtozatokLista() {
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _valtozatok,
      builder: (context, snap) {
        if (snap.hasError) return Text('A változatok nem tölthetők be: ${snap.error}');
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final mezoNev = {for (final m in _mezok) m[0]: m[1]};
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final v in snap.data!)
              Card(
                margin: const EdgeInsets.only(bottom: 8),
                child: ListTile(
                  title: Text(
                    v['cim'] as String,
                    style: TextStyle(
                      fontWeight: FontWeight.bold,
                      color: (v['sorszam'] as num) > 0 ? Colors.red.shade700 : null,
                    ),
                  ),
                  subtitle: Text([
                    '${_datum(v['ts'] as String?)} · ${v['ki'] ?? ''}',
                    // Mi változott az előző változathoz képest: "Megtett km: 120 → 130"
                    for (final c in (v['valtozasok'] as List).cast<Map<String, dynamic>>())
                      '${mezoNev[c['mezo']] ?? c['mezo']}: ${_ures(c['elotte'])} → ${_ures(c['utana'])}',
                  ].join('\n')),
                  trailing: v['pdf'] == true
                      ? IconButton(
                          icon: const Icon(Icons.picture_as_pdf),
                          tooltip: 'PDF megnyitása',
                          onPressed: _dolgozik ? null : () => _valtozatPdf(v),
                        )
                      : null,
                ),
              ),
          ],
        );
      },
    );
  }

  /// Üres érték jelzése a változások listájában.
  String _ures(Object? v) => (v ?? '').toString().isEmpty ? '(üres)' : v.toString();

  /// Dátum magyar formában, percre pontosan: "2026.10.12. 14:35".
  String _datum(String? iso) {
    if (iso == null) return '';
    final d = DateTime.parse(iso).toLocal();
    String k(int n) => n.toString().padLeft(2, '0');
    return '${d.year}.${k(d.month)}.${k(d.day)}. ${k(d.hour)}:${k(d.minute)}';
  }

  /// PDF gomb: letölti a PDF-et a szerverről, és megnyitja a nyomtatás / megosztás ablakban.
  Future<void> _pdfMegnyitas() async {
    setState(() => _dolgozik = true);
    try {
      final bytes = await MunkalapApi.instance.fajl(_w['id'] as String, 'pdf');
      await Printing.layoutPdf(onLayout: (_) async => bytes, name: 'Munkalap_DRI_${_w['munkalapszam'] ?? ''}');
    } catch (e) {
      _uzenet('Nem sikerült letölteni a PDF-et: $e');
    } finally {
      if (mounted) setState(() => _dolgozik = false);
    }
  }

  /// E-mail gomb: megkérdezi a címzettet (alapból az ügyfél e-mail címe), majd a szerver elküldi a PDF-et.
  Future<void> _emailKuldes() async {
    final data = _w['data'] as Map<String, dynamic>;
    final controller = TextEditingController(text: (data['ugyfelEmail'] ?? '').toString());
    final cimzett = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('E-mail küldése'),
        content: TextField(
          controller: controller,
          keyboardType: TextInputType.emailAddress,
          decoration: const InputDecoration(labelText: 'Címzett'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Mégse')),
          ElevatedButton(onPressed: () => Navigator.pop(context, controller.text.trim()), child: const Text('Küldés')),
        ],
      ),
    );
    if (cimzett == null || cimzett.isEmpty) return;
    setState(() => _dolgozik = true);
    try {
      final r = await MunkalapApi.instance.emailKuldes(_w['id'] as String, cimzett: cimzett);
      _uzenet(r.emailStatus == 'kuldve' ? 'Elküldve: $cimzett' : 'Nem sikerült elküldeni: ${r.emailHiba ?? ''}');
    } catch (e) {
      _uzenet('Nem sikerült elküldeni: $e');
    } finally {
      if (mounted) setState(() => _dolgozik = false);
    }
  }

  /// Kuka ikon: rákérdez, majd törli a munkalapot. A szerveren csak töröltnek jelöli,
  /// így véletlen törlés esetén az adat visszaállítható. Utána visszalép a listára.
  Future<void> _torles() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Munkalap törlése'),
        content: Text('Biztosan törlöd a DRI-${_w['munkalapszam'] ?? ''} munkalapot?'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Mégse')),
          ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.red, foregroundColor: Colors.white),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Törlés'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _dolgozik = true);
    try {
      await MunkalapApi.instance.torles(_w['id'] as String);
      if (!mounted) return;
      _uzenet('Munkalap törölve.');
      Navigator.pop(context);
    } catch (e) {
      _uzenet('Nem sikerült törölni: $e');
      if (mounted) setState(() => _dolgozik = false);
    }
  }

  /// Rövid üzenet alul a képernyőn.
  void _uzenet(String szoveg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(szoveg)));
  }

  /// Egy aláírás megjelenítése: cím + a szerverről letöltött kép (töltés közben forgó jel).
  Widget _alairas(String fajta, String cim) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(cim, style: const TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 4),
        FutureBuilder(
          future: _alairasok.putIfAbsent(fajta, () => MunkalapApi.instance.fajl(_w['id'] as String, fajta)),
          builder: (context, snap) => Container(
            height: 80,
            width: double.infinity,
            decoration: BoxDecoration(color: Colors.white, border: Border.all(color: Colors.grey)),
            child: snap.hasData
                ? Image.memory(snap.data!, fit: BoxFit.contain)
                : Center(child: snap.hasError ? const Text('Nem tölthető be') : const CircularProgressIndicator()),
          ),
        ),
        const SizedBox(height: 12),
      ],
    );
  }

  /// A részletek képernyő kinézete.
  @override
  Widget build(BuildContext context) {
    final data = _w['data'] as Map<String, dynamic>; // az űrlap mezői
    final files = _w['files'] as Map<String, dynamic>; // van-e PDF / aláírás a szerveren
    final email = _w['email'] as Map<String, dynamic>; // e-mail állapot: kuldve / hiba / nincs
    final rogzitette = _w['createdBy'] as Map<String, dynamic>;
    return Scaffold(
      appBar: AppBar(
        title: Text('DRI-${_w['munkalapszam'] ?? ''}'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.edit),
            tooltip: 'Módosítás',
            onPressed: _dolgozik ? null : _szerkesztes,
          ),
          IconButton(
            icon: const Icon(Icons.delete),
            tooltip: 'Törlés',
            onPressed: _dolgozik ? null : _torles,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Rögzítette: ${rogzitette['email']}', style: const TextStyle(color: Colors.grey)),
          Text(
            'E-mail: ${{'kuldve': 'elküldve', 'hiba': 'hiba – ${email['error'] ?? ''}', 'nincs': 'nem ment ki'}[email['status']] ?? email['status']}',
            style: const TextStyle(color: Colors.grey),
          ),
          // Ha módosították: hányszor (a változatok lent láthatók)
          if (((_w['modositasokSzama'] as num?) ?? 0) > 0)
            Text(
              '${_w['modositasokSzama']}× módosítva',
              style: TextStyle(color: Colors.red.shade700, fontWeight: FontWeight.bold),
            ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.deepOrange, foregroundColor: Colors.white),
                  onPressed: _dolgozik || files['pdf'] != true ? null : _pdfMegnyitas,
                  icon: const Icon(Icons.picture_as_pdf),
                  label: const Text('PDF'),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _dolgozik || files['pdf'] != true ? null : _emailKuldes,
                  icon: const Icon(Icons.send),
                  label: const Text('E-mail'),
                ),
              ),
            ],
          ),
          if (_dolgozik) const LinearProgressIndicator(),
          const SizedBox(height: 16),
          // A kitöltött mezők egymás alatt: félkövér felirat + érték
          for (final m in _mezok)
            if ((data[m[0]] ?? '').toString().isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(m[1], style: const TextStyle(fontWeight: FontWeight.bold)),
                    Text(data[m[0]].toString()),
                  ],
                ),
              ),
          if (files['alairasUgyfel'] == true) _alairas('alairasUgyfel', 'Ügyfél aláírása'),
          if (files['alairasSzerviz'] == true) _alairas('alairasSzerviz', 'Szerviz aláírása'),
          // Korábbi változatok (csak ha a munkalapot már módosították)
          if (_valtozatok != null) ...[
            const SizedBox(height: 8),
            const Text('Változatok', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            _valtozatokLista(),
          ],
        ],
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// MUNKALAP MÓDOSÍTÁSA
// ---------------------------------------------------------------------------
// A beküldött munkalap mezői szerkeszthetők. A DRI szám és az aláírások nem
// változnak. Mentéskor a szerver:
//   - megtartja a régi változatot és a régi PDF-et (a "Változatok" részben megnézhető),
//   - új PDF-et készít, rajta pirossal: "Módosítás dátuma: 2026.10.12. 14:35",
//   - a naplóba beírja, ki, mikor és mit módosított.
// Ehhez net kell (a módosítás nem kerül várólistára).
class MunkalapSzerkesztesScreen extends StatefulWidget {
  /// A módosítandó munkalap (ahogy a szerver küldte).
  final Map<String, dynamic> munkalap;
  const MunkalapSzerkesztesScreen({super.key, required this.munkalap});

  @override
  State<MunkalapSzerkesztesScreen> createState() => _MunkalapSzerkesztesScreenState();
}

class _MunkalapSzerkesztesScreenState extends State<MunkalapSzerkesztesScreen> {
  /// A módosítható mezők: [kulcs, felirat, többsoros-e]. Ugyanazok, mint a szerveren.
  static const _mezok = [
    ['ugyfel', 'Ügyfél', false],
    ['ugyfelEmail', 'Ügyfél e-mail', false],
    ['helyszin', 'Munkavégzés helye', false],
    ['gep', 'Gép típusa', false],
    ['idotartam', 'Munkavégzés időtartama', false],
    ['km', 'Megtett km', false],
    ['elvegzettMunka', 'Elvégzett munka', true],
    ['hibaLeiras', 'Hiba leírása + javaslat', true],
    ['datum', 'Hely, dátum', false],
  ];

  /// Mezőnként egy szövegmező-vezérlő, az eredeti értékkel kitöltve.
  late final Map<String, TextEditingController> _vezerlok;
  late final Map<String, String> _eredeti; // a módosítás előtti értékek (ehhez hasonlítunk)
  bool _ment = false; // igaz, amíg a mentés fut

  @override
  void initState() {
    super.initState();
    final data = widget.munkalap['data'] as Map<String, dynamic>;
    _eredeti = {for (final m in _mezok) m[0] as String: (data[m[0]] ?? '').toString()};
    _vezerlok = {for (final e in _eredeti.entries) e.key: TextEditingController(text: e.value)};
  }

  @override
  void dispose() {
    for (final c in _vezerlok.values) {
      c.dispose();
    }
    super.dispose();
  }

  /// Azok a mezők, amelyek eltérnek az eredetitől: {kulcs: új érték}.
  Map<String, String> get _valtozott => {
        for (final e in _vezerlok.entries)
          if (e.value.text != _eredeti[e.key]) e.key: e.value.text,
      };

  /// Mentés gomb: rákérdez (felsorolja, mi változik), majd elküldi a szervernek.
  /// Siker esetén visszalép, és visszaadja a frissített munkalapot a részletek képernyőnek.
  Future<void> _mentes() async {
    final valtozott = _valtozott;
    if (valtozott.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Nem változott semmi.')));
      return;
    }
    final nevek = {for (final m in _mezok) m[0]: m[1]};
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Módosítás mentése'),
        content: Text(
          'Ezek a mezők változnak:\n${valtozott.keys.map((k) => '• ${nevek[k]}').join('\n')}\n\n'
          'A DRI szám ugyanaz marad. Új PDF készül, rajta pirossal a módosítás ideje; '
          'a régi változat megmarad.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Mégse')),
          ElevatedButton(onPressed: () => Navigator.pop(context, true), child: const Text('Mentés')),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _ment = true);
    try {
      final uj = await MunkalapApi.instance.modositas(widget.munkalap['id'] as String, valtozott);
      if (!mounted) return;
      Navigator.pop(context, uj);
    } catch (e) {
      if (!mounted) return;
      setState(() => _ment = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Nem sikerült menteni: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('DRI-${widget.munkalap['munkalapszam'] ?? ''} módosítása'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          // A DRI szám nem módosítható – csak megjelenítjük, lakat ikonnal
          InputDecorator(
            decoration: const InputDecoration(
              labelText: 'Munkalap száma',
              border: OutlineInputBorder(),
              suffixIcon: Icon(Icons.lock_outline),
            ),
            child: Text('DRI-${widget.munkalap['munkalapszam'] ?? ''}'),
          ),
          const SizedBox(height: 12),
          for (final m in _mezok)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: TextField(
                controller: _vezerlok[m[0]],
                enabled: !_ment,
                minLines: m[2] == true ? 3 : 1,
                maxLines: m[2] == true ? 8 : 1,
                keyboardType: m[0] == 'ugyfelEmail'
                    ? TextInputType.emailAddress
                    : (m[2] == true ? TextInputType.multiline : TextInputType.text),
                decoration: InputDecoration(labelText: m[1] as String, border: const OutlineInputBorder()),
              ),
            ),
          const Text(
            'Az aláírások nem módosíthatók.',
            style: TextStyle(color: Colors.grey),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 48,
            child: ElevatedButton.icon(
              style: ElevatedButton.styleFrom(backgroundColor: Colors.deepOrange, foregroundColor: Colors.white),
              onPressed: _ment ? null : _mentes,
              icon: _ment
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Icon(Icons.save),
              label: const Text('MÓDOSÍTÁS MENTÉSE'),
            ),
          ),
        ],
      ),
    );
  }
}
