require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const db = require('./db');
require('./mqtt'); // połączenie z brokerem i zapis danych z czujników (mqtt.js)
const { dbError, requireApiKey } = require('./lib/http');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_DIST = path.join(__dirname, 'frontend', 'dist');

app.use(cors());
app.use(express.json());

// Panel WWW (po `npm run build` w folderze frontend) pod tym samym adresem co API
if (fs.existsSync(FRONTEND_DIST)) {
    app.use(express.static(FRONTEND_DIST));
}

// ==========================================
// 1. ENDPOINTY API DLA FRONTENDU
// ==========================================

// Opcjonalny klucz API (gdy w .env ustawiono API_KEY)
app.use('/api', requireApiKey);

app.use('/api', require('./routes/devices')); // health, devices, state, readings, command, commands, events
app.use('/api', require('./routes/access')); // users, access-logs, access/signals
app.use('/api', require('./routes/energy')); // heatmeter/*, energy/daily

// Testowy endpoint główny (gdy panel nie jest zbudowany)
app.get('/', (req, res) => {
    res.json({ status: 'Backend działa poprawnie', timestamp: new Date() });
});

// Pobieranie pokoi
app.get('/api/rooms', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM rooms');
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania pokoi');
    }
});

// Pobieranie stanów oświetlenia
app.get('/api/lighting', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM lighting_states');
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania stanów oświetlenia');
    }
});

// Pobieranie automatyzacji
app.get('/api/automations', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM automations');
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania automatyzacji');
    }
});

// ==========================================
// 2. URUCHOMIENIE SERWERA
// ==========================================
app.listen(PORT, () => {
    console.log(`[BACKEND] Serwer działa pod adresem http://localhost:${PORT}`);
    if (fs.existsSync(FRONTEND_DIST)) console.log(`[BACKEND] Panel WWW: http://localhost:${PORT}`);
    if (process.env.API_KEY) console.log('[BACKEND] Klucz API włączony – zmiany wymagają nagłówka X-API-Key');
});
