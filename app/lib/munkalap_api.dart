import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

// ---------------------------------------------------------------------------
// SZERVER BEÁLLÍTÁSOK – ezt a kettőt kell átírni a saját VPS-hez
// ---------------------------------------------------------------------------
const String kSzerverCim = 'https://munkalap.sajatdomain.hu';
const String kAppKulcs = 'IDE_JON_AZ_APP_KEY';

/// Egy munkalap beküldésének eredménye.
class BekuldesEredmeny {
  /// Igaz, ha a munkalap felért a szerverre. Ha hamis, a várólistában van,
  /// és a következő alkalommal (app indításkor / következő beküldéskor) automatikusan felmegy.
  final bool feltoltve;
  final String? emailStatus; // 'kuldve' | 'hiba' | 'nincs'
  final String? emailHiba;
  final String? hiba;

  const BekuldesEredmeny({required this.feltoltve, this.emailStatus, this.emailHiba, this.hiba});

  String get uzenet {
    if (!feltoltve) {
      return 'Nincs kapcsolat a szerverrel. A munkalap el van mentve a telefonon, '
          'és automatikusan felmegy, ha lesz net.';
    }
    switch (emailStatus) {
      case 'kuldve':
        return 'Munkalap mentve és elküldve e-mailben!';
      case 'hiba':
        return 'Munkalap mentve, de az e-mail nem ment ki: ${emailHiba ?? ''}';
      default:
        return emailStatus == null ? 'Munkalap mentve.' : 'Munkalap mentve. ${emailHiba ?? ''}'.trim();
    }
  }
}

class SzerverHiba implements Exception {
  final int statusz;
  final String uzenet;
  SzerverHiba(this.statusz, this.uzenet);
  @override
  String toString() => uzenet;
}

/// A szerverrel való kommunikáció: bejelentkezés, beküldés (várólistával), keresés, letöltés.
class MunkalapApi {
  MunkalapApi._();
  static final MunkalapApi instance = MunkalapApi._();

  static const _timeout = Duration(seconds: 60);
  String? _token;
  bool _varolistaFut = false;

  static String ujAzonosito() => const Uuid().v4();

  // --- Bejelentkezés -------------------------------------------------------

  Future<String> _eszkozAzonosito() async {
    final p = await SharedPreferences.getInstance();
    var id = p.getString('device_id');
    if (id == null) {
      id = const Uuid().v4();
      await p.setString('device_id', id);
    }
    return id;
  }

  /// Bejelentkezés a szerverre a megadott e-mail címmel (jelszó nincs).
  Future<void> login(String email) async {
    final res = await http
        .post(Uri.parse('$kSzerverCim/api/login'),
            headers: {'Content-Type': 'application/json', 'X-App-Key': kAppKulcs},
            body: jsonEncode({
              'email': email,
              'deviceId': await _eszkozAzonosito(),
              'deviceName': '${Platform.operatingSystem} – $email',
            }))
        .timeout(_timeout);
    final body = _ellenoriz(res);
    _token = body['token'] as String;
    final p = await SharedPreferences.getInstance();
    await p.setString('szerver_token', _token!);
    await p.setString('szerver_token_email', email);
  }

  Future<void> logout() async {
    final p = await SharedPreferences.getInstance();
    final token = _token ?? p.getString('szerver_token');
    _token = null;
    await p.remove('szerver_token');
    await p.remove('szerver_token_email');
    if (token != null) {
      try {
        await http.post(Uri.parse('$kSzerverCim/api/logout'), headers: {'Authorization': 'Bearer $token'}).timeout(_timeout);
      } catch (_) {}
    }
  }

  /// Token a kérésekhez. Ha még nincs (pl. net nélkül lépett be), most jelentkezik be a mentett e-maillel.
  Future<String> _getToken({bool uj = false}) async {
    final p = await SharedPreferences.getInstance();
    final email = p.getString('user_email');
    if (email == null) throw SzerverHiba(401, 'Nincs bejelentkezve.');
    if (!uj) {
      _token ??= p.getString('szerver_token');
      if (_token != null && p.getString('szerver_token_email') == email) return _token!;
    }
    await login(email);
    return _token!;
  }

