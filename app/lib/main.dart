import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';
import 'package:signature/signature.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:shared_preferences/shared_preferences.dart';

import 'korabbi_munkalapok.dart';
import 'munkalap_api.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // Firebase inicializálás (ha be van állítva a projekt, vedd ki a kommentet):
  // await Firebase.initializeApp();

  SharedPreferences prefs = await SharedPreferences.getInstance();
  String? savedEmail = prefs.getString('user_email');

  runApp(MunkalapApp(initialEmail: savedEmail));
}

class MunkalapApp extends StatelessWidget {
  final String? initialEmail;
  const MunkalapApp({super.key, this.initialEmail});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DR Industrie - Munkalap',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(primarySwatch: Colors.deepOrange, useMaterial3: true),
      home: initialEmail == null
          ? const LoginScreen()
          : MunkalapFormScreen(userEmail: initialEmail!),
    );
  }
}

// ---------------------------------------------------------------------------
// BEJELENTKEZŐ KÉPERNYŐ (Jelszó nélkül, E-mail alapon)
// ---------------------------------------------------------------------------
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final TextEditingController _emailController = TextEditingController();

  Future<void> _login() async {
    String email = _emailController.text.trim();
    if (email.isNotEmpty && email.contains('@')) {
      SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString('user_email', email);

      // Bejelentkezés a szerverre. Ha most nincs net, nem gond: a szerver felé
      // a beküldéskor automatikusan bejelentkezik.
      try {
        await MunkalapApi.instance.login(email);
      } on SzerverHiba catch (e) {
        await prefs.remove('user_email');
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Sikertelen bejelentkezés: $e')));
        return;
      } catch (_) {}

      if (!mounted) return;
      Navigator.pushReplacement(
        context,
        MaterialPageRoute(
          builder: (context) => MunkalapFormScreen(userEmail: email),
        ),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Kérjük, adjon meg egy érvényes e-mail címet!')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('DR Industrie - Bejelentkezés'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
      ),
      body: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.assignment_ind, size: 80, color: Colors.deepOrange),
            const SizedBox(height: 20),
            TextField(
              controller: _emailController,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'E-mail cím',
                prefixIcon: Icon(Icons.email),
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.deepOrange,
                  foregroundColor: Colors.white,
                ),
                onPressed: _login,
                child: const Text('BELÉPÉS', style: TextStyle(fontSize: 16)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// MUNKALAP KITÖLTŐ KÉPERNYŐ
// ---------------------------------------------------------------------------
class MunkalapFormScreen extends StatefulWidget {
  final String userEmail;
  const MunkalapFormScreen({super.key, required this.userEmail});

  @override
  State<MunkalapFormScreen> createState() => _MunkalapFormScreenState();
}

class _MunkalapFormScreenState extends State<MunkalapFormScreen> {
  final _formKey = GlobalKey<FormState>();

  final TextEditingController _driSzamController = TextEditingController();
  final TextEditingController _ugyfelController = TextEditingController();
  final TextEditingController _ugyfelEmailController = TextEditingController(); // ÚJ: Ügyfél e-mail
  final TextEditingController _helyszinController = TextEditingController();
  final TextEditingController _gepController = TextEditingController();
  final TextEditingController _idotartamController = TextEditingController();
  final TextEditingController _kmController = TextEditingController();
  final TextEditingController _elvegzettMunkaController = TextEditingController();
  final TextEditingController _hibaLeirasController = TextEditingController();
  final TextEditingController _datumController = TextEditingController(
    text: 'Miskolc, ${DateTime.now().year}.${DateTime.now().month}.${DateTime.now().day}.',
  );

  final SignatureController _ugyfelSigController = SignatureController(
    penStrokeWidth: 3,
    penColor: Colors.black,
    exportBackgroundColor: Colors.transparent,
  );
  final SignatureController _szervizSigController = SignatureController(
    penStrokeWidth: 3,
    penColor: Colors.black,
    exportBackgroundColor: Colors.transparent,
  );

  late stt.SpeechToText _speech;
  bool _isListening = false;
  TextEditingController? _activeListeningController;

  // A munkalap egyedi azonosítója a szerveren. Ugyanazzal az azonosítóval újra beküldve
  // a munkalap frissül (nem lesz duplikált), az "Új munkalap" gomb ad újat.
  String _munkalapId = MunkalapApi.ujAzonosito();
  bool _kuldesFolyamatban = false;

  @override
  void initState() {
    super.initState();
    _speech = stt.SpeechToText();
    // Ha korábban net nélkül készült munkalap, most megpróbáljuk felküldeni.
    MunkalapApi.instance.varolistaKuldes();
  }

  Map<String, dynamic> _adatok() => {
        'driSzam': _driSzamController.text.trim(),
        'ugyfel': _ugyfelController.text.trim(),
        'ugyfelEmail': _ugyfelEmailController.text.trim(),
        'helyszin': _helyszinController.text.trim(),
        'gep': _gepController.text.trim(),
        'idotartam': _idotartamController.text.trim(),
        'km': _kmController.text.trim(),
        'elvegzettMunka': _elvegzettMunkaController.text.trim(),
        'hibaLeiras': _hibaLeirasController.text.trim(),
        'datum': _datumController.text.trim(),
      };

  // Űrlap ürítése egy új munkalaphoz.
  void _ujMunkalap() {
    for (final c in [
      _driSzamController,
      _ugyfelController,
      _ugyfelEmailController,
      _helyszinController,
      _gepController,
      _idotartamController,
      _kmController,
      _elvegzettMunkaController,
      _hibaLeirasController,
    ]) {
      c.clear();
    }
    _datumController.text = 'Miskolc, ${DateTime.now().year}.${DateTime.now().month}.${DateTime.now().day}.';
    _ugyfelSigController.clear();
    _szervizSigController.clear();
    setState(() => _munkalapId = MunkalapApi.ujAzonosito());
  }

  // PDF generálás, beküldés a szerverre (ami elmenti és elküldi e-mailben az ügyfélnek),
  // majd a nyomtatási / megtekintési ablak.
  Future<void> _bekuldes() async {
    if (_kuldesFolyamatban || !_formKey.currentState!.validate()) return;
    setState(() => _kuldesFolyamatban = true);
    try {
      final Uint8List? ugyfelBytes = await _ugyfelSigController.toPngBytes();
      final Uint8List? szervizBytes = await _szervizSigController.toPngBytes();
      final pdfBytes = await _generatePdf(ugyfelBytes, szervizBytes);

      final eredmeny = await MunkalapApi.instance.bekuld(
        id: _munkalapId,
        adatok: _adatok(),
        pdf: pdfBytes,
        alairasUgyfel: ugyfelBytes,
        alairasSzerviz: szervizBytes,
      );
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(eredmeny.uzenet), duration: const Duration(seconds: 5)),
      );

      await Printing.layoutPdf(onLayout: (format) async => pdfBytes);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Hiba: $e')));
    } finally {
      if (mounted) setState(() => _kuldesFolyamatban = false);
    }
  }

  // Kijelentkezés
  Future<void> _logout() async {
    SharedPreferences prefs = await SharedPreferences.getInstance();
    await prefs.remove('user_email');
    await MunkalapApi.instance.logout();

    if (!mounted) return;
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (context) => const LoginScreen()),
    );
  }

  String _capitalizeWords(String text) {
    if (text.isEmpty) return text;
    return text.split(' ').map((word) {
      if (word.isEmpty) return word;
      return word[0].toUpperCase() + word.substring(1);
    }).join(' ');
  }

  String _capitalizeFirstLetter(String text) {
    if (text.isEmpty) return text;
    return text[0].toUpperCase() + text.substring(1);
  }

  void _toggleListening(TextEditingController controller) async {
    if (_isListening && _activeListeningController == controller) {
      await _speech.stop();
      setState(() {
        _isListening = false;
        _activeListeningController = null;
      });
    } else {
      bool available = await _speech.initialize();
      if (available) {
        setState(() {
          _isListening = true;
          _activeListeningController = controller;
        });
        _speech.listen(
          listenOptions: stt.SpeechListenOptions(
            localeId: 'hu_HU',
          ),
          onResult: (val) {
            setState(() {
              if (controller == _ugyfelController) {
                controller.text = _capitalizeWords(val.recognizedWords);
              } else {
                controller.text = _capitalizeFirstLetter(val.recognizedWords);
              }
            });
          },
        );
      } else {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('A beszédfelismerő nem érhető el ezen a készüléken.')),
        );
      }
    }
  }

  Future<Uint8List> _generatePdf(Uint8List? ugyfelBytes, Uint8List? szervizBytes) async {
    final pdf = pw.Document();

    final ttfBase = await PdfGoogleFonts.robotoRegular();
    final ttfBold = await PdfGoogleFonts.robotoBold();

    final ByteData bgData = await rootBundle.load('assets/sablon.png');
    final Uint8List bgBytes = bgData.buffer.asUint8List();
    final pw.ImageProvider bgImage = pw.MemoryImage(bgBytes);

    final pw.ImageProvider? ugyfelImg = ugyfelBytes != null ? pw.MemoryImage(ugyfelBytes) : null;
    final pw.ImageProvider? szervizImg = szervizBytes != null ? pw.MemoryImage(szervizBytes) : null;

    pdf.addPage(
      pw.Page(
        theme: pw.ThemeData(
          defaultTextStyle: pw.TextStyle(font: ttfBase),
        ).copyWith(
          paragraphStyle: pw.TextStyle(font: ttfBase),
        ),
        pageFormat: PdfPageFormat.a4,
        margin: pw.EdgeInsets.zero,
        build: (pw.Context context) {
          return pw.Stack(
            children: [
              pw.Positioned.fill(
                child: pw.Image(bgImage, fit: pw.BoxFit.cover),
              ),
              pw.Positioned(
                left: 710,
                top: 55,
                child: pw.Text(_driSzamController.text, style: pw.TextStyle(font: ttfBold, fontSize: 11, fontWeight: pw.FontWeight.bold)),
              ),
              pw.Positioned(
                left: 140,
                top: 136,
                child: pw.Text(_ugyfelController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              pw.Positioned(
                left: 225,
                top: 172,
                child: pw.Text(_helyszinController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              pw.Positioned(
                left: 180,
                top: 209,
                child: pw.Text(_gepController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              pw.Positioned(
                left: 245,
                top: 243,
                child: pw.Text(_idotartamController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              pw.Positioned(
                left: 190,
                top: 279,
                child: pw.Text(_kmController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              pw.Positioned(
                left: 45,
                top: 360,
                child: pw.Container(
                  width: 500,
                  height: 95,
                  child: pw.Text(_elvegzettMunkaController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
                ),
              ),
              pw.Positioned(
                left: 45,
                top: 500,
                child: pw.Container(
                  width: 500,
                  height: 95,
                  child: pw.Text(_hibaLeirasController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
                ),
              ),
              pw.Positioned(
                left: 135,
                top: 610,
                child: pw.Text(_datumController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              if (ugyfelImg != null)
                pw.Positioned(
                  left: 45,
                  top: 645,
                  child: pw.Image(ugyfelImg, width: 160, height: 40),
                ),
              if (szervizImg != null)
                pw.Positioned(
                  left: 385,
                  top: 645,
                  child: pw.Image(szervizImg, width: 160, height: 40),
                ),
            ],
          );
        },
      ),
    );

    return pdf.save();
  }

  @override
  void dispose() {
    _driSzamController.dispose();
    _ugyfelController.dispose();
    _ugyfelEmailController.dispose();
    _helyszinController.dispose();
    _gepController.dispose();
    _idotartamController.dispose();
    _kmController.dispose();
    _elvegzettMunkaController.dispose();
    _hibaLeirasController.dispose();
    _datumController.dispose();
    _ugyfelSigController.dispose();
    _szervizSigController.dispose();
    super.dispose();
  }

  Widget _buildTextFieldWithMic({
    required TextEditingController controller,
    required String labelText,
    int maxLines = 1,
    TextCapitalization textCapitalization = TextCapitalization.sentences,
    TextInputType keyboardType = TextInputType.text,
  }) {
    bool isThisListening = _isListening && _activeListeningController == controller;
    return TextFormField(
      controller: controller,
      maxLines: maxLines,
      textCapitalization: textCapitalization,
      keyboardType: maxLines > 1 ? TextInputType.multiline : keyboardType,
      decoration: InputDecoration(
        labelText: labelText,
        border: const OutlineInputBorder(),
        alignLabelWithHint: maxLines > 1,
        suffixIcon: IconButton(
          icon: Icon(
            isThisListening ? Icons.mic : Icons.mic_none,
            color: isThisListening ? Colors.red : Colors.deepOrange,
          ),
          onPressed: () => _toggleListening(controller),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('DR Munkalap (${widget.userEmail})'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
        actions: [
          IconButton(
            icon: const Icon(Icons.history),
            tooltip: 'Korábbi munkalapok',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (context) => const KorabbiMunkalapokScreen()),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.note_add),
            tooltip: 'Új munkalap',
            onPressed: () async {
              final ok = await showDialog<bool>(
                context: context,
                builder: (context) => AlertDialog(
                  title: const Text('Új munkalap'),
                  content: const Text('Az űrlap kiürül. A már beküldött munkalap a szerveren megmarad.'),
                  actions: [
                    TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Mégse')),
                    ElevatedButton(onPressed: () => Navigator.pop(context, true), child: const Text('Új munkalap')),
                  ],
                ),
              );
              if (ok == true) _ujMunkalap();
            },
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Kijelentkezés',
            onPressed: _logout,
          ),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16.0),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text('DRI-', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                    const SizedBox(width: 8),
                    Expanded(child: _buildTextFieldWithMic(controller: _driSzamController, labelText: 'Munkalap száma')),
                  ],
                ),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(
                  controller: _ugyfelController, 
                  labelText: 'Ügyfél / Customer',
                  textCapitalization: TextCapitalization.words,
                ),
                const SizedBox(height: 12),
                // ÚJ: Ügyfél e-mail címe az automatikus elküldéshez
                _buildTextFieldWithMic(
                  controller: _ugyfelEmailController, 
                  labelText: 'Ügyfél E-mail címe',
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(controller: _helyszinController, labelText: 'Munkavégzés helye'),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(controller: _gepController, labelText: 'Gép típusa'),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(child: _buildTextFieldWithMic(controller: _idotartamController, labelText: 'Munkavégzés időtartama')),
                    const SizedBox(width: 8),
                    Expanded(child: _buildTextFieldWithMic(controller: _kmController, labelText: 'Megtett km')),
                  ],
                ),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(
                  controller: _elvegzettMunkaController,
                  labelText: 'Elvégzett munka / Work Performed',
                  maxLines: 6,
                ),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(
                  controller: _hibaLeirasController,
                  labelText: 'Hiba leírása + javaslat',
                  maxLines: 6,
                ),
                const SizedBox(height: 12),
                _buildTextFieldWithMic(controller: _datumController, labelText: 'Hely, dátum / Date'),
                const SizedBox(height: 16),

                const Text('Ügyfél aláírása:', style: TextStyle(fontWeight: FontWeight.bold)),
                Container(decoration: BoxDecoration(border: Border.all(color: Colors.grey)), child: Signature(controller: _ugyfelSigController, height: 110, backgroundColor: Colors.grey[100]!)),
                TextButton(onPressed: () => _ugyfelSigController.clear(), child: const Text('Aláírás törlése')),

                const SizedBox(height: 10),
                const Text('Szerviz aláírása:', style: TextStyle(fontWeight: FontWeight.bold)),
                Container(decoration: BoxDecoration(border: Border.all(color: Colors.grey)), child: Signature(controller: _szervizSigController, height: 110, backgroundColor: Colors.grey[100]!)),
                TextButton(onPressed: () => _szervizSigController.clear(), child: const Text('Aláírás törlése')),

                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.deepOrange, foregroundColor: Colors.white),
                    onPressed: _kuldesFolyamatban ? null : _bekuldes,
                    icon: _kuldesFolyamatban
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.picture_as_pdf),
                    label: const Text('PDF GENERÁLÁS ÉS KÜLDÉS', style: TextStyle(fontSize: 16)),
                  ),
                ),
                const SizedBox(height: 30),
              ],
            ),
          ),
        ),
      ),
    );
  }
}