require('dotenv').config();
const fetch = require('node-fetch');
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

// Inizializzazione corretta per il tuo progetto
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
// Assicuriamoci che il modello sia istanziato correttamente
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash" 
});

// Modelli
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

// Middleware Autenticazione
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: "Token mancante" });
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        next();
    } catch (e) { res.status(401).json({ error: "Non autorizzato" }); }
};

// Rotte API
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: "Utente non trovato" });
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Credenziali errate" });
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' }); // ✅ 24h invece di 1h
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

// ✅ Analisi PDF — CORRETTA
app.post('/api/analyze-pdf', verifyToken, upload.single('sds_file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "File mancante" });
        
        // Convertiamo il file in testo semplice tramite un trucco (senza librerie)
        const pdfText = req.file.buffer.toString('latin1').substring(0, 5000);

        // Chiamata diretta all'API di Google (senza usare l'SDK problematico)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: "Analizza: " + pdfText + ". Rispondi solo in JSON." }] }]
            })
        });

        const data = await response.json();
        
        if (!data.candidates) {
            throw new Error("Risposta API invalida: " + JSON.stringify(data));
        }

        const jsonText = data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        res.json({ analysis: JSON.parse(jsonText) });

    } catch (error) {
        console.error("ERRORE FINALE:", error);
        res.status(500).json({ error: "Errore durante l'analisi." });
    }
});
// E usa questo metodo di generazione:
const result = await model.generateContent([
    "Analizza questo testo e rispondi solo in JSON: " + pdfContent.substring(0, 10000)
]);;
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'frontend', 'index.html')));

app.post('/api/create-checkout', verifyToken, async (req, res) => {
    try {
        const { pacchetto, importoPersonalizzato } = req.body;
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: { currency: 'eur', product_data: { name: `Pacchetto ${pacchetto}` }, unit_amount: Math.round(importoPersonalizzato * 100) },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'https://safetydata-backend.onrender.com/index.html?success=true',
            cancel_url: 'https://safetydata-backend.onrender.com/index.html?canceled=true',
        });
        res.json({ url: session.url });
    } catch (error) {
        res.status(500).json({ error: "Errore Stripe" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server attivo su porta ${PORT}`));