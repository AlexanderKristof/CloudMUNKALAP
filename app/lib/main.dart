// =============================================================================
// DR INDUSTRIE – MUNKALAP APP (fő fájl)
// =============================================================================
// Ebben a fájlban van:
//   1. main()              – az app indulása
//   2. MunkalapApp         – az app "kerete" (téma, melyik képernyővel indul)
//   3. LoginScreen         – bejelentkező képernyő (csak e-mail cím, jelszó nincs)
//   4. MunkalapFormScreen  – a munkalap kitöltő képernyő (űrlap, aláírások,
//                            hangfelismerés, PDF készítés, beküldés a szerverre)
//
// A szerverrel való kommunikáció a munkalap_api.dart fájlban van,
// a korábbi munkalapok listája és részletei a korabbi_munkalapok.dart-ban.
// =============================================================================

import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show rootBundle; // az assets mappa fájljainak betöltéséhez (sablon.png)
import 'package:pdf/pdf.dart'; // PDF lapméret (A4) stb.
import 'package:pdf/widgets.dart' as pw; // PDF tartalom építése ("pw." előtaggal, hogy ne keveredjen a Flutter widgetekkel)
import 'package:printing/printing.dart'; // nyomtatás / PDF megtekintő ablak + Google betűtípusok
import 'package:signature/signature.dart'; // aláíró mező
import 'package:speech_to_text/speech_to_text.dart' as stt; // hangfelismerés (mikrofon gomb)
import 'package:shared_preferences/shared_preferences.dart'; // kis adatok tartós mentése a telefonon (pl. e-mail cím)

import 'korabbi_munkalapok.dart';
import 'munkalap_api.dart';

/// Az app belépési pontja – a telefon ezt futtatja elsőként.
void main() async {
  // Kötelező, ha a runApp() előtt pluginokat (pl. SharedPreferences) használunk.
  WidgetsFlutterBinding.ensureInitialized();

  // Firebase inicializálás (ha be van állítva a projekt, vedd ki a kommentet):
  // await Firebase.initializeApp();

  // Megnézzük, be van-e már jelentkezve valaki (az e-mail címe el van-e mentve).
  SharedPreferences prefs = await SharedPreferences.getInstance();
  String? savedEmail = prefs.getString('user_email');

  runApp(MunkalapApp(initialEmail: savedEmail));
}

/// Az app kerete: téma (narancs szín) és a kezdőképernyő kiválasztása.
class MunkalapApp extends StatelessWidget {
  /// A korábban elmentett e-mail cím, vagy null, ha még senki nem lépett be.
  final String? initialEmail;
  const MunkalapApp({super.key, this.initialEmail});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DR Industrie - Munkalap',
      debugShowCheckedModeBanner: false, // a jobb felső "DEBUG" szalag elrejtése
      theme: ThemeData(primarySwatch: Colors.deepOrange, useMaterial3: true),
      // Ha nincs mentett e-mail -> bejelentkező képernyő, különben egyből az űrlap.
      home: initialEmail == null
          ? const LoginScreen()
          : MunkalapFormScreen(userEmail: initialEmail!),
    );
  }
}

