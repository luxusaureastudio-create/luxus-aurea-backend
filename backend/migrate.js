const mongoose = require('mongoose');

// La tua nuova stringa del Cloud (Atlas)
const ATLAS_URI = "mongodb+srv://luxusaureastudio_db_user:MQU7bEyXAE9nJLpu@cluster0.moj9ile.mongodb.net/luxus_aurea?retryWrites=true&w=majority";

// La tua vecchia stringa locale (PC)
const LOCAL_URI = "mongodb://localhost:27017/luxus_aurea";

const substanceSchema = new mongoose.Schema({
    cas: String,
    nome: String,
    scl: Number
});

async function migrate() {
    try {
        console.log("--- 📦 Avvio Travaso Dati (PC -> Cloud) ---");

        // 1. Legge dal tuo PC
        const localConn = await mongoose.createConnection(LOCAL_URI).asPromise();
        const LocalSubstance = localConn.model('Substance', substanceSchema);
        const datiDalPC = await LocalSubstance.find({});
        console.log(`🔍 Ho trovato ${datiDalPC.length} sostanze sul tuo computer.`);

        if (datiDalPC.length === 0) {
            console.log("⚠️ Il database sul PC sembra vuoto. Controlla di aver inserito sostanze in precedenza!");
            process.exit(0);
        }

        // 2. Scrive su Atlas
        const atlasConn = await mongoose.createConnection(ATLAS_URI).asPromise();
        const AtlasSubstance = atlasConn.model('Substance', substanceSchema);

        console.log("🚀 Caricamento su MongoDB Atlas in corso...");
        await AtlasSubstance.deleteMany({}); // Evita doppioni pulendo Atlas
        await AtlasSubstance.insertMany(datiDalPC);

        console.log("✅ TRAVASO COMPLETATO! Ora i tuoi dati sono al sicuro online.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Errore durante il travaso:", err);
        process.exit(1);
    }
}

migrate();