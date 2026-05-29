require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); // Assicurati di averla definita
const sgMail = require('@sendgrid/mail');
const User = require('./models/User'); // Assicurati che il percorso sia corretto

sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const app = express();

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error("Webhook Error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        if (session.metadata.tipo_acquisto === 'pacchetto_app') {
            let creditiDaAggiungere = 0;
            const nomePacchetto = session.metadata.pacchetto;
            
            if (nomePacchetto === 'Discovery') creditiDaAggiungere = 5;
            else if (nomePacchetto === 'Stagionale') creditiDaAggiungere = 12;
            else if (nomePacchetto === 'PRO') creditiDaAggiungere = 25;

            // 1. Aggiorna i crediti nel database
            const user = await User.findByIdAndUpdate(
                session.metadata.userId, 
                { $inc: { credits: creditiDaAggiungere } },
                { new: true }
            );

            // 2. Invia Email con SendGrid
            if (user) {
                const msg = {
                    to: session.customer_details.email,
                    from: 'luxusaureastudio@gmail.com',
                    subject: 'Conferma acquisto crediti - Luxus Aurea',
                    text: `Ciao ${session.customer_details.name || 'Cliente'}, grazie per il tuo acquisto! Ti sono stati accreditati ${creditiDaAggiungere} crediti.`,
                    html: `<p>Ciao ${session.customer_details.name || 'Cliente'},</p>
                           <p>Grazie per il tuo acquisto su <strong>Luxus Aurea</strong>!</p>
                           <p>Ti sono stati accreditati <strong>${creditiDaAggiungere} crediti</strong> sul tuo account.</p>`
                };

                try {
                    await sgMail.send(msg);
                    console.log(`✅ Email inviata a: ${session.customer_details.email}`);
                } catch (err) {
                    console.error("❌ Errore invio email SendGrid:", err.response ? err.response.body : err.message);
                }
            }
            console.log(`✅ Aggiunti ${creditiDaAggiungere} crediti all'utente:`, session.metadata.userId);
        }
    }
    
    res.json({ received: true });
});
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const os = require('os');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require("@google/generative-ai/server");



// 2. CONFIGURAZIONI (SOLO UNA VOLTA!)
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'PUT', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// FORZIAMO LA CHIAVE NUOVA DIRETTAMENTE NEL CODICE
const MIA_CHIAVE = process.env.GEMINI_KEY;

const genAI = new GoogleGenerativeAI(MIA_CHIAVE);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const fileManager = new GoogleAIFileManager(MIA_CHIAVE);

// Configurazione Upload
const upload = multer({ storage: multer.memoryStorage() });

if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Connessione Database (Già gestita nel primo blocco, ma assicurati che sia unica)
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Connesso a MongoDB"))
    .catch(err => { console.error("❌ ERRORE CRITICO DB:", err); process.exit(1); });
// ==========================================
// MODELLI DATABASE
// ==========================================
const User = mongoose.model('User', new mongoose.Schema({
    companyName: String,
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 1 },
    resetPasswordToken: String,    // Aggiungi questo
    resetPasswordExpires: Date     // Aggiungi questo
}));

const Report = mongoose.model('Report', new mongoose.Schema({
    userId: mongoose.Schema.Types.ObjectId,
    nomeFragranza: String,
    esito: String,
    target: Number,
    analisiCompleta: Object
}));

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
        console.log("DEBUG UTENTE:", user);
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
              "concentrazione": 0.0,
              "clp": "CODICI H DI PERICOLO (separati da virgola, es. H317, H411)"
            }
          ]
        }`;

        // 4. Inviamo il Prompt collegando il file appena caricato
        const result = await model.generateContent([
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
        const analysisData = JSON.parse(jsonText);

        req.user.credits -= 1;
        await req.user.save();

        res.json({ analysis: analysisData, remainingCredits: req.user.credits });

    } catch (error) {
        console.error("ERRORE METODO FILE MANAGER:", error);
        // Pulizia sicura in caso di crash
        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        res.status(500).json({ error: "Errore durante l'elaborazione tramite Google AI." });
    }
});

// ==========================================
// ROTTE API - SALVATAGGIO, ARCHIVIO, ADMIN
// ==========================================
app.post('/api/save-report', verifyToken, async (req, res) => {
    try {
        const { nomeFragranza, esito, target, analisiCompleta } = req.body;
        if (!analisiCompleta) return res.status(400).json({ error: "Dati di analisi mancanti." });

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

app.get('/api/ifra-database', (req, res) => {
    const mockIfraDB = {
        "5989-27-5": { "cat12": 100 }, 
        "120-51-4": { "cat12": 100 }   
    };
    res.json(mockIfraDB);
});

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
        res.status(500).json({ error: "Errore salvataggio sostanza." });
    }
});

app.delete('/api/substances/:id', verifyToken, async (req, res) => {
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