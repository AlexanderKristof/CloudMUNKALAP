// Flutter minta az app és a VPS szerver összekötéséhez.
// pubspec.yaml függőségek:  http, shared_preferences, uuid, device_info_plus (opcionális)
//
// Használat:
//   final api = MunkalapApi('https://munkalap.sajatdomain.hu', appKey: 'KULCS');
//   await api.login('Kovács Péter');
//   await api.mentes(munkalap);        // munkalap: Map<String, dynamic>, benne 'id'
//   final valtozasok = await api.szinkron();   // indításkor / frissítéskor

import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

class MunkalapApi {
  MunkalapApi(this.baseUrl, {this.appKey});

  final String baseUrl;
  final String? appKey;
  String? _token;

  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (_token != null) 'Authorization': 'Bearer $_token',
        if (appKey != null) 'X-App-Key': appKey!,
      };

  /// Az eszköz egyedi azonosítója (első indításkor generáljuk és eltároljuk).
  Future<String> _deviceId() async {
    final p = await _prefs;
    var id = p.getString('device_id');
    if (id == null) {
      id = const Uuid().v4();
      await p.setString('device_id', id);
    }
    return id;
  }

  /// Igaz, ha már be van jelentkezve (a token el van mentve).
  Future<bool> betolt() async {
    _token = (await _prefs).getString('token');
    return _token != null;
  }

  /// Bejelentkezés csak névvel.
  Future<void> login(String nev, {String? eszkozNev}) async {
    final res = await http.post(Uri.parse('$baseUrl/api/login'),
        headers: _headers,
        body: jsonEncode({'name': nev, 'deviceId': await _deviceId(), 'deviceName': eszkozNev ?? 'Telefon'}));
    final body = _check(res);
    _token = body['token'];
    await (await _prefs).setString('token', _token!);
  }

  Future<void> logout() async {
    await http.post(Uri.parse('$baseUrl/api/logout'), headers: _headers);
    _token = null;
    await (await _prefs).remove('token');
  }

  /// Új munkalaphoz generálj azonosítót így, és tedd bele a munkalap 'id' mezőjébe.
  static String ujAzonosito() => const Uuid().v4();

  /// Egy munkalap mentése a szerverre. Ha nincs net, tedd a várólistába (lásd: sorbaAllit).
  Future<Map<String, dynamic>> mentes(Map<String, dynamic> munkalap, {int? alapVerzio}) async {
    final id = munkalap['id'] as String;
    final res = await http.put(Uri.parse('$baseUrl/api/worksheets/${Uri.encodeComponent(id)}'),
        headers: _headers, body: jsonEncode({'data': munkalap, 'baseVersion': alapVerzio}));
    return _check(res);
  }

  Future<void> torles(String id) async {
    _check(await http.delete(Uri.parse('$baseUrl/api/worksheets/${Uri.encodeComponent(id)}'), headers: _headers));
  }

  /// Keresés a szerveren. Pl.: kereses(q: 'Szabó'), kereses(felhasznalo: 'Anna', tol: '2026-10-01')
  Future<List<dynamic>> kereses({String? q, String? felhasznalo, String? tol, String? ig, String? allapot}) async {
    final uri = Uri.parse('$baseUrl/api/worksheets').replace(queryParameters: {
      if (q != null) 'q': q,
      if (felhasznalo != null) 'user': felhasznalo,
      if (tol != null) 'from': tol,
      if (ig != null) 'to': ig,
      if (allapot != null) 'allapot': allapot,
    });
    return _check(await http.get(uri, headers: _headers))['items'];
  }

  /// Offline mentett munkalap felvétele a várólistába – a következő szinkron felküldi.
  Future<void> sorbaAllit(Map<String, dynamic> munkalap, {bool torolt = false}) async {
    final p = await _prefs;
    final sor = (jsonDecode(p.getString('varolista') ?? '{}') as Map<String, dynamic>);
    sor[munkalap['id']] = {'id': munkalap['id'], 'data': munkalap, 'deleted': torolt};
    await p.setString('varolista', jsonEncode(sor));
  }

  /// Felküldi a várólistát, és visszaadja a mások által (más eszközön) módosított munkalapokat.
  /// A visszakapott elemeket mentsd el a helyi tárolóba (id alapján felülírva; deleted=true esetén töröld).
  Future<List<Map<String, dynamic>>> szinkron() async {
    final p = await _prefs;
    final sor = (jsonDecode(p.getString('varolista') ?? '{}') as Map<String, dynamic>);
    var since = p.getInt('sync_cursor') ?? 0;
    final kapott = <Map<String, dynamic>>[];
    var elso = true;
    while (true) {
      final res = await http.post(Uri.parse('$baseUrl/api/sync'),
          headers: _headers, body: jsonEncode({'since': since, 'changes': elso ? sor.values.toList() : []}));
      final body = _check(res);
      if (elso) await p.remove('varolista');
      elso = false;
      kapott.addAll((body['items'] as List).cast<Map<String, dynamic>>());
      since = body['cursor'];
      await p.setInt('sync_cursor', since);
      if (body['hasMore'] != true) break;
    }
    return kapott;
  }

  Map<String, dynamic> _check(http.Response res) {
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(utf8.decode(res.bodyBytes));
    if (res.statusCode >= 400) throw Exception(body['error'] ?? 'Szerverhiba (${res.statusCode})');
    return body;
  }
}
