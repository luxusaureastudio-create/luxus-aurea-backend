const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// La tua stringa Atlas (stessa di migrate.js)
const ATLAS_URI = "mongodb://luxusaureastudio_db_user:LuxusAurea2026@ac-tifiyf6-shard-00-00.moj9i1e.mongodb.net:27017,ac-tifiyf6-shard-00-01.moj9i1e.mongodb.net:27017,ac-tifiyf6-shard-00-02.moj9i1e.mongodb.net:27017/luxus_aurea?ssl=true&replicaSet=atlas-ns2m0l-shard-0&authSource=admin&appName=Cluster0";
const substanceSchema = new mongoose.Schema({
    cas: String,
    nome: String,
    scl: Number,
    ifraCat12: Number
});

async function migrateIfra() {
    try {
        console.log("--- 📦 Caricamento limiti IFRA reali nel database ---");

        // Legge il file substances.json (quello aggiornato oggi, dentro frontend)
        const filePath = path.join(__dirname, 'frontend', 'substances.json');
        const raw = fs.readFileSync(filePath, 'utf-8');
        const sostanze = JSON.parse(raw);

        const conn = await mongoose.createConnection(ATLAS_URI).asPromise();
        const Substance = conn.model('Substance', substanceSchema);

        let aggiornate = 0;
        let create = 0;

        for (const cas in sostanze) {
            const info = sostanze[cas];
            const risultato = await Substance.findOneAndUpdate(
                { cas: cas },
                { $set: { nome: info.nome, ifraCat12: info.cat12 } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            if (risultato) {
                aggiornate++;
            }
        }

        console.log(`✅ Completato! ${aggiornate} sostanze aggiornate/create nel database.`);
        process.exit(0);
    } catch (err) {
        console.error("❌ Errore durante il caricamento:", err);
        process.exit(1);
    }
}

migrateIfra();