// MODIFICA QUESTA RIGA:cd backend
const BASE_URL = "https://safetydata-backend.onrender.com";
let globalAnalysisData = null;

// --- AGGIORNAMENTO CREDITI ---
async function aggiornaCrediti() {
    const token = localStorage.getItem('luxusToken');
    const creditsSpan = document.getElementById('userCredits');
    if (!token || !creditsSpan) return;
    try {
        const res = await fetch(`${BASE_URL}/api/user-info`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('luxusToken')}` }
        });
        const data = await res.json();
        if (data.credits !== undefined) {
            creditsSpan.innerText = data.credits;
        }
    } catch (err) { 
        console.error("Errore crediti:", err); 
    }
}

// --- LOGICA PITTOGRAMMI GHS (CLP Compliance) ---
function generaIconeGHS(listaH) {
    let html = "";
    const hasGHS05 = listaH.some(h => h === 'H314' || h === 'H318');
    const hasGHS07 = listaH.some(h => ['H317', 'H319', 'H302', 'H315'].includes(h));
    const hasGHS08 = listaH.some(h => h.startsWith('H34') || h.startsWith('H35') || h.startsWith('H36'));
    // GHS09 scatta solo per i pericoli ambientali gravi: H400, H410, H411 (L'H412 regolamentare NON ha icona)
    const hasGHS09 = listaH.some(h => ['H400', 'H410', 'H411'].includes(h));

    if (hasGHS05) html += `<div style="text-align:center;"><img src="ghs05.png" style="height:60px;"><br><small style="font-size:8px;">GHS05</small></div>`;
    if (hasGHS07) html += `<div style="text-align:center;"><img src="ghs07.png" style="height:60px;"><br><small style="font-size:8px;">GHS07</small></div>`;
    if (hasGHS08) html += `<div style="text-align:center;"><img src="ghs08.png" style="height:60px;"><br><small style="font-size:8px;">GHS08</small></div>`;
    if (hasGHS09) html += `<div style="text-align:center;"><img src="ghs09.png" style="height:60px;"><br><small style="font-size:8px;">GHS09</small></div>`;
    return html;
}

// --- UPLOAD E ANALISI IA ---
async function uploadPDF() {
    const fileInput = document.getElementById('pdfUpload');
    const btn = document.getElementById('uploadBtn');
    const token = localStorage.getItem('luxusToken');

    if (!fileInput.files[0]) return alert("Seleziona un file PDF.");

    btn.innerText = "ANALISI IN CORSO... ⏳";
    btn.disabled = true;

    const formData = new FormData();
    formData.append('sds_file', fileInput.files[0]);

    try {
        const response = await fetch(`${BASE_URL}/api/analyze-pdf`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });
        const data = await response.json();
        
        if (response.ok) {
            let sostanzeTrovate = Array.isArray(data.analysis) ? data.analysis : (data.analysis?.components || []);
            globalAnalysisData = { analysis: sostanzeTrovate };
            
            alert("✅ Analisi IA completata con successo!");
            
            const preflight = document.getElementById('preflight');
            const listDiv = document.getElementById('preflightList');
            
            if(preflight && listDiv) {
                preflight.style.display = 'block';
                listDiv.innerHTML = sostanzeTrovate.map(s => `
                    <div style="padding:10px; border-bottom:1px solid #eee;">
                        <strong>${(s.nome || "Sconosciuto").toUpperCase()}</strong> (CAS: ${s.cas || "N/D"}) - <span style="color:#b59a5b;">${s.concentrazione || 0}%</span>
                    </div>`).join('');
            }
            
            document.getElementById('analyzeBtn').disabled = false;
            aggiornaCrediti();
        } else {
            alert("Errore: " + data.error);
        }
    } catch (error) {
        alert("Errore di connessione al server.");
    } finally {
        btn.innerText = "ANALIZZA PDF CON IA";
        btn.disabled = false;
    }
}

// --- CALCOLO CONFORMITÀ E REPORT FINALE ---
async function runAnalysis() {
    if (!globalAnalysisData) return alert("Devi prima completare l'analisi del PDF!");

    let limitiIFRA = {};
    try {
       const res = await fetch(`${BASE_URL}/api/ifra-database`);
       limitiIFRA = await res.json();
    } catch (e) { console.error("Errore IFRA DB"); }

    const resultsDiv = document.getElementById('results');
    const sostanze = globalAnalysisData.analysis || [];
    const targetUso = parseFloat(document.getElementById('targetPerc').value) || 10;
    const prezzoFragranza = parseFloat(document.getElementById('priceKg').value) || 0;
    const costoFinale = (prezzoFragranza * targetUso) / 100;

    let isSafe = true;
    let allergeniEtichetta = [];
    let labelsGrafico = [];
    let datiGrafico = [];

    let sumH318 = 0, sumH315 = 0, sumH319 = 0, sumH400 = 0, sumH410 = 0, sumH411 = 0, sumH412 = 0;
    let hasSensitizer = false, hasRepro = false;
    let containsEndocrine = false;
    
    // Flag precauzionale per gli agrumi (Limonene / Menta Arancio)
    let forzaH412Precauzione = false;

    sostanze.forEach(s => {
        const concProdotto = (s.concentrazione * targetUso) / 100;
        const nomeUpper = String(s.nome).toUpperCase();
        labelsGrafico.push(s.nome);
        datiGrafico.push(concProdotto);

        // Controllo automatico preventivo per essenze agrumate pesanti
        if ((nomeUpper.includes("MENTA") || nomeUpper.includes("DIENE") || nomeUpper.includes("LIMONENE") || s.cas === "5989-27-5") && concProdotto >= 1.5) {
            forzaH412Precauzione = true;
        }

        if (limitiIFRA[s.cas]) {
            const categoria = document.getElementById('ifraCategory').value;
            if (concProdotto > limitiIFRA[s.cas][categoria]) isSafe = false;
        }

        if (s.clp) {
            const codiciH = String(s.clp).toUpperCase().match(/H\d{3}[A-Z]?|EUH\d{3}/g) || [];
            codiciH.forEach(h => {
                if(h === 'H318') sumH318 += concProdotto;
                if(h === 'H315') sumH315 += concProdotto;
                if(h === 'H319') sumH319 += concProdotto;
                if(h === 'H400') sumH400 += concProdotto;
                if(h === 'H410') sumH410 += concProdotto;
                if(h === 'H411') sumH411 += concProdotto;
                if(h === 'H412') sumH412 += concProdotto;
                if(h === 'H317' && concProdotto >= 0.1) {
                    hasSensitizer = true;
                    if (!allergeniEtichetta.includes(s.nome)) allergeniEtichetta.push(s.nome);
                }
                if(h === 'H360' && concProdotto >= 0.3) hasRepro = true;
                if(h === 'EUH380' || h === 'EUH440') containsEndocrine = true;
            });
        }
    });

    let codiciMiscela = new Set();
    if (sumH318 >= 3.0) codiciMiscela.add('H318');
    else if (sumH318 >= 1.0 || sumH319 >= 10.0 || (sumH318 + sumH319) >= 10.0) codiciMiscela.add('H319');
    if (sumH315 >= 10.0) codiciMiscela.add('H315');
    if (hasSensitizer) codiciMiscela.add('H317');
    if (hasRepro) codiciMiscela.add('H360');
    
    // Metodo additivo CLP per l'ambiente + clausola di salvaguardia agrumi
    if (sumH410 >= 25.0) codiciMiscela.add('H410');
    else if ((sumH411 + 10*sumH410) >= 25.0) codiciMiscela.add('H411');
    else if ((sumH412 + 10*sumH411 + 100*sumH410) >= 25.0 || forzaH412Precauzione) {
        codiciMiscela.add('H412');
    }

    const listaH_finali = Array.from(codiciMiscela).sort();
    let scattaUFI = listaH_finali.some(h => h.startsWith('H3') || h.startsWith('H2'));
    let pittogrammiHTML = generaIconeGHS(listaH_finali);

    let frasiEtichetta = [];
    if (allergeniEtichetta.length > 0) frasiEtichetta.push(`<strong>CONTIENE:</strong> ${allergeniEtichetta.join(', ')}.<br><span style="font-size:10px; font-style:italic;">Può provocare una reazione allergica.</span>`);
    if (listaH_finali.includes('H360')) frasiEtichetta.push(`<strong style="color:#b91c1c;">⚠️ H360:</strong> Può nuocere alla fertilità o al feto.`);
    if (containsEndocrine) frasiEtichetta.push(`<strong style="color:#b91c1c;">⚠️ CONTIENE INTERFERENTI ENDOCRINI (Reg. 2023/707)</strong>`);

    const colori = ['#b59a5b', '#1e293b', '#475569', '#94a3b8', '#cbd5e1', '#e2e8f0'];

    resultsDiv.innerHTML = `
        <div style="background:white; padding:40px; border:1.5px solid #000; font-family:Arial; margin-top:30px; color:#1e293b;">
            <h2 style="text-align:center; text-transform:uppercase; margin-bottom:20px;">Report Tecnico di Conformità</h2>
            ${containsEndocrine ? `<div style="padding:15px; border:2px solid #b91c1c; text-align:center; margin-bottom:20px; background:#fef2f2; color:#b91c1c;"><strong>🚨 ALLERTA XXII ATP: INTERFERENTE ENDOCRINO 🚨</strong></div>` : ''}
            <div style="padding:15px; border:1px solid #000; text-align:center; margin-bottom:30px; background:${scattaUFI ? '#fef2f2' : '#fff'};"><strong style="font-size:13px; color:${scattaUFI ? '#b91c1c' : '#1e293b'}">${scattaUFI ? '⚠️ OBBLIGO NOTIFICA PCN / UFI' : 'NOTIFICA NON RICHIESTA'}</strong></div>
            <div style="display:flex; justify-content:space-between; margin-bottom:30px; font-weight:bold; border-bottom:1px solid #eee; padding-bottom:15px;">
                <span>ESITO IFRA: <b style="color:${isSafe ? 'green' : 'red'};">${isSafe ? 'CONFORME' : 'NON CONFORME'}</b></span>
                <span>COSTO: € ${costoFinale.toFixed(2)} / kg</span>
            </div>
            <div style="display:grid; grid-template-columns: 1fr 1.3fr; gap:40px;">
                <div><canvas id="chartPie" style="max-height:160px;"></canvas><div id="legendaColori" style="margin-top:20px; font-size:10px;"></div></div>
                <div style="border:1.5px solid #000; padding:15px;">
                    <h4 style="text-align:center; font-size:11px; margin-top:0;">CLP REG. 1272/2008</h4>
                    <div style="display:flex; justify-content:center; gap:10px; margin:15px 0;">${pittogrammiHTML || '<span style="font-size:10px;">Nessun Pittogramma Richiesto</span>'}</div>
                    <div style="color:#b91c1c; font-weight:bold; text-align:center; font-size:12px; margin-bottom:10px;">${listaH_finali.join(', ') || 'NESSUN PERICOLO CLASSIFICATO'}</div>
                    <div style="font-size:10px; border-top:1px solid #000; padding-top:10px;">${frasiEtichetta.join('<br><br>')}</div>
                </div>
            </div>
            <div style="text-align:center; margin-top:30px;"><button onclick="salvaInArchivio()" style="background:#1e293b; color:white; padding:10px 20px; border:none; cursor:pointer; border-radius:8px;">SALVA IN ARCHIVIO</button></div>
        </div>
    `;

    const legDiv = document.getElementById('legendaColori');
    legDiv.innerHTML = labelsGrafico.slice(0,8).map((l, i) => `<div><span style="color:${colori[i % 6]}">■</span> ${l} (${datiGrafico[i].toFixed(2)}%)</div>`).join('');
    
    if (window.myPieChart) window.myPieChart.destroy();
    const ctx = document.getElementById('chartPie').getContext('2d');
    window.myPieChart = new Chart(ctx, { type: 'doughnut', data: { labels: labelsGrafico, datasets: [{ data: datiGrafico, backgroundColor: colori }] }, options: { cutout: '70%', plugins: { legend: { display: false } } } });
    resultsDiv.scrollIntoView({ behavior: 'smooth' });
}

// --- SALVATAGGIO IN ARCHIVIO ---
async function salvaInArchivio() {
    if (!globalAnalysisData) return alert("Nessun dato da salvare!");

    const inputNome = document.getElementById('fragName');
    const nomeFinale = (inputNome && inputNome.value.trim() !== "") ? inputNome.value.toUpperCase() : "SENZA NOME";
    
    const target = parseFloat(document.getElementById('targetPerc').value) || 10;
    let esitoFinale = document.getElementById('results').innerText.includes("NON CONFORME") ? "NON CONFORME" : "CONFORME";

    const reportData = {
        nomeFragranza: nomeFinale,
        esito: esitoFinale,
        target: target,
        analisiCompleta: globalAnalysisData
    };

    try {
        const token = localStorage.getItem('luxusToken');
        const res = await fetch(`${BASE_URL}/api/save-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(reportData)
        });

        if (res.ok) {
            alert(`✅ Report "${nomeFinale}" salvato con successo!`);
            caricaArchivioDalServer();
        } else {
            alert("Errore durante il salvataggio.");
        }
    } catch (error) {
        console.error(error);
        alert("Errore di connessione.");
    }
}

