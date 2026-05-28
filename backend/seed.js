require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');

// Assicurati che nel tuo .env ci sia il MONGO_URI di Atlas
const mongoURI = process.env.MONGO_URI;

const substanceSchema = new mongoose.Schema({
    cas: { type: String, required: true, unique: true },
    nome: String,
    scl: Number
});

const Substance = mongoose.model('Substance', substanceSchema);

async function seedDatabase() {
    try {
        if (!mongoURI) throw new Error("Manca il MONGO_URI nel file .env");

        console.log("Connessione a MongoDB in corso...");
        await mongoose.connect(mongoURI);
        console.log("✅ Connesso a MongoDB Atlas.");

        // Leggi il file locale substances.json
        const rawData = fs.readFileSync('substances.json', 'utf8');
        const jsonData = JSON.parse(rawData);

        // Trasforma l'oggetto JSON in un array di oggetti per MongoDB
        const arraySostanze = Object.keys(jsonData).map(casKey => {
            return {
                cas: casKey,
                nome: jsonData[casKey].nome,
                scl: jsonData[casKey].scl
            };
        });

        console.log(`Trovate ${arraySostanze.length} sostanze da caricare.`);

        // Svuota la collezione esistente per evitare doppioni
        await Substance.deleteMany({});
        console.log("Pulizia database effettuata.");

        // Inserisce i nuovi dati
        await Substance.insertMany(arraySostanze);
        console.log("✅ Database popolato con successo con le tue sostanze!");

    } catch (error) {
        console.error("❌ Errore durante il caricamento:", error);
    } finally {
        // Chiude la connessione al termine
        mongoose.connection.close();
        process.exit(0);
    }
}

seedDatabase();