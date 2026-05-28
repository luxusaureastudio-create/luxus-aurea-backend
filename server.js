require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

// 1. CORS deve essere il primo
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'] }));

// 2. EXPRESS.JSON deve essere subito dopo, PRIMA di qualsiasi rotta
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. Ora inizializza il resto (DB, Multer, ecc.)
const mongoose = require('mongoose');
// ... tutto il resto del codice ...// Cambia la riga 6 in:
const pdfParse = require('pdf-parse');

const { GoogleGenerativeAI } = require('@google/generative-ai');
const jwt = require('jsonwebtoken');
const path = require('path');
const bcrypt = require('bcrypt');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');

const app = express();
// Sostituisci la riga 14 del server.js con questa:
app.use(cors({
    origin: '*', // Per ora lasciamo '*' per testare, ma è meglio specificare l'URL del frontend
    methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
// --- INIZIALIZZAZIONI GLOBALI ---
// Sostituisci la parte di connessione DB con questa versione diagnostica:
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connesso a MongoDB"))
    .catch(err => {
        console.error("❌ ERRORE CRITICO DB:", err);
        process.exit(1); // Questo forza il log dell'errore su Render
    });
const upload = multer({ storage: multer.memoryStorage() });

if(process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY); 

// --- MODELLI ---
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

// --- MIDDLEWARE ---
const verifyToken = async (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Token mancante" });
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id);
        next();
    } catch (e) { res.status(401).json({ error: "Non autorizzato" }); }
};

// --- ROTTE API ---
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log("Tentativo di login per:", email); // Log interno su Render
        
        const user = await User.findOne({ email });
        if (!user) return res.status(401).json({ error: "Utente non trovato" });
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Credenziali errate" });
        
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token });
    } catch (error) {
        console.error("ERRORE LOGIN:", error); // Fondamentale per vedere cosa crasha
        res.status(500).json({ error: "Errore server: " + error.message });
    }
});

app.post('/api/register', async (req, res) => {
    const { companyName, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ companyName, email, password: hashedPassword });
    await newUser.save();
    res.status(201).json({ success: true });
});

app.post('/api/request-reset', async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utente non trovato" });
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    
    const msg = {
        to: email,
        from: 'luxusaureastudio@gmail.com',
        subject: 'Reset Password Luxus Aurea',
        text: `Link reset: https://safetydata-backend.onrender.com/reset.html?token=${token}`
    };
    try {
        await sgMail.send(msg);
        res.json({ success: true, message: "Email inviata!" });
    } catch (error) {
        res.status(500).json({ error: "Errore invio mail" });
    }
});

app.post('/api/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body;
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.findByIdAndUpdate(decoded.id, { password: hashedPassword });
        res.json({ success: true, message: "Password aggiornata!" });
    } catch (e) { res.status(400).json({ error: "Token non valido" }); }
});

app.get('/api/user-info', verifyToken, (req, res) => res.json({ credits: req.user.credits }));
app.get('/api/my-archive', verifyToken, async (req, res) => res.json(await Report.find({ userId: req.user._id })));

// Blocco Analisi PDF (Sostituisci il vecchio blocco con questo identico):
app.post('/api/analyze-pdf', verifyToken, upload.single('sds_file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Nessun file caricato" });
        
        // ESECUZIONE DIRETTA E SENZA FRONZOLI
        const pdfData = await pdfParse(req.file.buffer); 
        
        if (!pdfData.text || pdfData.text.length < 50) {
            return res.status(400).json({ error: "PDF non leggibile" });
        }

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(`Analizza: ${pdfData.text}. Estrai: nome, cas, concentrazione, clp. Solo JSON.`);
        
        const jsonText = result.response.text().replace(/```json|```/g, "").trim();
        res.json({ analysis: JSON.parse(jsonText) });
    } catch (error) {
        console.error("ERRORE CRITICO:", error);
        res.status(500).json({ error: "Errore interno server." });
    }
});

// --- FILE STATICI E PAGAMENTI ---
app.use(express.static(path.join(__dirname, 'frontend')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

app.post('/api/create-checkout', verifyToken, async (req, res) => {
    const { pacchetto, importoPersonalizzato } = req.body;
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'eur',
                    product_data: { name: `Pacchetto ${pacchetto}` },
                    unit_amount: Math.round(importoPersonalizzato * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: 'https://safetydata-backend.onrender.com/index.html?success=true',
            cancel_url: 'https://safetydata-backend.onrender.com/index.html?canceled=true',
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error("Errore Stripe:", error);
        res.status(500).json({ error: "Errore nel creare il pagamento" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server attivo sulla porta ${PORT}`));