  /// Kérés küldése tokennel; ha a token lejárt / érvénytelen, egyszer újra bejelentkezik.
  Future<http.Response> _kuld(Future<http.Response> Function(Map<String, String> fejlec) keres) async {
    var token = await _getToken();
    var res = await keres({'Authorization': 'Bearer $token'}).timeout(_timeout);
    if (res.statusCode == 401) {
      token = await _getToken(uj: true);
      res = await keres({'Authorization': 'Bearer $token'}).timeout(_timeout);
    }
    return res;
  }

  Map<String, dynamic> _ellenoriz(http.Response res) {
    final Map<String, dynamic> body =
        res.bodyBytes.isEmpty ? <String, dynamic>{} : jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    if (res.statusCode >= 400 && res.statusCode != 422) {
      throw SzerverHiba(res.statusCode, (body['error'] as String?) ?? 'Szerverhiba (${res.statusCode})');
    }
    return body;
  }

  // --- Beküldés várólistával -------------------------------------------------

  /// A várólista mappái (a hibásnak jelölteket kihagyva).
  Future<List<Directory>> _varakozoMappak() async {
    final mappak = (await _varolistaMappa()).listSync().whereType<Directory>();
    return mappak.where((d) => !d.path.endsWith('.hibas') && File('${d.path}/data.json').existsSync()).toList();
  }

