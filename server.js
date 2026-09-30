require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const sgMail = require('@sendgrid/mail');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const app = express();

// 1. CORS va per primo
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));


// Rotta diretta per robots.txt
app.get('/robots.txt', (req, res) => {
    res.type('text/plain');
    res.send("User-agent: *\nAllow: /");
});

app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://safetydata-backend.onrender.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`);
});

// ... (tutti i tuoi require precedenti restano invariati)

// 2. WEBHOOK - GESTIONE CORRETTA DEL CORPO RAW
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Verifica la firma di Stripe sul buffer grezzo (req.body)
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`❌ Errore firma webhook: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Controllo idempotenza: evita di processare due volte lo stesso evento
    const already = await ProcessedEvent.findOne({ eventId: event.id });
    if (already) {
        console.log(`⚠️ Evento già processato, ignorato: ${event.id}`);
        return res.json({ received: true });
    }
    await ProcessedEvent.create({ eventId: event.id });

  // Gestione dell'evento
if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

   // VALIDAZIONE: Controlla che metadata e userId esistano
if (session.metadata && session.metadata.tipo_acquisto === 'pacchetto_app' && session.metadata.userId) {
    const pacchetti = { '5 ANALISI': 5, '12 ANALISI': 12, '25 ANALISI': 25 };
    // Aggiungiamo .toUpperCase() per assicurarci che corrisponda sempre
    const crediti = pacchetti[session.metadata.pacchetto.toUpperCase()] || 0;

        try {
            // Aggiornamento atomico dei crediti
            const user = await User.findByIdAndUpdate(
                session.metadata.userId, 
                { $inc: { credits: crediti } },
                { new: true } 
            );

            if (!user) {
                console.error(`⚠️ Utente non trovato nel DB: ${session.metadata.userId}`);
            // ... codice precedente ...
                } else {
                    console.log(`✅ Crediti aggiornati per ${user._id}: +${crediti}`);
                    
                    try {
                        await sgMail.send({
                            to: session.customer_details.email,
                            from: 'luxusaureastudio@gmail.com',
                            subject: 'Conferma acquisto crediti',
                            text: `Crediti accreditati: ${crediti}`
                        });
                        console.log("📧 Email inviata!");
                    } catch (mailErr) {
                        console.error("❌ Errore email:", mailErr.message);
                    }
                } // Chiude l'else
            } catch (dbErr) {
                console.error(`❌ Errore database: ${dbErr.message}`);
                return res.status(500).send('Database Error');
            }
        } // Chiude l'if session.metadata
    } // Chiude l'if event.type
    res.json({ received: true });
}); // <--- QUESTA CHIUDE L'app.post('/webhook'


// 3. ORA puoi attivare express.json (fondamentale che sia DOPO)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 4. Inizializzazioni rimanenti
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const fileManager = new GoogleAIFileManager(process.env.GEMINI_KEY);
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// GEMINI: modello principale + riserva, risposta solo JSON, nuovi tentativi automatici
// ==========================================
const MODELLI_GEMINI = [
    process.env.GEMINI_MODEL || "gemini-2.5-flash",
    process.env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite"
];
const attesa = ms => new Promise(r => setTimeout(r, ms));
const erroreTemporaneo = err => {
    const st = err && (err.status || (err.response && err.response.status));
    const msg = String((err && err.message) || '');
    return [429, 500, 502, 503, 504].includes(st) || /overloaded|high demand|unavailable|timeout|ECONNRESET|fetch failed/i.test(msg);
};
async function generaConRiprova(parti) {
    let ultimoErrore;
    for (const nomeModello of MODELLI_GEMINI) {
        const m = genAI.getGenerativeModel({
            model: nomeModello,
            generationConfig: { responseMimeType: "application/json", temperature: 0 }
        });
        for (let tentativo = 1; tentativo <= 3; tentativo++) {
            try {
                return await m.generateContent(parti);
            } catch (err) {
                ultimoErrore = err;
                console.warn(`Gemini ${nomeModello} tentativo ${tentativo} fallito: ${err.status || ''} ${err.message}`);
                if (!erroreTemporaneo(err)) break;          // errore non temporaneo: passa al modello di riserva
                if (tentativo < 3) await attesa(2000 * tentativo * tentativo); // 2s, 8s
            }
        }
    }
    throw ultimoErrore;
}

// ==========================================
// PULIZIA DATI ESTRATTI: CAS normalizzati, righe spezzate e doppioni uniti
// ==========================================
// Limiti massimi IFRA Categoria 12 (% nel prodotto finito) diversi da 100%, dagli IFRA Standards 51° emendamento
const IFRA_CAT12_UFFICIALI = {
    '101-85-9': 79.0,
    '103-50-4': 0.24,
    '103-95-7': 16.0,
    '103694-68-4': 8.6,
    '104-54-1': 51.0,
    '105-13-5': 14.0,
    '1125-12-8': 9.5,
    '1205-17-0': 12.0,
    '123-11-5': 31.0,
    '1331-81-3': 14.0,
    '1340-11-0': 31.0,
    '13674-19-6': 28.0,
    '13828-37-0': 28.0,
    '140-67-0': 0.11,
    '1407-27-8': 0.11,
    '16251-77-7': 9.6,
    '16587-71-6': 61.0,
    '1754-00-3': 53.0,
    '18127-01-0': 6.9,
    '1891-67-4': 80.0,
    '2244-16-8': 17.0,
    '2563-07-7': 4.2,
    '2986-54-1': 0.18,
    '31906-04-4': 91.0,
    '33704-61-9': 9.4,
    '33885-52-8': 25.0,
    '34713-70-7': 31.0,
    '471-15-8': 9.5,
    '499-70-7': 0.0019,
    '51414-25-6': 91.0,
    '53243-59-7': 65.0,
    '53243-60-0': 65.0,
    '53767-86-5': 0.1,
    '546-80-5': 9.5,
    '5471-51-2': 78.0,
    '5502-75-0': 28.0,
    '55722-59-3': 53.0,
    '59471-80-6': 0.0019,
    '62518-65-4': 64.0,
    '6259-76-3': 64.0,
    '63477-41-8': 58.0,
    '6485-40-1': 17.0,
    '67634-03-1': 20.0,
    '68480-15-9': 0.0013,
    '72203-97-5': 53.0,
    '72203-98-6': 53.0,
    '7493-74-5': 52.0,
    '76231-76-0': 9.5,
    '77525-18-9': 0.11,
    '80-54-6': 16.0,
    '863306-60-9': 52.0,
    '91-64-5': 33.0,
    '916887-53-1': 66.0,
    '93-15-2': 0.066,
    '93-29-8': 16.0,
    '93-53-8': 31.0,
    '93893-89-1': 65.0,
    '94-86-0': 58.0,
    '98-01-1': 0.05,
    '98-53-3': 58.0,
    '99-49-0': 17.0
};

const RE_CAS = /^\d{2,7}-\d{2}-\d$/;
function normalizzaCas(cas) {
    const cifre = String(cas || '').match(/\d+/g);
    if (!cifre || cifre.length !== 3) return String(cas || '').trim();
    const c = cifre.join('-');
    return RE_CAS.test(c) ? c : String(cas || '').trim();
}
function codiciH(clp) {
    return String(clp || '').toUpperCase().match(/H\d{3}[A-Z]?|EUH\d{3}/g) || [];
}
function normalizzaSostanze(lista) {
    const avvisi = [];
    const risultato = [];
    const perCas = {};
    (Array.isArray(lista) ? lista : []).forEach(orig => {
        const s = { ...orig };
        s.cas = normalizzaCas(s.cas);
        const casValido = RE_CAS.test(s.cas);
        const precedente = risultato[risultato.length - 1];
        if (casValido && perCas[s.cas]) {
            // Stesso CAS già presente: è la stessa sostanza (riga spezzata o ripetuta)
            const t = perCas[s.cas];
            unisci(t, s);
            avvisi.push(`"${s.nome}" unita a "${t.nome}" (stesso CAS ${s.cas})`);
            return;
        }
        if (!casValido && precedente) {
            // Riga senza CAS subito dopo un'altra: continuazione della riga precedente
            unisci(precedente, s, true);
            avvisi.push(`"${s.nome || 'riga senza nome'}" (senza CAS) unita a "${precedente.nome}"`);
            return;
        }
        risultato.push(s);
        if (casValido) perCas[s.cas] = s;
    });
    return { lista: risultato, avvisi };
}
function unisci(t, s, continuazione = false) {
    const codici = new Set([...codiciH(t.clp), ...codiciH(s.clp)]);
    t.clp = Array.from(codici).join(', ');
    if (!continuazione) {
        const maxT = parseFloat(t.concentrazione) || 0, maxS = parseFloat(s.concentrazione) || 0;
        const minT = parseFloat(t.concentrazione_min), minS = parseFloat(s.concentrazione_min);
        t.concentrazione = Math.max(maxT, maxS);
        if (isFinite(minT) || isFinite(minS)) t.concentrazione_min = Math.max(isFinite(minT) ? minT : 0, isFinite(minS) ? minS : 0);
    } else if (!(parseFloat(t.concentrazione) > 0) && parseFloat(s.concentrazione) > 0) {
        t.concentrazione = s.concentrazione;
        t.concentrazione_min = s.concentrazione_min;
    }
    // Nome: se uno dei due è il pezzo mancante dell'altro, li si ricompone
    const nt = String(t.nome || ''), ns = String(s.nome || '');
    if (continuazione && ns && !nt.toUpperCase().includes(ns.toUpperCase())) t.nome = (nt + ns).replace(/\s+/g, ' ').trim();
    else if (ns.length > nt.length && ns.toUpperCase().includes(nt.toUpperCase())) t.nome = ns;
    const sev = { '1A': 3, '1': 2, '1B': 1 };
    if ((sev[s.sens_categoria] || 0) > (sev[t.sens_categoria] || 0)) t.sens_categoria = s.sens_categoria;
    const mS = parseFloat(s.m_cronico), mT = parseFloat(t.m_cronico);
    if (isFinite(mS) && mS > (isFinite(mT) ? mT : 1)) t.m_cronico = mS;
    const sclS = parseFloat(s.scl_h317), sclT = parseFloat(t.scl_h317);
    if (isFinite(sclS) && sclS > 0 && (!isFinite(sclT) || sclS < sclT)) t.scl_h317 = sclS;
}

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connesso a MongoDB"))
    .catch(err => { console.error("❌ ERRORE CRITICO DB:", err); });

// ... (qui prosegui con le tue altre rotte API)
// ==========================================
// MODELLI DATABASE
// ==========================================
const User = mongoose.model('User', new mongoose.Schema({
    companyName: String,
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 1 },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    role: { type: String, default: 'user' }
}));

const Report = mongoose.model('Report', new mongoose.Schema({
    userId: String,
    nomeFragranza: String,
    esito: String,
    target: Number,
    prezzo: Number,
    analisiCompleta: Object
}));

const Substance = mongoose.model('Substance', new mongoose.Schema({
    cas: { type: String, required: true },
    nome: { type: String, required: true },
    scl: { type: Number, required: true, default: 1.0 },
    ifraCat12: { type: Number, default: 100 }
}));
const ProcessedEvent = mongoose.model('ProcessedEvent', new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    processedAt: { type: Date, default: Date.now }
}));

/// Middleware Autenticazione
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token mancante" });
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        if (!req.user) return res.status(401).json({ error: "Utente non trovato" });
        next();
    } catch (e) { res.status(401).json({ error: "Non autorizzato" }); }
};

// Middleware Controllo Ruolo Admin
const verifyAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: "Accesso riservato agli amministratori." });
    }
    next();
};

// ==========================================
// ROTTE API - AUTENTICAZIONE E UTENTE
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        
        if (!user) return res.status(401).json({ error: "Utente non trovato" });
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Credenziali errate" });
        
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.json({ token });
    } catch (error) {
        res.status(500).json({ error: "Errore interno: " + error.message });
    }
});

app.post('/api/register', async (req, res) => {
    try {
        const { companyName, email, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ companyName, email, password: hashedPassword });
        await newUser.save();
        res.status(201).json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Errore registrazione" });
    }
});

// ROTTA CORRETTA PER RICHIESTA RESET
app.post('/api/request-reset', async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ error: "Utente non trovato." });

    const token = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000;
    await user.save();

    const resetLink = `https://safetydata-backend.onrender.com/reset.html?token=${token}`;
    
    // Log per debug
    console.log("LINK DI RESET GENERATO:", resetLink);
    
    // Invio Email con SendGrid
    const msg = {
        to: email,
        from: 'luxusaureastudio@gmail.com', 
        subject: 'Reset Password - Luxus Aurea',
        text: `Clicca qui per resettare la password: ${resetLink}`,
        html: `<p>Clicca sul link sottostante per resettare la tua password:</p><a href="${resetLink}">Reset Password</a>`
    };

    try {
        await sgMail.send(msg);
        res.json({ success: true, message: "Email inviata con successo." });
    } catch (e) {
        console.error("Errore SendGrid:", e);
        // Se SendGrid fallisce, restituiamo comunque il link nei log per non bloccare l'utente
        res.status(500).json({ error: "Errore invio email, contatta l'assistenza." });
    }
});

