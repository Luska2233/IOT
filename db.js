require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'zigbee_smarthome',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Kolumny DATE (np. users.valid_until) jako tekst 'RRRR-MM-DD' – w takiej postaci oczekuje ich panel
    dateStrings: ['DATE']
});

module.exports = pool;
