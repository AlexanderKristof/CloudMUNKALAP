import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:printing/printing.dart';

import 'munkalap_api.dart';

// ---------------------------------------------------------------------------
// KORÁBBI MUNKALAPOK – keresés a szerveren
// ---------------------------------------------------------------------------
class KorabbiMunkalapokScreen extends StatefulWidget {
  const KorabbiMunkalapokScreen({super.key});

  @override
  State<KorabbiMunkalapokScreen> createState() => _KorabbiMunkalapokScreenState();
}

class _KorabbiMunkalapokScreenState extends State<KorabbiMunkalapokScreen> {
  final TextEditingController _keresoController = TextEditingController();
  Timer? _kesleltetes;
  List<Map<String, dynamic>> _lista = [];
  bool _tolt = true;
  bool _csakSajat = false;
  String? _hiba;
  int _varolista = 0;

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

  void _keresesValtozott(String _) {
    _kesleltetes?.cancel();
    _kesleltetes = Timer(const Duration(milliseconds: 400), _frissit);
  }

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
          if (_varolista > 0)
            Container(
              width: double.infinity,
              color: Colors.amber.shade100,
              padding: const EdgeInsets.all(8),
              child: Text('$_varolista munkalap még a telefonon vár feltöltésre (nincs net).'),
            ),
          if (_hiba != null)
            Padding(padding: const EdgeInsets.all(12), child: Text(_hiba!, style: const TextStyle(color: Colors.red))),
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
                        return ListTile(
                          title: Text('DRI-${w['munkalapszam'] ?? ''}  ${w['ugyfel'] ?? ''}'),
                          subtitle: Text([
                            if ((w['gep'] ?? '').toString().isNotEmpty) w['gep'],
                            if ((w['helyszin'] ?? '').toString().isNotEmpty) w['helyszin'],
                            '${_datum(w['createdAt'] as String?)} · ${rogzitette['email']}',
                          ].join('\n')),
                          isThreeLine: true,
                          trailing: Icon(
                            email['status'] == 'kuldve' ? Icons.mark_email_read : Icons.mail_outline,
                            color: email['status'] == 'kuldve'
                                ? Colors.green
                                : (email['status'] == 'hiba' ? Colors.red : Colors.grey),
                          ),
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
class MunkalapReszletekScreen extends StatefulWidget {
  final Map<String, dynamic> munkalap;
  const MunkalapReszletekScreen({super.key, required this.munkalap});

  @override
  State<MunkalapReszletekScreen> createState() => _MunkalapReszletekScreenState();
}

class _MunkalapReszletekScreenState extends State<MunkalapReszletekScreen> {
  bool _dolgozik = false;
  final Map<String, Future<Uint8List>> _alairasok = {};

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

  Map<String, dynamic> get _w => widget.munkalap;

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

  void _uzenet(String szoveg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(szoveg)));
  }

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

  @override
  Widget build(BuildContext context) {
    final data = _w['data'] as Map<String, dynamic>;
    final files = _w['files'] as Map<String, dynamic>;
    final email = _w['email'] as Map<String, dynamic>;
    final rogzitette = _w['createdBy'] as Map<String, dynamic>;
    return Scaffold(
      appBar: AppBar(
        title: Text('DRI-${_w['munkalapszam'] ?? ''}'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
        actions: [
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
        ],
      ),
    );
  }
}