// ROTTA PER RESET PASSWORD
app.post('/api/reset-password', async (req, res) => {
    const { token, password } = req.body;

    const user = await User.findOne({
        resetPasswordToken: token,
        resetPasswordExpires: { $gt: Date.now() } 
    });

    if (!user) {
        return res.status(400).json({ error: "Token non valido o scaduto." });
    }

    user.password = await bcrypt.hash(password, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    
    await user.save();

    res.json({ success: true, message: "Password aggiornata correttamente." });
});

app.get('/api/user-info', verifyToken, (req, res) => res.json({ credits: req.user.credits }));
app.get('/api/my-archive', verifyToken, async (req, res) => res.json(await Report.find({ userId: req.user._id })));
// ==========================================
// ROTTE API - ANALISI PDF (IL METODO DEFINITIVO)
// ==========================================
app.post('/api/analyze-pdf', verifyToken, upload.single('sds_file'), async (req, res) => {
    let tempFilePath = '';
    try {
        if (!req.file) return res.status(400).json({ error: "File mancante" });
        if (req.user.credits <= 0) return res.status(403).json({ error: "Crediti insufficienti. Ricarica per continuare." });

        // 1. Creiamo un file temporaneo sicuro sul server
        tempFilePath = path.join(os.tmpdir(), `sds_${Date.now()}.pdf`);
        fs.writeFileSync(tempFilePath, req.file.buffer);

        // 2. Carichiamo il file tramite l'API ufficiale GoogleAIFileManager
        const uploadResponse = await fileManager.uploadFile(tempFilePath, {
            mimeType: "application/pdf",
            displayName: "SDS Fragranza",
        });

        // 3. Istruzioni per Gemini
        const prompt = `Analizza la Scheda di Sicurezza (SDS) allegata ed estrai la lista dei componenti chimici pericolosi o allergeni presenti nella sezione 3.
        Restituisci ESCLUSIVAMENTE un oggetto JSON valido che segua tassativamente questa struttura, senza includere blocchi di codice markdown (\`\`\`json) e senza alcun testo discorsivo prima o dopo:

        {
          "components": [
            {
              "nome": "NOME DELLA SOSTANZA IN MAIUSCOLO",
              "cas": "NUMERO CAS (formato XXX-XX-X)",
              "concentrazione_min": 0.0,
              "concentrazione": 0.0,
              "clp": "CODICI H DI PERICOLO (separati da virgola, es. H317, H411)",
              "sens_categoria": "CATEGORIA DI SENSIBILIZZAZIONE CUTANEA: 1A, 1B, 1 oppure stringa vuota",
              "scl_h317": null,
              "m_cronico": 1
            }
          ]
        }

        REGOLE PER IL CAMPO "concentrazione":
        - Deve essere SEMPRE un numero espresso in PERCENTUALE (%) in peso nella miscela.
        - Se la SDS indica un intervallo (es. ">= 5% - < 10%"), metti in "concentrazione" il valore MASSIMO (es. 10) e in "concentrazione_min" il valore MINIMO (es. 5).
        - Se la SDS indica un valore singolo (es. "319 ppm" o "2%"), usa lo stesso valore sia in "concentrazione" sia in "concentrazione_min".
        - Se la SDS indica ppm, converti: 1 ppm = 0.0001 % (es. 319 ppm -> 0.0319).
        - Se la SDS indica ppb, converti: 1 ppb = 0.0000001 % (es. 486 ppb -> 0.0000486).
        - Non restituire mai il numero in ppm o ppb senza conversione.

        REGOLE PER LA CLASSIFICAZIONE:
        - Le righe della tabella possono essere SPEZZATE tra due pagine: la classificazione di una sostanza può continuare
          in cima alla pagina successiva. Unisci sempre la continuazione alla sostanza della riga precedente e riporta
          TUTTI i codici H di quella sostanza (es. se a fine pagina c'è "Skin Sens." e a inizio pagina "1A H317", la sostanza ha H317 cat. 1A).
        - Ogni sostanza deve comparire UNA SOLA VOLTA. Se il NOME di una sostanza è spezzato tra due pagine
          (es. "(1S)2,6,6,-TRIMETHY" a fine pagina e "LBICYCLO-2-HEPTENE" a inizio pagina), ricomponi il nome completo
          e crea un solo oggetto con il suo CAS.
        - In "clp" includi tutti i codici H (anche H314 per Skin Corr., H318 per Eye Dam., H400/H410/H411/H412 per l'ambiente).
        - In "sens_categoria" indica la categoria di Skin Sens. (1A, 1B o 1) se la sostanza ha H317, altrimenti "".
        - In "scl_h317" indica il limite di concentrazione specifico in % per Skin Sens. se la SDS lo riporta
          (es. "C >= 0,01%: Skin Sens. 1A H317" -> 0.01), altrimenti null.
        - In "m_cronico" indica il FATTORE M per la tossicità acquatica CRONICA (es. "M=10", "Mchronic = 10",
          "M=1 (toxicité chronique)") se la SDS lo riporta. Se è indicato un solo fattore M senza specificare, usalo.
          Se non è indicato, usa 1.`;

        // 4. Inviamo il Prompt collegando il file appena caricato
        const result = await generaConRiprova([
            {
                fileData: {
                    mimeType: uploadResponse.file.mimeType,
                    fileUri: uploadResponse.file.uri
                }
            },
            { text: prompt },
        ]);

        // 5. Cancelliamo il file temporaneo per fare pulizia
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);

        // 6. Pulizia e Parsing della risposta JSON
        let jsonText = result.response.text();
        jsonText = jsonText.replace(/```json|```/g, "").trim();
        const inizio = jsonText.indexOf('{'), fine = jsonText.lastIndexOf('}');
        if (inizio > 0 || (fine >= 0 && fine < jsonText.length - 1)) jsonText = jsonText.slice(inizio, fine + 1);
        const analysisData = JSON.parse(jsonText);
        const grezzi = Array.isArray(analysisData) ? analysisData : (analysisData.components || []);
        const pulite = normalizzaSostanze(grezzi);
        if (Array.isArray(analysisData)) { analysisData.length = 0; analysisData.push(...pulite.lista); }
        else analysisData.components = pulite.lista;
        if (pulite.avvisi.length) console.log("Righe unite:", pulite.avvisi);

        req.user.credits -= 1;
        await req.user.save();

        res.json({ analysis: analysisData, avvisiLettura: pulite.avvisi, remainingCredits: req.user.credits });

    } catch (error) {
        console.error("ERRORE METODO FILE MANAGER:", error);
        // Pulizia sicura in caso di crash
        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        if (erroreTemporaneo(error)) {
            return res.status(503).json({ error: "Servizio IA momentaneamente sovraccarico. Riprova tra qualche minuto: nessun credito è stato scalato." });
        }
        if (error instanceof SyntaxError) {
            return res.status(502).json({ error: "L'IA ha restituito una risposta non leggibile. Riprova: nessun credito è stato scalato." });
        }
        res.status(500).json({ error: "Errore durante l'elaborazione tramite Google AI. Nessun credito è stato scalato." });
    }
});

