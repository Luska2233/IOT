// ==========================================
// Wspólne funkcje pomocnicze dla tras HTTP
// ==========================================
const crypto = require('crypto');

const SCHEMA_HINT = 'zob. baza/schema.sql i baza/README.md';
const DB_DOWN_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR'];

// Czytelny opis błędu do logów (błędy połączenia w Node bywają typu AggregateError z pustym `message`).
function describeError(error) {
    const text = error.sqlMessage || error.message || error.errors?.[0]?.message || '';
    return [error.code, text].filter(Boolean).join(' ') || String(error);
}

// Zamienia błąd bazy na czytelną odpowiedź 500 (panel wyświetla pole `error`).
function dbError(res, error, message) {
    console.error(`[API] ${message}:`, describeError(error));
    let detail = '';
    if (error.code === 'ER_NO_SUCH_TABLE') {
        const table = /Table '([^']+)'/.exec(error.sqlMessage || '')?.[1] ?? '?';
        detail = ` – w bazie brakuje tabeli ${table} (${SCHEMA_HINT})`;
    } else if (error.code === 'ER_BAD_FIELD_ERROR') {
        detail = ` – w bazie brakuje kolumny: ${error.sqlMessage} (${SCHEMA_HINT})`;
    } else if (DB_DOWN_CODES.includes(error.code)) {
        detail = ' – brak połączenia z bazą MySQL (sprawdź .env i czy serwer bazy działa)';
    }
    res.status(500).json({ error: message + detail });
}

function parseDate(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
}

// Zakres dat z ?from=&to= (ISO 8601). Domyślnie ostatnie `defaultDays` dni.
// Bez `to` górna granica ma minutę zapasu – zegar bazy potrafi wyprzedzać zegar Node o kilka ms,
// a wtedy zapis sprzed chwili nie łapałby się w „do teraz”.
function parseRange(query, defaultDays = 7) {
    const now = Date.now();
    const to = parseDate(query.to) ?? new Date(now + 60e3);
    const from = parseDate(query.from) ?? new Date(now - defaultDays * 24 * 3600e3);
    return { from, to };
}

function parseLimit(value, defaultLimit, maxLimit) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, maxLimit) : defaultLimit;
}

// Liczba z kolumny DECIMAL / SUM (mysql2 zwraca je jako tekst) albo null.
function num(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, digits = 3) {
    return value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;
}

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Odczyty z danymi osobowymi, które też wymagają klucza.
const PROTECTED_READS = ['/users', '/access-logs'];

// Opcjonalny klucz API: działa tylko, gdy w .env ustawiono API_KEY.
// Wymagany dla zmian (POST/PUT/DELETE) i odczytu danych osobowych; nagłówek X-API-Key.
function requireApiKey(req, res, next) {
    const key = process.env.API_KEY;
    if (!key) return next();
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    if (isRead && !PROTECTED_READS.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    if (safeEqual(req.get('X-API-Key') || '', key)) return next();
    res.status(401).json({ error: 'Wymagany klucz API – wpisz go w panelu: Ustawienia → Połączenie z backendem' });
}

module.exports = { describeError, dbError, parseRange, parseLimit, num, round, requireApiKey };
