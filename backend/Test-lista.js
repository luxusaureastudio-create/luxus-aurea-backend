const { GoogleGenerativeAI } = require("@google/generative-ai");

async function listModels() {
    const genAI = new GoogleGenerativeAI("AIzaSyBB6aH4BIso5CfQLtiuv-2unCcZnLpOU4Y");
    
    try {
        // Proviamo a chiedere la lista dei modelli
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${genAI.apiKey}`);
        const data = await response.json();
        
        console.log("=== LISTA MODELLI DISPONIBILI ===");
        if (data.models) {
            data.models.forEach(m => {
                console.log(`- Modello: ${m.name} (Supporta: ${m.supportedGenerationMethods})`);
            });
        } else {
            console.log("Errore nella risposta:", data);
        }
    } catch (error) {
        console.error("Errore durante il recupero:", error);
    }
}

listModels();