// ==========================================
// ROTTE API - SALVATAGGIO, ARCHIVIO, ADMIN
// ==========================================
app.post('/api/save-report', verifyToken, async (req, res) => {
    try {
        const { nomeFragranza, esito, target, prezzo, analisiCompleta } = req.body;
        if (!analisiCompleta) return res.status(400).json({ error: "Dati di analisi mancanti." });

        const newReport = new Report({
            userId: req.user._id,
            nomeFragranza: nomeFragranza || "SENZA NOME",
            esito: esito || "SCONOSCIUTO",
            target: target || 0,
            prezzo,
            analisiCompleta: analisiCompleta
        });

        await newReport.save();
        res.status(201).json({ success: true, message: "Report salvato con successo." });
    } catch (error) {
        res.status(500).json({ error: "Impossibile salvare il report." });
    }
});

app.delete('/api/svuota-archivio', verifyToken, async (req, res) => {
    try {
        await Report.deleteMany({ userId: req.user._id });
        res.json({ success: true, message: "Archivio svuotato con successo." });
    } catch (error) {
        res.status(500).json({ error: "Impossibile svuotare l'archivio." });
    }
});

// ==========================================
// ROTTA API - CALCOLO CONFORMITÀ (LATO SERVER)
// ==========================================
app.post('/api/calculate-compliance', verifyToken, async (req, res) => {
    try {
        const { sostanze, targetUso, ifraCategoria } = req.body;

        if (!Array.isArray(sostanze)) {
            return res.status(400).json({ error: "Dati sostanze mancanti o non validi." });
        }

                const target = parseFloat(targetUso) || 10;

        // Carica i limiti IFRA reali dal database (collection Substance)
        const tutteLeSostanzeDB = await Substance.find({});

        // Sostanze con IFRA Standard di tipo SPECIFICA sulla fragranza (olio), non sul prodotto finito.
        // Il limite è espresso in % nella miscela profumata, NON nella candela.
        // Toluene (IFRA Amendment 38): vietato come ingrediente, ammesso come impurità max 100 ppm = 0.01 % nell'olio.
        const LIMITI_SPECIFICA_OLIO = {
            '108-88-3': 0.01
        };
        const motiviNonConformita = [];
        const ifraDB = {};
        const RIPRODUZIONE_1B = { '80-54-6': true };
        tutteLeSostanzeDB.forEach(s => {
            ifraDB[s.cas] = s.ifraCat12;
        });
        // Limiti ufficiali IFRA 51° emendamento, Categoria 12 (<100%), estratti dagli Standard: prevalgono sul database
        Object.keys(IFRA_CAT12_UFFICIALI).forEach(cas => { ifraDB[cas] = IFRA_CAT12_UFFICIALI[cas]; });

        
        // ------------------------------------------------------------------
        // CASO PEGGIORE REALISTICO
        // Le SDS riportano intervalli (es. ">= 30% - < 40%"). Prendere il massimo di TUTTI
        // gli intervalli insieme può dare una formula che supera il 100% (impossibile).
        // Qui si usa il massimo di ogni intervallo, ma con il vincolo che la somma dei
        // componenti non superi il 100%: per ogni classe di pericolo si "riempie" il
        // margine disponibile partendo dalle sostanze che pesano di più.
        // Se i dati non lo permettono (minimi mancanti o somma minimi > 100), si torna
        // al criterio del massimo di tutti gli intervalli.
        // ------------------------------------------------------------------
        const pulizia = normalizzaSostanze(sostanze);
        const avvisiLettura = pulizia.avvisi;
        const componenti = pulizia.lista.map(s => {
            const max = Math.max(0, parseFloat(s.concentrazione) || 0);
            let min = parseFloat(s.concentrazione_min);
            if (!isFinite(min) || min < 0 || min > max) min = max;
            const codici = s.clp ? (String(s.clp).toUpperCase().match(/H\d{3}[A-Z]?|EUH\d{3}/g) || []) : [];
            const casC = String(s.cas || '').trim();
            // Classificazione armonizzata aggiornata (ATP 17, in vigore dal 2022): Lilial Repr. 1B H360
            if (RIPRODUZIONE_1B[casC] && !codici.includes('H360')) codici.push('H360');
            let m = parseFloat(s.m_cronico);
            if (!isFinite(m) || m < 1) m = 1;
            return { s, min, max, codici, cas: casC, nome: s.nome, m };
        });

        const sommaMin = componenti.reduce((t, c) => t + c.min, 0);
        const sommaMax = componenti.reduce((t, c) => t + c.max, 0);
        const margine = 100 - sommaMin;
        const vincolo100 = margine >= 0 && sommaMax > 100;
        let notaCalcolo = '';
        if (vincolo100) {
            notaCalcolo = `Calcolo sul caso peggiore realistico: massimo di ogni intervallo SDS con totale formula vincolato al 100% (somma dei massimi dichiarati: ${sommaMax.toFixed(1)}%).`;
        } else if (sommaMax > 100) {
            notaCalcolo = `Calcolo prudenziale sul massimo di tutti gli intervalli SDS (dati minimi non disponibili; somma dei massimi: ${sommaMax.toFixed(1)}%).`;
        }

        // Concentrazione massima realistica della singola sostanza nella fragranza
        // Nomi da usare in etichetta (denominazione dell'Allegato VI CLP, dove esiste)
        const NOMI_ETICHETTA = {
            '5989-27-5': 'd-Limonene', '138-86-3': 'Limonene', '78-70-6': 'Linalool', '115-95-7': 'Linalyl acetate',
            '97-53-0': 'Eugenol', '104-55-2': 'Cinnamal', '106-24-1': 'Geraniol', '118-58-1': 'Benzyl salicylate',
            '107-75-5': 'Hydroxycitronellal', '122-40-7': 'Amyl cinnamal', '97-54-1': 'Isoeugenol', '106-22-9': 'Citronellol',
            '5392-40-5': 'Citral', '101-86-0': 'Hexyl cinnamal', '91-64-5': 'Coumarin', '4602-84-0': 'Farnesol',
            '104-54-1': 'Cinnamyl alcohol', '120-51-4': 'Benzyl benzoate', '100-51-6': 'Benzyl alcohol',
            '127-51-5': 'Alpha-isomethyl ionone', '103-95-7': 'Cyclamen aldehyde', '106-23-0': 'Citronellal',
            '54464-57-2': 'Tetramethyl acetyloctahydronaphthalenes', '32210-23-4': '4-tert-Butylcyclohexyl acetate',
            '32388-55-9': 'Acetyl cedrene', '19870-74-7': 'Cedryl methyl ether', '470-82-6': 'Eucalyptol',
            '7785-26-4': 'alpha-Pinene', '80-56-8': 'alpha-Pinene', '127-91-3': 'beta-Pinene', '7212-44-4': 'Nerolidol',
            '141-12-8': 'Neryl acetate', '106-25-2': 'Nerol', '105-87-3': 'Geranyl acetate', '6259-76-3': 'Hexyl salicylate',
            '93-28-7': 'Eugenyl acetate', '122-78-1': 'Phenylacetaldehyde', '6485-40-1': 'l-Carvone',
            '111-80-8': 'Methyl 2-nonynoate', '111-12-6': 'Methyl 2-octynoate', '87-44-5': 'Caryophyllene',
            '65416-14-0': 'Maltyl isobutyrate', '106-72-9': 'Melonal',
            '8008-57-9': 'Citrus aurantium dulcis peel oil', '8022-15-9': 'Lavandula hybrida oil',
            '8008-79-5': 'Mentha viridis leaf oil', '8000-46-2': 'Pelargonium graveolens oil',
            '8007-75-8': 'Citrus aurantium bergamia peel oil', '8014-09-3': 'Pogostemon cablin oil',
            '8000-34-8': 'Eugenia caryophyllus leaf oil', '8006-82-4': 'Piper nigrum fruit oil',
            '80-25-1': 'p-Menthan-8-yl acetate', '8008-56-8': 'Citrus limon peel oil', '8002-09-3': 'Pine oil',
            '78-69-3': 'Tetrahydrolinalool', '165184-98-5': 'Hexyl cinnamal',
            '31906-04-4': 'Hydroxyisohexyl 3-cyclohexene carboxaldehyde', '1205-17-0': 'Methylenedioxyphenyl methylpropanal',
            '4180-23-8': 'Anethole', '4707-47-5': 'Methyl atrarate', '77-83-8': 'Ethyl methylphenylglycidate',
            '103694-68-4': 'Dimethyl tolylpropanol', '5462-06-6': '3-(4-Methoxyphenyl)-2-methylpropanal',
            '68039-49-6': 'Dimethylcyclohexene carboxaldehyde', '80-54-6': 'Butylphenyl methylpropional',
            '127-91-3': 'beta-Pinene', '105-87-3': 'Geranyl acetate'
        };

        // Rete di sicurezza: sensibilizzanti cutanei noti (classificazione tipica delle SDS dei fornitori).
        // Se l'IA non legge H317 (es. riga spezzata tra due pagine) lo si aggiunge comunque;
        // tra la categoria letta e quella nota si usa la più severa.
        const SENSIBILIZZANTI_NOTI = {
            '104-55-2': { cat: '1A' },               // Cinnamal
            '97-54-1':  { cat: '1A', scl: 0.01 },    // Isoeugenol
            '111-80-8': { cat: '1A' },               // Methyl 2-nonynoate
            '111-12-6': { cat: '1A' },               // Methyl 2-octynoate
            '97-53-0':  { cat: '1B' },               // Eugenol
            '106-24-1': { cat: '1' },                // Geraniol
            '5392-40-5':{ cat: '1B' },               // Citral
            '107-75-5': { cat: '1B' },               // Hydroxycitronellal
            '122-40-7': { cat: '1' },                // Amyl cinnamal
            '101-86-0': { cat: '1B' },               // Hexyl cinnamal
            '104-54-1': { cat: '1B' },               // Cinnamyl alcohol
            '91-64-5':  { cat: '1B' },               // Coumarin
            '4602-84-0':{ cat: '1B' },               // Farnesol
            '106-22-9': { cat: '1B' },               // Citronellol
            '78-70-6':  { cat: '1B' },               // Linalool
            '5989-27-5':{ cat: '1B' },               // d-Limonene
            '118-58-1': { cat: '1B' },               // Benzyl salicylate
            '115-95-7': { cat: '1B' },               // Linalyl acetate
            '470-82-6': { cat: '1B' },               // Eucalyptol
            '32388-55-9': { cat: '1B' },             // Acetyl cedrene
            '32210-23-4': { cat: '1B' },             // 4-tert-Butylcyclohexyl acetate
            '54464-57-2': { cat: '1B' },             // OTNE (Iso E Super)
            '103-95-7': { cat: '1B' },               // Cyclamen aldehyde
            '106-23-0': { cat: '1B' },               // Citronellal
            '106-25-2': { cat: '1B' },               // Nerol
            '105-87-3': { cat: '1B' },               // Geranyl acetate
            '80-56-8': { cat: '1B' },                // alpha-Pinene
            '7785-26-4': { cat: '1B' },              // alpha-Pinene (1S)
            '127-91-3': { cat: '1B' },               // beta-Pinene
            '4180-23-8': { cat: '1B' },              // Anethole
            '6259-76-3': { cat: '1B' },              // Hexyl salicylate
            '165184-98-5': { cat: '1B' },            // Hexyl cinnamal
            '31906-04-4': { cat: '1A' },             // HICC (Lyral)
            '80-54-6': { cat: '1B' },                // Lilial
            '1205-17-0': { cat: '1B' },              // Helional
            '103694-68-4': { cat: '1B' },            // Majantol
            '77-83-8': { cat: '1B' },                // Ethyl methylphenylglycidate
            '68039-49-6': { cat: '1B' },             // Triplal
            '5462-06-6': { cat: '1B' },              // Fennaldehyde
            '87-44-5': { cat: '1B' },                // Caryophyllene
            '4707-47-5': { cat: '1B' }               // Methyl atrarate
        };
        const severita = { '1A': 3, '1': 2, '1B': 1 };
        componenti.forEach(c => {
            const nota = SENSIBILIZZANTI_NOTI[c.cas];
            let cat = String(c.s.sens_categoria || '').toUpperCase().replace(/\s/g, '');
            if (!severita[cat]) cat = c.codici.includes('H317') ? '1' : '';
            if (nota) {
                if (!c.codici.includes('H317')) c.codici.push('H317');
                if (!cat || severita[nota.cat] > severita[cat]) cat = nota.cat;
            }
            c.sensCat = cat;
            let scl = parseFloat(c.s.scl_h317);
            if (!isFinite(scl) || scl <= 0) scl = (nota && nota.scl) ? nota.scl : null;
            // Limite di classificazione H317 nel prodotto finito (CLP Allegato I, tab. 3.4.5)
            c.limiteH317 = scl !== null ? scl : (cat === '1A' ? 0.1 : 1.0);
        });

        const maxSingolo = c => vincolo100 ? Math.min(c.max, c.min + margine) : c.max;

        // Somma pesata nel caso peggiore, espressa in % nel prodotto finito
        const casoPeggiore = pesoFn => {
            const pesati = componenti.map(c => ({ c, w: pesoFn(c) })).filter(x => x.w > 0);
            let totale;
            if (!vincolo100) {
                totale = pesati.reduce((t, x) => t + x.w * x.c.max, 0);
            } else {
                totale = pesati.reduce((t, x) => t + x.w * x.c.min, 0);
                let residuo = margine;
                pesati.sort((a, b) => b.w - a.w).forEach(x => {
                    const extra = Math.min(x.c.max - x.c.min, residuo);
                    if (extra > 0) { totale += x.w * extra; residuo -= extra; }
                });
            }
            return totale * target / 100;
        };
        const ha = h => c => c.codici.includes(h) ? 1 : 0;

        let isSafe = true;
        let allergeniEtichetta = [];
        let hasSensitizer = false, hasRepro = false, containsEndocrine = false;
        let forzaH412Precauzione = false;

        componenti.forEach(c => {
            const s = c.s;
            const concOlio = maxSingolo(c);
            const concProdotto = concOlio * target / 100;
            const nomeUpper = String(s.nome || '').toUpperCase();
            const casSostanza = c.cas;

            if ((nomeUpper.includes("MENTA") || nomeUpper.includes("DIENE") || nomeUpper.includes("LIMONENE") || casSostanza === "5989-27-5") && concProdotto >= 1.5) {
                forzaH412Precauzione = true;
            }

            if (LIMITI_SPECIFICA_OLIO[casSostanza] !== undefined) {
                // Controllo sull'olio profumato (specifica IFRA), non sul prodotto finito
                if (concOlio > LIMITI_SPECIFICA_OLIO[casSostanza]) {
                    isSafe = false;
                    motiviNonConformita.push(`${s.nome} (${casSostanza}): ${concOlio}% nella fragranza, limite IFRA ${LIMITI_SPECIFICA_OLIO[casSostanza]}% nella fragranza`);
                }
            } else {
                const limiteCat12 = ifraDB[casSostanza];
                // Si confronta solo se il limite è un numero valido (null/undefined = dato mancante, non "limite zero")
                if (typeof limiteCat12 === 'number' && !isNaN(limiteCat12) && concProdotto > limiteCat12) {
                    isSafe = false;
                    motiviNonConformita.push(`${s.nome} (${casSostanza}): ${concProdotto.toFixed(4)}% nel prodotto finito, limite IFRA Cat.12 ${limiteCat12}%`);
                }
            }

            c.codici.forEach(h => {
                if (h === 'H317') {
                    // Nome in etichetta: sostanze >= 1/10 del limite di classificazione (0,1% per 1/1B, 0,01% per 1A)
                    // CLP Allegato II, 2.8: sostanza sensibilizzante in concentrazione PARI O SUPERIORE a 1/10 del limite
                    if (concProdotto >= c.limiteH317 / 10 - 1e-9) {
                        const nomeEtichetta = NOMI_ETICHETTA[casSostanza] || s.nome;
                        if (!allergeniEtichetta.includes(nomeEtichetta)) allergeniEtichetta.push(nomeEtichetta);
                    }
                    if (concProdotto >= c.limiteH317) hasSensitizer = true;
                }
                if (h === 'H360' && concProdotto >= 0.3) hasRepro = true;
                if (h === 'EUH380' || h === 'EUH440') containsEndocrine = true;
            });
        });

        // Somme additive nel caso peggiore (ognuna calcolata per la propria classe di pericolo)
        // Categoria 1 pelle/occhi: H314 (corrosivo) conta anche come danno oculare grave
        const cat1Occhi = c => (c.codici.includes('H314') || c.codici.includes('H318')) ? 1 : 0;
        const sumH314 = casoPeggiore(ha('H314'));
        const sumH318 = casoPeggiore(cat1Occhi);
        // H315: Skin Irrit 2 >= 10%  oppure  10 x Skin Corr 1 + Skin Irrit 2 >= 10%
        const sumH315 = casoPeggiore(c => c.codici.includes('H314') ? 10 : (c.codici.includes('H315') ? 1 : 0));
        // H319: Eye Irrit 2 >= 10%  oppure  10 x (Skin Corr 1 + Eye Dam 1) + Eye Irrit 2 >= 10%
        const sumH319 = casoPeggiore(c => cat1Occhi(c) ? 10 : (c.codici.includes('H319') ? 1 : 0));
        // CLP Allegato I, 4.1.3.5.5: le sostanze Chronic 1 (H410) si moltiplicano per il fattore M
        const sumH410 = casoPeggiore(c => c.codici.includes('H410') ? c.m : 0);
        const testH411 = casoPeggiore(c => c.codici.includes('H410') ? 10 * c.m : (c.codici.includes('H411') ? 1 : 0));
        const testH412 = casoPeggiore(c => c.codici.includes('H410') ? 100 * c.m : (c.codici.includes('H411') ? 10 : (c.codici.includes('H412') ? 1 : 0)));

        let codiciMiscela = new Set();
        if (sumH314 >= 5.0) codiciMiscela.add('H314');
        else if (sumH318 >= 3.0) codiciMiscela.add('H318');
        else if (sumH318 >= 1.0 || sumH319 >= 10.0) codiciMiscela.add('H319');
        if (!codiciMiscela.has('H314') && sumH315 >= 10.0) codiciMiscela.add('H315');
        if (hasSensitizer) codiciMiscela.add('H317');
        if (hasRepro) codiciMiscela.add('H360');

        if (sumH410 >= 25.0) codiciMiscela.add('H410');
        else if (testH411 >= 25.0) codiciMiscela.add('H411');
        else if (testH412 >= 25.0 || forzaH412Precauzione) {
            codiciMiscela.add('H412');
        }

        const listaH_finali = Array.from(codiciMiscela).sort();
        const scattaUFI = listaH_finali.some(h => h.startsWith('H3') || h.startsWith('H2'));

        // ---------------- ELEMENTI DELL'ETICHETTA (CLP Allegati III e IV) ----------------
        const TESTI_H = {
            H314: 'Provoca gravi ustioni cutanee e gravi lesioni oculari.',
            H315: 'Provoca irritazione cutanea.',
            H317: 'Può provocare una reazione allergica cutanea.',
            H318: 'Provoca gravi lesioni oculari.',
            H319: 'Provoca grave irritazione oculare.',
            H360: 'Può nuocere alla fertilità o al feto.',
            H410: 'Molto tossico per gli organismi acquatici con effetti di lunga durata.',
            H411: 'Tossico per gli organismi acquatici con effetti di lunga durata.',
            H412: 'Nocivo per gli organismi acquatici con effetti di lunga durata.'
        };
        const frasiH = listaH_finali.map(h => ({ codice: h, testo: TESTI_H[h] || '' }));

        // Avvertenza: PERICOLO prevale su ATTENZIONE; H411/H412 non richiedono avvertenza
        const H_PERICOLO = ['H314', 'H318', 'H360'];
        const H_ATTENZIONE = ['H315', 'H317', 'H319', 'H410'];
        let avvertenza = '';
        if (listaH_finali.some(h => H_PERICOLO.includes(h))) avvertenza = 'PERICOLO';
        else if (listaH_finali.some(h => H_ATTENZIONE.includes(h))) avvertenza = 'ATTENZIONE';

        // Consigli di prudenza per prodotto destinato al consumatore (candela).
        // CLP art. 28, par. 3: di norma non più di 6 frasi, salvo quando servono per natura e gravità dei pericoli.
        const TESTI_P = {
            'P101': "In caso di consultazione di un medico, tenere a disposizione il contenitore o l'etichetta del prodotto.",
            'P102': 'Tenere fuori dalla portata dei bambini.',
            'P201': "Procurarsi istruzioni specifiche prima dell'uso.",
            'P280': 'Indossare guanti protettivi.',
            'P303+P361+P353': 'IN CASO DI CONTATTO CON LA PELLE (o con i capelli): togliere immediatamente tutti gli indumenti contaminati. Sciacquare la pelle o fare una doccia.',
            'P302+P352': 'IN CASO DI CONTATTO CON LA PELLE: lavare abbondantemente con acqua e sapone.',
            'P305+P351+P338': 'IN CASO DI CONTATTO CON GLI OCCHI: sciacquare accuratamente per parecchi minuti. Togliere le eventuali lenti a contatto se è agevole farlo. Continuare a sciacquare.',
            'P308+P313': 'IN CASO di esposizione o di possibile esposizione, consultare un medico.',
            'P310': 'Contattare immediatamente un CENTRO ANTIVELENI o un medico.',
            'P332+P313': 'In caso di irritazione della pelle: consultare un medico.',
            'P333+P313': 'In caso di irritazione o eruzione della pelle: consultare un medico.',
            'P337+P313': "Se l'irritazione degli occhi persiste, consultare un medico.",
            'P273': "Non disperdere nell'ambiente.",
            'P501': 'Smaltire il prodotto/recipiente in conformità alla regolamentazione locale.'
        };
        const haH = h => listaH_finali.includes(h);
        const haSalute = listaH_finali.some(h => h.startsWith('H3'));
        const haAmbiente = listaH_finali.some(h => h.startsWith('H4'));
        const codiciP = [];
        const aggiungiP = p => { if (!codiciP.includes(p)) codiciP.push(p); };
        if (haSalute) { aggiungiP('P102'); aggiungiP('P101'); }
        if (haH('H360')) { aggiungiP('P201'); aggiungiP('P308+P313'); }
        if (haH('H314')) { aggiungiP('P280'); aggiungiP('P303+P361+P353'); aggiungiP('P305+P351+P338'); aggiungiP('P310'); }
        if (haH('H318')) { aggiungiP('P280'); aggiungiP('P305+P351+P338'); aggiungiP('P310'); }
        if (haH('H317') || haH('H315')) aggiungiP('P302+P352');
        if (haH('H317')) aggiungiP('P333+P313');
        else if (haH('H315')) aggiungiP('P332+P313');
        if (haH('H319')) { aggiungiP('P305+P351+P338'); aggiungiP('P337+P313'); }
        if (haAmbiente) aggiungiP('P273');
        if (haSalute || haAmbiente) aggiungiP('P501');
        const frasiP = codiciP.map(p => ({ codice: p, testo: TESTI_P[p] }));

        res.json({
            isSafe,
            motiviNonConformita,
            notaCalcolo,
            avvisiLettura,
            listaH_finali,
            frasiH,
            frasiP,
            avvertenza,
            scattaUFI,
            allergeniEtichetta,
            hasRepro,
            containsEndocrine
        });

    } catch (error) {
        console.error("Errore calcolo conformità:", error);
        res.status(500).json({ error: "Errore durante il calcolo di conformità." });
    }
});