async function caricaArchivioDalServer() {
    const token = localStorage.getItem('luxusToken');
    const historyList = document.getElementById('historyList');
    if (!token || !historyList) return;
    try {
        const res = await fetch(`${BASE_URL}/api/my-archive`, { headers: { 'Authorization': `Bearer ${token}` } });
        const reports = await res.json();
        historyList.innerHTML = reports.length === 0 ? '<p>Nessun report.</p>' : reports.map(r => `
            <div style="padding:10px; border-bottom:1px solid #eee; cursor:pointer;" onclick='ripristinaDaArchivio(${JSON.stringify(r.analisiCompleta)})'>
                <strong>${r.nomeFragranza}</strong><br><small>${r.esito} (${r.target}%)</small>
            </div>`).join('');
    } catch (err) { console.error(err); }
}

async function svuotaArchivio() {
    if (!confirm("Svuotare l'archivio?")) return;
    const token = localStorage.getItem('luxusToken');
    try {
        const res = await fetch(`${BASE_URL}/api/svuota-archivio`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) { caricaArchivioDalServer(); alert("Archivio svuotato!"); }
    } catch (err) { console.error(err); }
}

function ripristinaDaArchivio(dati) { 
    globalAnalysisData = dati; 
    runAnalysis(); 
}

document.addEventListener('DOMContentLoaded', () => { 
    aggiornaCrediti(); 
    caricaArchivioDalServer(); 
});

function logout() { 
    localStorage.removeItem('luxusToken'); 
    window.location.href = 'login.html'; 
}

async function acquistaPacchetto(tipoPacchetto, prezzoScelto) {
    const token = localStorage.getItem('luxusToken');
    if (!token) return alert("Fai il login per acquistare.");
    const bodyPayload = { pacchetto: tipoPacchetto.toUpperCase(), importoPersonalizzato: prezzoScelto };
    try {
        const response = await fetch(`${BASE_URL}/api/create-checkout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyPayload)
        });
        const data = await response.json();
        if (response.ok && data.url) window.location.href = data.url; 
        else alert("Errore pagamento.");
    } catch (err) { alert("Errore di connessione."); }
}