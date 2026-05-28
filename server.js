require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const jwt = require('jsonwebtoken');
const path = require('path');
const bcrypt = require('bcrypt');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const app = express();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connesso a MongoDB"))
    .catch(err => { console.error("❌ ERRORE CRITICO DB:", err); process.exit(1); });

const upload = multer({ storage: multer.memoryStorage() });

if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Inizializzazione SDK Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash-latest" // 👈 AGGIUNTO "-latest"
});

// ==========================================
// MODELLI DATABASE
// ==========================================
const User = mongoose.model('User', new mongoose.Schema({
    companyName: String,
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 10 }
}));

const Report = mongoose.model('Report', new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    nomeFragranza: String,
    esito: String,
    target: Number,
    analisiCompleta: Object
}));

// ✅ Nuovo Modello per la Gestione delle Sostanze e limiti SCL
const Substance = mongoose.model('Substance', new mongoose.Schema({
    cas: { type: String, required: true },
    nome: { type: String, required: true },
    scl: { type: Number, required: true, default: 1.0 }
}));

// Middleware Autenticazione
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

app.get('/api/user-info', verifyToken, (req, res) => res.json({ credits: req.user.credits }));
app.get('/api/my-archive', verifyToken, async (req, res) => res.json(await Report.find({ userId: req.user._id })));

// ==========================================
// ROTTE API - ANALISI E REPORT
// ==========================================
// ✅ CODICE DEFINITIVO PER LA LETTURA NATIVA DEL PDF CON GEMINI
app.post('/api/analyze-pdf', verifyToken, upload.single('sds_file'), async (req, res) => {
    try {
        // 1. Controllo di sicurezza preliminare sul file e sui crediti dell'utente
        if (!req.file) return res.status(400).json({ error: "File mancante" });
        if (req.user.credits <= 0) {
            return res.status(403).json({ error: "Crediti insufficienti. Ricarica per continuare." });
        }
        
        // 2. Trasformazione del buffer binario del PDF in stringa Base64
        const pdfBase64 = req.file.buffer.toString('base64');
        
        // 3. Configurazione del file secondo le specifiche dell'SDK di Google
        const pdfPart = {
            inlineData: {
                data: pdfBase64,
                mimeType: "application/pdf"
            }
        };

        // 4. Istruzioni ferree per l'IA per garantire la compatibilità con il frontend
        const prompt = `Analizza la Scheda di Sicurezza (SDS) allegata ed estrai la lista dei componenti chimici pericolosi o allergeni presenti nella sezione 3.
        Restituisci ESCLUSIVAMENTE un oggetto JSON valido che segua tassativamente questa struttura, senza includere blocchi di codice markdown (\`\`\`json) e senza alcun testo discorsivo prima o dopo:

        {
          "components": [
            {
              "nome": "NOME DELLA SOSTANZA IN MAIUSCOLO",
              "cas": "NUMERO CAS (formato XXX-XX-X)",
              "concentrazione": 0.0, // Inserisci solo il numero decimale o intero più alto del range, senza il simbolo %
              "clp": "CODICI H DI PERICOLO (separati da virgola, es. H317, H411)"
            }
          ]
        }`;

        // 5. Invio simultaneo del testo del prompt e del file PDF a Gemini
        const result = await model.generateContent([prompt, pdfPart]);
        
        // 6. Recupero del testo generato e pulizia protettiva da eventuali formattazioni di testo
        let jsonText = result.response.text();
        jsonText = jsonText.replace(/```json|```/g, "").trim();
        
        // 7. Conversione della stringa in un oggetto JSON reale
        const analysisData = JSON.parse(jsonText);

        // 8. Aggiornamento del profilo utente con la detrazione del credito
        req.user.credits -= 1;
        await req.user.save();

        // 9. Invio della risposta strutturata al client frontend
        res.json({ analysis: analysisData, remainingCredits: req.user.credits });

    } catch (error) {
        console.error("ERRORE STRUTTURALE ANALISI PDF:", error);
        res.status(500).json({ error: "Il server non è riuscito ad elaborare il PDF tramite l'IA." });
    }
});

app.post('/api/save-report', verifyToken, async (req, res) => {
    try {
        const { nomeFragranza, esito, target, analisiCompleta } = req.body;
        
        if (!analisiCompleta) {
            return res.status(400).json({ error: "Dati di analisi mancanti." });
        }

        const newReport = new Report({
            userId: req.user._id,
            nomeFragranza: nomeFragranza || "SENZA NOME",
            esito: esito || "SCONOSCIUTO",
            target: target || 0,
            analisiCompleta: analisiCompleta
        });

        await newReport.save();
        res.status(201).json({ success: true, message: "Report salvato con successo." });
    } catch (error) {
        console.error("Errore salvataggio report:", error);
        res.status(500).json({ error: "Impossibile salvare il report." });
    }
});

app.delete('/api/svuota-archivio', verifyToken, async (req, res) => {
    try {
        await Report.deleteMany({ userId: req.user._id });
        res.json({ success: true, message: "Archivio svuotato con successo." });
    } catch (error) {
        console.error("Errore svuotamento archivio:", error);
        res.status(500).json({ error: "Impossibile svuotare l'archivio." });
    }
});

// ==========================================
// ROTTE API - GESTIONE SOSTANZE E IFRA
// ==========================================
app.get('/api/ifra-database', (req, res) => {
    const mockIfraDB = {
        "5989-27-5": { "cat12": 100 }, 
        "120-51-4": { "cat12": 100 }   
    };
    res.json(mockIfraDB);
});

// ✅ Rotte per l'interfaccia Admin (Lettura, Scrittura, Eliminazione)
app.get('/api/substances', verifyToken, async (req, res) => {
    try {
        const substances = await Substance.find().sort({ nome: 1 });
        res.json(substances);
    } catch (error) {
        res.status(500).json({ error: "Errore nel recupero delle sostanze." });
    }
});

app.post('/api/substances', verifyToken, async (req, res) => {
    try {
        const { cas, nome, scl } = req.body;
        const newSubstance = new Substance({ cas, nome, scl: parseFloat(scl) });
        await newSubstance.save();
        res.status(201).json({ success: true, substance: newSubstance });
    } catch (error) {
        res.status(500).json({ error: "Errore durante il salvataggio della sostanza." });
    }
});

app.delete('/api/substances/:id', verifyToken, async (req, res) => {
    try {
        await Substance.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Sostanza eliminata." });
    } catch (error) {
        res.status(500).json({ error: "Errore durante l'eliminazione." });
    }
});

// ==========================================
// STRIPE CHECKOUT
// ==========================================
app.post('/api/create-checkout', verifyToken, async (req, res) => {
    try {
        const { pacchetto, importoPersonalizzato } = req.body;
        const clientUrl = process.env.CLIENT_URL || 'https://safetydata-backend.onrender.com';

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: { 
                    currency: 'eur', 
                    product_data: { name: `Pacchetto ${pacchetto}` }, 
                    unit_amount: Math.round(importoPersonalizzato * 100) 
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${clientUrl}/index.html?success=true`,
            cancel_url: `${clientUrl}/index.html?canceled=true`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error("Errore Stripe:", error);
        res.status(500).json({ error: "Errore durante la creazione del pagamento." });
    }
});

// Front-end statico
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server attivo su porta ${PORT}`));