  Future<Directory> _varolistaMappa() async {
    final docs = await getApplicationDocumentsDirectory();
    final dir = Directory('${docs.path}/varolista');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  /// Munkalap beküldése a szerverre. Előbb elmenti a telefonra (várólista), így akkor sem vész el,
  /// ha nincs net vagy közben bezárják az appot. Siker esetén törli a várólistából.
  Future<BekuldesEredmeny> bekuld({
    required String id,
    required Map<String, dynamic> adatok,
    required Uint8List pdf,
    Uint8List? alairasUgyfel,
    Uint8List? alairasSzerviz,
    bool emailKuldes = false,
  }) async {
    final dir = Directory('${(await _varolistaMappa()).path}/$id');
    await dir.create(recursive: true);
    await File('${dir.path}/munkalap.pdf').writeAsBytes(pdf, flush: true);
    if (alairasUgyfel != null) await File('${dir.path}/alairas_ugyfel.png').writeAsBytes(alairasUgyfel, flush: true);
    if (alairasSzerviz != null) await File('${dir.path}/alairas_szerviz.png').writeAsBytes(alairasSzerviz, flush: true);
    // A data.json kerül ki utoljára: ha ez megvan, a mappa teljes.
    await File('${dir.path}/data.json').writeAsString(jsonEncode({'data': adatok, 'kuldes': emailKuldes}), flush: true);

    final eredmeny = await _feltoltMappa(dir);
    // Ha most sikerült, a korábban beragadt munkalapokat is megpróbáljuk felküldeni.
    if (eredmeny.feltoltve) unawaited(varolistaKuldes());
    return eredmeny;
  }

  /// A telefonon várakozó (net nélkül készült) munkalapok felküldése. Indításkor érdemes meghívni.
  /// Visszaadja, hány munkalap ment fel sikeresen.
  Future<int> varolistaKuldes() async {
    if (_varolistaFut) return 0;
    _varolistaFut = true;
    var sikeres = 0;
    try {
      for (final dir in await _varakozoMappak()) {
        final r = await _feltoltMappa(dir);
        if (!r.feltoltve) break; // nincs net – a többit sem érdemes most próbálni
        sikeres++;
      }
    } finally {
      _varolistaFut = false;
    }
    return sikeres;
  }

  /// Hány munkalap vár feltöltésre a telefonon.
  Future<int> varolistaHossz() async => (await _varakozoMappak()).length;

  Future<BekuldesEredmeny> _feltoltMappa(Directory dir) async {
    final id = dir.uri.pathSegments.where((s) => s.isNotEmpty).last;
    try {
      final meta = jsonDecode(await File('${dir.path}/data.json').readAsString()) as Map<String, dynamic>;
      final res = await _kuld((fejlec) async {
        final req = http.MultipartRequest('PUT', Uri.parse('$kSzerverCim/api/worksheets/${Uri.encodeComponent(id)}'))
          ..headers.addAll(fejlec)
          ..fields['data'] = jsonEncode(meta['data'])
          ..fields['kuldes'] = meta['kuldes'] == true ? '1' : '0';
        for (final f in const [
          ['pdf', 'munkalap.pdf'],
          ['alairasUgyfel', 'alairas_ugyfel.png'],
          ['alairasSzerviz', 'alairas_szerviz.png'],
        ]) {
          final file = File('${dir.path}/${f[1]}');
          if (await file.exists()) req.files.add(await http.MultipartFile.fromPath(f[0], file.path, filename: f[1]));
        }
        return http.Response.fromStream(await req.send());
      });
      final body = _ellenoriz(res);
      await dir.delete(recursive: true);
      final email = body['email'] as Map<String, dynamic>?;
      return BekuldesEredmeny(
        feltoltve: true,
        emailStatus: email?['status'] as String?,
        emailHiba: email?['error'] as String?,
      );
    } on SzerverHiba catch (e) {
      if (e.statusz == 400) {
        // Hibás adat: újrapróbálással sem menne fel, ezért félretesszük, hogy ne akassza meg a többit.
        final cel = Directory('${dir.path}.hibas');
        if (await cel.exists()) await cel.delete(recursive: true);
        await dir.rename(cel.path);
      }
      return BekuldesEredmeny(feltoltve: false, hiba: e.uzenet);
    } catch (e) {
      // Nincs net, időtúllépés stb. – marad a várólistában.
      return BekuldesEredmeny(feltoltve: false, hiba: e.toString());
    }
  }

  // --- Keresés, megtekintés --------------------------------------------------

  /// Korábbi munkalapok keresése. [q]: szabad szöveg (szám, ügyfél, gép, helyszín...),
  /// [csakSajat]: csak a bejelentkezett felhasználó munkalapjai.
  Future<List<Map<String, dynamic>>> kereses({String? q, bool csakSajat = false, int limit = 100}) async {
    String? user;
    if (csakSajat) user = (await SharedPreferences.getInstance()).getString('user_email');
    final uri = Uri.parse('$kSzerverCim/api/worksheets').replace(queryParameters: {
      if (q != null && q.trim().isNotEmpty) 'q': q.trim(),
      if (user != null) 'user': user,
      'limit': '$limit',
    });
    final body = _ellenoriz(await _kuld((h) => http.get(uri, headers: h)));
    return (body['items'] as List).cast<Map<String, dynamic>>();
  }

  /// Fájl letöltése: 'pdf', 'alairasUgyfel' vagy 'alairasSzerviz'.
  Future<Uint8List> fajl(String id, String fajta) async {
    final uri = Uri.parse('$kSzerverCim/api/worksheets/${Uri.encodeComponent(id)}/files/$fajta');
    final res = await _kuld((h) => http.get(uri, headers: h));
    if (res.statusCode != 200) _ellenoriz(res);
    return res.bodyBytes;
  }

  /// A munkalap PDF-jének (újra)küldése e-mailben. Ha [cimzett] üres, az ügyfél címére megy.
  Future<BekuldesEredmeny> emailKuldes(String id, {String? cimzett}) async {
    final uri = Uri.parse('$kSzerverCim/api/worksheets/${Uri.encodeComponent(id)}/email');
    final body = _ellenoriz(await _kuld((h) => http.post(uri,
        headers: {...h, 'Content-Type': 'application/json'},
        body: jsonEncode({if (cimzett != null && cimzett.isNotEmpty) 'to': cimzett}))));
    return BekuldesEredmeny(feltoltve: true, emailStatus: body['status'] as String?, emailHiba: body['error'] as String?);
  }
}
