require('dotenv').config();
const fetch = require('node-fetch'); // Se ti dà errore, usa: const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

async function guardaCosaVedeLaMiaChiave() {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_KEY}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.models) {
            console.log("✅ I modelli che la tua chiave PUÒ usare sono:");
            data.models.forEach(m => console.log("- " + m.name.replace('models/', '')));
        } else {
            console.log("❌ Errore:", data.error.message);
        }
    } catch (e) { console.log("Errore di rete:", e.message); }
}
guardaCosaVedeLaMiaChiave();