// ---------------------------------------------------------------------------
// BEJELENTKEZŐ KÉPERNYŐ (Jelszó nélkül, E-mail alapon)
// ---------------------------------------------------------------------------
// Az e-mail cím csak azt azonosítja, ki tölti a munkalapot (a szerver így tudja,
// ki rögzítette). A szerver felé a védelmet az alkalmazáskulcs adja
// (szerver_beallitas.dart -> kAppKulcs), nem jelszó.
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  /// Az e-mail beviteli mező tartalma.
  final TextEditingController _emailController = TextEditingController();

  /// A BELÉPÉS gomb: e-mail ellenőrzése, mentése és bejelentkezés a szerverre.
  Future<void> _login() async {
    String email = _emailController.text.trim();
    if (email.isNotEmpty && email.contains('@')) {
      // Elmentjük a telefonon, hogy legközelebb ne kelljen újra beírni.
      SharedPreferences prefs = await SharedPreferences.getInstance();
      await prefs.setString('user_email', email);

      // Bejelentkezés a szerverre. Ha most nincs net, nem gond: a szerver felé
      // a beküldéskor automatikusan bejelentkezik.
      try {
        await MunkalapApi.instance.login(email);
      } on SzerverHiba catch (e) {
        // A szerver elérhető, de elutasította (pl. rossz alkalmazáskulcs) -> nem engedjük tovább.
        await prefs.remove('user_email');
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Sikertelen bejelentkezés: $e')));
        return;
      } catch (_) {} // nincs net / időtúllépés -> később próbálja újra, most továbbengedjük

      if (!mounted) return; // a képernyőt közben bezárhatták
      // Átlépés a munkalap képernyőre (a "vissza" gomb nem hozza vissza a belépést).
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

  /// A bejelentkező képernyő kinézete: ikon, e-mail mező, BELÉPÉS gomb.
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
              keyboardType: TextInputType.emailAddress, // e-mail billentyűzet (@ gombbal)
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
// Itt tölti ki a szerelő a munkalapot. A gomb megnyomásakor:
//   1. elkészül a PDF (a sablon.png háttérre ráírva a mezők + aláírások),
//   2. a munkalap felmegy a szerverre (net nélkül a telefonon várakozik),
//   3. megnyílik a nyomtatás / megtekintés ablak.
class MunkalapFormScreen extends StatefulWidget {
  /// A bejelentkezett felhasználó e-mail címe (a fejlécben is látszik).
  final String userEmail;
  const MunkalapFormScreen({super.key, required this.userEmail});

  @override
  State<MunkalapFormScreen> createState() => _MunkalapFormScreenState();
}

class _MunkalapFormScreenState extends State<MunkalapFormScreen> {
  /// Az űrlap kulcsa – ezzel lehet egyszerre ellenőrizni az összes mezőt (validate).
  final _formKey = GlobalKey<FormState>();

  // --- Az űrlap mezőinek tartalma (mindegyik mezőhöz egy "controller") ---
  final TextEditingController _driSzamController = TextEditingController(); // munkalap száma (a "DRI-" utáni rész)
  final TextEditingController _ugyfelController = TextEditingController(); // ügyfél neve
  final TextEditingController _ugyfelEmailController = TextEditingController(); // ügyfél e-mail címe (e-mail küldéshez)
  final TextEditingController _helyszinController = TextEditingController(); // munkavégzés helye
  final TextEditingController _gepController = TextEditingController(); // gép típusa
  final TextEditingController _idotartamController = TextEditingController(); // munkavégzés időtartama
  final TextEditingController _kmController = TextEditingController(); // megtett km
  final TextEditingController _elvegzettMunkaController = TextEditingController(); // elvégzett munka (többsoros)
  final TextEditingController _hibaLeirasController = TextEditingController(); // hiba leírása + javaslat (többsoros)
  // Hely és dátum – alapból a mai dátummal töltjük ki, pl. "Miskolc, 2026.10.8."
  final TextEditingController _datumController = TextEditingController(
    text: 'Miskolc, ${DateTime.now().year}.${DateTime.now().month}.${DateTime.now().day}.',
  );

  // --- A két aláíró mező ---
  // exportBackgroundColor: átlátszó, hogy a PDF-en ne legyen fehér téglalap az aláírás mögött.
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

  // --- Hangfelismerés (mikrofon gomb a mezők mellett) ---
  late stt.SpeechToText _speech;
  bool _isListening = false; // éppen hallgat-e a mikrofon
  TextEditingController? _activeListeningController; // melyik mezőbe ír éppen a hangfelismerés

  // A munkalap egyedi azonosítója a szerveren. Ugyanazzal az azonosítóval újra beküldve
  // a munkalap frissül (nem lesz duplikált), az "Új munkalap" gomb ad újat.
  String _munkalapId = MunkalapApi.ujAzonosito();
  // Igaz, amíg a beküldés tart – ilyenkor a gomb le van tiltva, hogy ne lehessen kétszer megnyomni.
  bool _kuldesFolyamatban = false;
  // Alapból nem megy ki e-mail, csak ha bepipálják (vagy később a Korábbi munkalapok képernyőről).
  bool _emailKuldes = false;

  /// A képernyő megnyitásakor fut le egyszer.
  @override
  void initState() {
    super.initState();
    _speech = stt.SpeechToText();
    // Ha korábban net nélkül készült munkalap, most megpróbáljuk felküldeni.
    MunkalapApi.instance.varolistaKuldes();
  }

  /// Az űrlap tartalma egy "térképben" (kulcs -> érték). Ez megy fel a szerverre.
  /// A kulcsneveket (driSzam, ugyfel...) a szerver is ismeri, ezek alapján keres.
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

  // Űrlap ürítése egy új munkalaphoz ("Új munkalap" gomb).
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
    setState(() {
      _munkalapId = MunkalapApi.ujAzonosito(); // új azonosító -> a szerveren új munkalap lesz
      _emailKuldes = false;
    });
  }

  // PDF generálás, mentés a szerverre (ha be van pipálva, a szerver e-mailben is elküldi az ügyfélnek),
  // majd a nyomtatási / megtekintési ablak.
  Future<void> _bekuldes() async {
    if (_kuldesFolyamatban || !_formKey.currentState!.validate()) return;
    setState(() => _kuldesFolyamatban = true);
    try {
      // 1. Aláírások PNG képként (null, ha üresen hagyták).
      final Uint8List? ugyfelBytes = await _ugyfelSigController.toPngBytes();
      final Uint8List? szervizBytes = await _szervizSigController.toPngBytes();
      // 2. PDF elkészítése.
      final pdfBytes = await _generatePdf(ugyfelBytes, szervizBytes);

      // 3. Beküldés a szerverre. Ha nincs net, a munkalap a telefonon marad
      //    (várólista), és később automatikusan felmegy.
      final eredmeny = await MunkalapApi.instance.bekuld(
        id: _munkalapId,
        adatok: _adatok(),
        pdf: pdfBytes,
        alairasUgyfel: ugyfelBytes,
        alairasSzerviz: szervizBytes,
        emailKuldes: _emailKuldes,
      );
      if (!mounted) return;
      // Üzenet alul: "Munkalap mentve." / "Nincs kapcsolat..." stb.
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(eredmeny.uzenet), duration: const Duration(seconds: 5)),
      );

      // 4. Nyomtatás / megtekintés / megosztás ablak.
      await Printing.layoutPdf(onLayout: (format) async => pdfBytes);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Hiba: $e')));
    } finally {
      if (mounted) setState(() => _kuldesFolyamatban = false); // gomb újra használható
    }
  }

  // Kijelentkezés: töröljük a mentett e-mailt és a szerveres belépést, vissza a belépő képernyőre.
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

  /// Minden szó első betűje nagy (az ügyfél nevéhez a hangfelismerésnél): "kovács kft" -> "Kovács Kft".
  String _capitalizeWords(String text) {
    if (text.isEmpty) return text;
    return text.split(' ').map((word) {
      if (word.isEmpty) return word;
      return word[0].toUpperCase() + word.substring(1);
    }).join(' ');
  }

  /// Csak az első betű nagy (a többi mezőhöz a hangfelismerésnél).
  String _capitalizeFirstLetter(String text) {
    if (text.isEmpty) return text;
    return text[0].toUpperCase() + text.substring(1);
  }

  /// Mikrofon gomb: ha az adott mező már hallgat -> leállítja, különben elindítja
  /// a magyar nyelvű hangfelismerést, és a felismert szöveget a mezőbe írja.
  void _toggleListening(TextEditingController controller) async {
    if (_isListening && _activeListeningController == controller) {
      await _speech.stop();
      setState(() {
        _isListening = false;
        _activeListeningController = null;
      });
    } else {
      bool available = await _speech.initialize(); // engedélyt is kér a mikrofonhoz, ha még nincs
      if (available) {
        setState(() {
          _isListening = true;
          _activeListeningController = controller;
        });
        _speech.listen(
          listenOptions: stt.SpeechListenOptions(
            localeId: 'hu_HU', // magyar nyelv
          ),
          // Minden felismert szövegrészletnél frissítjük a mezőt.
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

  // ---------------------------------------------------------------------------
  // PDF KÉSZÍTÉS
  // ---------------------------------------------------------------------------
  // A PDF egy A4-es lap, aminek a háttere a sablon.png (a nyomtatvány képe),
  // erre írjuk rá a mezők szövegét és az aláírásokat pontos helyekre.
  //
  // KOORDINÁTÁK: az A4-es lap 595 egység széles és 842 egység magas.
  //   left = távolság a lap bal szélétől, top = távolság a lap tetejétől.
  //   Ha valami elcsúszik a sablonhoz képest, itt kell a left / top számokat
  //   módosítani (nagyobb top = lejjebb, nagyobb left = jobbra).
  Future<Uint8List> _generatePdf(Uint8List? ugyfelBytes, Uint8List? szervizBytes) async {
    final pdf = pw.Document();

    // Betűtípusok (ékezetes betűk miatt kell). FIGYELEM: ezeket az internetről tölti le,
    // ezért net nélkül a PDF készítés nem működik.
    final ttfBase = await PdfGoogleFonts.robotoRegular();
    final ttfBold = await PdfGoogleFonts.robotoBold();

    // A nyomtatvány háttérképe az assets mappából.
    final ByteData bgData = await rootBundle.load('assets/sablon.png');
    final Uint8List bgBytes = bgData.buffer.asUint8List();
    final pw.ImageProvider bgImage = pw.MemoryImage(bgBytes);

    // Aláírás képek (ha üres az aláírás, nem rajzolunk semmit).
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
        margin: pw.EdgeInsets.zero, // nincs margó, hogy a koordináták a lap széléhez képest értendők
        build: (pw.Context context) {
          // Stack = egymásra rétegzett elemek: legalul a háttérkép, rajta a szövegek.
          return pw.Stack(
            children: [
              // Háttér: a nyomtatvány képe a teljes lapon.
              pw.Positioned.fill(
                child: pw.Image(bgImage, fit: pw.BoxFit.cover),
              ),
              // Munkalap száma – jobb felül, a "DRI-" felirat után.
              pw.Positioned(
                // A sablonon a "DRI-" felirat után (A4 = 595 x 842 pont)
                left: 474,
                top: 52,
                child: pw.Text(_driSzamController.text, style: pw.TextStyle(font: ttfBold, fontSize: 11, fontWeight: pw.FontWeight.bold)),
              ),
              // Ügyfél / Customer
              pw.Positioned(
                left: 140,
                top: 136,
                child: pw.Text(_ugyfelController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Munkavégzés helye
              pw.Positioned(
                left: 225,
                top: 172,
                child: pw.Text(_helyszinController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Gép típusa
              pw.Positioned(
                left: 180,
                top: 209,
                child: pw.Text(_gepController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Munkavégzés időtartama
              pw.Positioned(
                left: 245,
                top: 243,
                child: pw.Text(_idotartamController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Megtett km
              pw.Positioned(
                left: 190,
                top: 279,
                child: pw.Text(_kmController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Elvégzett munka – a felső nagy keretbe (500 x 95-ös területen tördelve)
              pw.Positioned(
                left: 45,
                top: 360,
                child: pw.Container(
                  width: 500,
                  height: 95,
                  child: pw.Text(_elvegzettMunkaController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
                ),
              ),
              // Hiba leírása + javaslat – az alsó nagy keretbe
              pw.Positioned(
                left: 45,
                top: 500,
                child: pw.Container(
                  width: 500,
                  height: 95,
                  child: pw.Text(_hibaLeirasController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
                ),
              ),
              // Hely, dátum
              pw.Positioned(
                left: 135,
                top: 610,
                child: pw.Text(_datumController.text, style: pw.TextStyle(font: ttfBase, fontSize: 10)),
              ),
              // Ügyfél aláírása – bal oldali aláírásvonal fölé
              if (ugyfelImg != null)
                pw.Positioned(
                  left: 35,
                  top: 626,
                  // Középre és az aláírásvonalra igazítva, arányosan kicsinyítve
                  child: pw.Container(
                    width: 180,
                    height: 60,
                    alignment: pw.Alignment.bottomCenter,
                    child: pw.Image(ugyfelImg, fit: pw.BoxFit.contain),
                  ),
                ),
              // Szerviz aláírása – jobb oldali aláírásvonal fölé
              if (szervizImg != null)
                pw.Positioned(
                  left: 372,
                  top: 626,
                  // Középre és az aláírásvonalra igazítva, arányosan kicsinyítve
                  child: pw.Container(
                    width: 180,
                    height: 60,
                    alignment: pw.Alignment.bottomCenter,
                    child: pw.Image(szervizImg, fit: pw.BoxFit.contain),
                  ),
                ),
            ],
          );
        },
      ),
    );

    return pdf.save(); // a kész PDF bájtjai
  }

  /// A képernyő bezárásakor felszabadítjuk a mezőket (memória).
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

  /// Egy beviteli mező mikrofon gombbal a jobb szélén.
  ///   maxLines > 1 esetén többsoros mező (pl. elvégzett munka).
  ///   textCapitalization: automatikus nagybetű (mondat eleje / minden szó).
  Widget _buildTextFieldWithMic({
    required TextEditingController controller,
    required String labelText,
    int maxLines = 1,
    TextCapitalization textCapitalization = TextCapitalization.sentences,
    TextInputType keyboardType = TextInputType.text,
  }) {
    // Ez a mező hallgat-e most? (akkor piros a mikrofon ikon)
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

  /// A munkalap képernyő kinézete.
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      // --- Felső narancs sáv: cím + gombok ---
      appBar: AppBar(
        title: Text('DR Munkalap (${widget.userEmail})'),
        backgroundColor: Colors.deepOrange,
        foregroundColor: Colors.white,
        actions: [
          // Óra ikon: korábbi munkalapok listája (keresés, PDF, törlés)
          IconButton(
            icon: const Icon(Icons.history),
            tooltip: 'Korábbi munkalapok',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (context) => const KorabbiMunkalapokScreen()),
            ),
          ),
          // Új munkalap: rákérdez, majd kiüríti az űrlapot
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
          // Kijelentkezés
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Kijelentkezés',
            onPressed: _logout,
          ),
        ],
      ),
      // --- Az űrlap (görgethető) ---
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16.0),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Munkalap száma: "DRI-" felirat + mező
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
                // Ügyfél e-mail címe – ide küldi a szerver a PDF-et, ha be van pipálva az e-mail küldés
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
                // Időtartam és km egymás mellett
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

                // --- Aláíró mezők ---
                // Magasság 180: a mezőből kilógó vonalakat az aláíró csomag eldobja,
                // ezért kell elég nagy mező, hogy az aláírás ne legyen levágva.
                const Text('Ügyfél aláírása:', style: TextStyle(fontWeight: FontWeight.bold)),
                Container(decoration: BoxDecoration(border: Border.all(color: Colors.grey)), child: Signature(controller: _ugyfelSigController, height: 180, backgroundColor: Colors.grey[100]!)),
                TextButton(onPressed: () => _ugyfelSigController.clear(), child: const Text('Aláírás törlése')),

                const SizedBox(height: 10),
                const Text('Szerviz aláírása:', style: TextStyle(fontWeight: FontWeight.bold)),
                Container(decoration: BoxDecoration(border: Border.all(color: Colors.grey)), child: Signature(controller: _szervizSigController, height: 180, backgroundColor: Colors.grey[100]!)),
                TextButton(onPressed: () => _szervizSigController.clear(), child: const Text('Aláírás törlése')),

                // E-mail küldés pipa – alapból kikapcsolva
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: const Text('PDF elküldése e-mailben az ügyfélnek'),
                  value: _emailKuldes,
                  onChanged: (v) => setState(() => _emailKuldes = v ?? false),
                ),

                const SizedBox(height: 20),
                // --- Fő gomb: PDF + mentés (+ e-mail, ha be van pipálva) ---
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(backgroundColor: Colors.deepOrange, foregroundColor: Colors.white),
                    onPressed: _kuldesFolyamatban ? null : _bekuldes, // null = letiltva, amíg küld
                    icon: _kuldesFolyamatban
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.picture_as_pdf),
                    label: Text(_emailKuldes ? 'PDF GENERÁLÁS, MENTÉS ÉS KÜLDÉS' : 'PDF GENERÁLÁS ÉS MENTÉS', style: const TextStyle(fontSize: 16)),
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