app.get('/api/substances', verifyToken, async (req, res) => {
    try {
        const substances = await Substance.find().sort({ nome: 1 });
        res.json(substances);
    } catch (error) {
        res.status(500).json({ error: "Errore nel recupero delle sostanze." });
    }
});

app.post('/api/substances', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { cas, nome, scl } = req.body;
        const newSubstance = new Substance({ cas, nome, scl: parseFloat(scl) });
        await newSubstance.save();
        res.status(201).json({ success: true, substance: newSubstance });
    } catch (error) {
        res.status(500).json({ error: "Errore salvataggio sostanza." });
    }
});

app.delete('/api/substances/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        await Substance.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Sostanza eliminata." });
    } catch (error) {
        res.status(500).json({ error: "Errore eliminazione." });
    }
});

// ==========================================
// STRIPE E SERVER STATIC
// ==========================================
app.post('/api/create-checkout', verifyToken, async (req, res) => {
    try {
        const { pacchetto, importoPersonalizzato } = req.body;
        const clientUrl = process.env.CLIENT_URL || 'https://safetydata-backend.onrender.com';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            billing_address_collection: 'required',
            tax_id_collection: { enabled: true },
            line_items: [{
                price_data: { 
                    currency: 'eur', 
                    product_data: { name: `Pacchetto ${pacchetto}` }, 
                    unit_amount: Math.round(parseFloat(importoPersonalizzato) * 100) 
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${clientUrl}/index.html?success=true`,
            cancel_url: `${clientUrl}/index.html?canceled=true`,
            // Importante: passiamo l'ID utente nei metadati
            metadata: {
                tipo_acquisto: 'pacchetto_app',
                userId: req.user._id.toString(), 
                pacchetto: pacchetto
            }
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Errore Stripe:", error.message);
        res.status(500).json({ error: "Errore nella creazione della sessione." });
    }
});

app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server attivo su porta ${PORT}`));
