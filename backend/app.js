require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const pdfLib = require('pdf-parse'); 
const { GoogleGenerativeAI } = require('@google/generative-ai');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
// Sostituisci app.use(cors()) con questo:
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// --------------------------------------------------------
// 1. MODELLI DATABASE
// --------------------------------------------------------
const Substance = mongoose.model('Substance', new mongoose.Schema({
    cas: { type: String, required: true, unique: true },
    nome: String,
    scl: { type: Number, default: 1.0 }
}));

const User = mongoose.model('User', new mongoose.Schema({
    companyName: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 10 },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    createdAt: { type: Date, default: Date.now }
}));

// --------------------------------------------------------
// 2. CONNESSIONE AL DATABASE
// --------------------------------------------------------
const mongoURI = process.env.MONGO_URI || "mongodb://localhost:27017/luxus_aurea";
mongoose.connect(mongoURI)
    .then(() => console.log("✅ Database MongoDB connesso con successo"))
    .catch(err => console.error("❌ Errore connessione DB:", err));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } 
});

// --------------------------------------------------------
// 3. MIDDLEWARE DI AUTENTICAZIONE
// --------------------------------------------------------
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ error: "Accesso negato. Token mancante." });
        }

        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        const user = await User.findById(decoded.id);
        if (!user) {
            return res.status(401).json({ error: "Utente non trovato." });
        }

        req.user = user;
        next(); 
    } catch (err) {
        res.status(401).json({ error: "Token non valido o scaduto." });
    }
};

// --------------------------------------------------------
// 4. ROTTE DI AUTENTICAZIONE
// --------------------------------------------------------

app.post('/api/register', async (req, res) => {
    try {
        const { companyName, email, password } = req.body;
        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) return res.status(400).json({ error: "Email già registrata." });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({
            companyName,
            email: email.toLowerCase(),
            password: hashedPassword
        });
        await newUser.save();
        res.status(201).json({ message: "Utente registrato con successo!" });
    } catch (error) {
        res.status(500).json({ error: "Errore durante la registrazione." });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(400).json({ error: "Credenziali errate." });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: "Credenziali errate." });

        const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ token, credits: user.credits, companyName: user.companyName });
    } catch (error) {
        res.status(500).json({ error: "Errore durante il login." });
    }
});

// INTEGRAZIONE: Rotta rapida per info utente e crediti
app.get('/api/user-info', verifyToken, async (req, res) => {
    res.json({ 
        email: req.user.email, 
        credits: req.user.credits, 
        companyName: req.user.companyName 
    });
});

// --------------------------------------------------------
// 5. ANALISI PDF E INTELLIGENZA ARTIFICIALE
// --------------------------------------------------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

app.post('/api/analyze-pdf', verifyToken, upload.single('sds_file'), async (req, res) => {
    try {
        if (req.user.credits < 1) return res.status(403).json({ error: "Crediti esauriti." });
        if (!req.file) return res.status(400).json({ error: "File SDS mancante" });

        const data = await pdfLib(req.file.buffer);
        const rawText = data.text || "";
// ... (codice precedente riga 140)
    if (rawText.trim().length < 100) { 
        return res.status(422).json({ error: "Il PDF sembra una scansione..." });
    }

    // --- AGGIUNTA: ESTRAZIONE SEZIONE 3 ---
    const startRegex = /(?:3\.)\s*(?:Composizione|Informazioni|Ingredients|Composition)/i;
    const endRegex = /(?:4\.)\s*(?:Misure|First|Primi|Aiuto|Measures)/i;
    let extractedText = rawText;
    const startIndex = rawText.search(startRegex);
    const endIndex = rawText.search(endRegex);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
        extractedText = rawText.substring(startIndex, endIndex);
    } else if (startIndex !== -1) {
        extractedText = rawText.substring(startIndex, startIndex + 2000);
    }
    // -------------------------------------

    // Ora modifichiamo il prompt per usare extractedText
    const prompt = `Analizza questa SDS (estratta dalla sezione 3) e restituisci ESCLUSIVAMENTE un oggetto JSON... SDS: ${extractedText.substring(0, 5000)}`;
    
    const result = await model.generateContent(prompt);
    // ... (continua con il resto del codice riga 147)
        const textResponse = result.response.text();
        
       // --- INIZIO BLOCCO PARSING ROBUSTO ---
        let sdsData;
        try {
            const cleanJson = textResponse.replace(/```json/g, "").replace(/```/g, "").trim();
            const jsonMatch = cleanJson.match(/\{[\s\S]*\}/);
            
            if (!jsonMatch) throw new Error("Formato JSON non trovato nella risposta");
            
            sdsData = JSON.parse(jsonMatch[0]);

            if (!sdsData.components || !Array.isArray(sdsData.components)) {
                throw new Error("Il JSON non contiene una lista di componenti valida.");
            }
        } catch (err) {
            console.error("ERRORE PARSING JSON:", err.message);
            return res.status(500).json({ error: "Errore di lettura dati IA. Il documento potrebbe non essere una SDS valida." });
        }
        // --- FINE BLOCCO PARSING ROBUSTO ---

        const enriched = await Promise.all(sdsData.components.map(async (comp) => {
            const dbSubstance = await Substance.findOne({ cas: comp.cas });
            const scl = dbSubstance ? dbSubstance.scl : 1.0;
            return { 
                ...comp, 
                scl, 
                official_name: dbSubstance ? dbSubstance.nome : comp.name,
                verified: !!dbSubstance 
            };
        }));

        sdsData.components = enriched;

        let sumH317 = 0;
        sdsData.components.forEach(c => {
            let maxVal = parseFloat(String(c.max).replace(',', '.').match(/[\d.]+/)) || 0;
            c.max = maxVal;
            if (c.h_statements && c.h_statements.some(h => h.includes("H317"))) {
                sumH317 += (maxVal / c.scl);
            }
        });

        sdsData.safety_sum = sumH317.toFixed(4);
        sdsData.is_safe = sumH317 <= 1;

        req.user.credits -= 1;
        await req.user.save();
        
        res.json({ ...sdsData, creditiResidui: req.user.credits });

    } catch (error) {
        res.status(500).json({ error: "Errore durante l'analisi: " + error.message });
    }
});

// --------------------------------------------------------
// 6. ROTTE CRUD SOSTANZE (PROTETTE)
// --------------------------------------------------------
app.get('/api/substances', async (req, res) => {
    const list = await Substance.find().sort({ nome: 1 });
    res.json(list);
});

app.post('/api/substances', verifyToken, async (req, res) => {
    try {
        const substance = new Substance(req.body);
        await substance.save();
        res.status(201).json(substance);
    } catch (err) { res.status(400).json({ error: "CAS già presente o dati errati" }); }
});

app.delete('/api/substances/:id', verifyToken, async (req, res) => {
    try {
        await Substance.findByIdAndDelete(req.params.id);
        res.json({ message: "Eliminata" });
    } catch (err) { res.status(500).json({ error: "Errore eliminazione" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server attivo su porta ${PORT}`));