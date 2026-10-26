// ==========================================
// Tworzenie bazy: wykonuje baza/schema.sql i baza/dane_startowe.sql
// Użycie: npm run db:init            (schemat + dane startowe)
//         npm run db:init -- --bez-danych
// Dane logowania z pliku .env (DB_HOST, DB_USER, DB_PASSWORD). Nazwa bazy: zigbee_smarthome.
// ==========================================
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const files = ['schema.sql'];
if (!process.argv.includes('--bez-danych')) files.push('dane_startowe.sql');

(async () => {
    if (process.env.DB_NAME && process.env.DB_NAME !== 'zigbee_smarthome') {
        console.warn(`[BAZA] Uwaga: DB_NAME w .env to „${process.env.DB_NAME}”, a skrypt tworzy bazę zigbee_smarthome.`);
    }
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        multipleStatements: true
    });
    try {
        for (const file of files) {
            await connection.query(fs.readFileSync(path.join(__dirname, file), 'utf8'));
            console.log(`[BAZA] Wykonano ${file}`);
        }
        const [tables] = await connection.query('SHOW TABLES FROM zigbee_smarthome');
        console.log(`[BAZA] Gotowe – tabel w zigbee_smarthome: ${tables.length}`);
    } finally {
        await connection.end();
    }
})().catch((error) => {
    console.error('[BAZA] Błąd:', error.code || '', error.sqlMessage || error.message);
    process.exit(1);
});
