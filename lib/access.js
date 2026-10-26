// ==========================================
// Kontrola dostępu: reguła decyzji, identyfikatory (karty, PIN-y), sygnalizacja
// Model bazy: users + access_credentials + access_logs (baza/schema.sql).
// Reguła jest taka sama jak w panelu (frontend/src/lib/access.js → evaluateAccess),
// dodatkowo sprawdza aktywność i ważność samego identyfikatora.
// ==========================================
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('../db');

const scrypt = promisify(crypto.scrypt);

const ROLES = ['admin', 'employee', 'service', 'guest'];
// Role w panelu ↔ role w tabeli users
const ROLE_TO_DB = { admin: 'ADMIN', employee: 'USER', service: 'SERVICE', guest: 'GUEST' };
const ROLE_FROM_DB = { ADMIN: 'admin', USER: 'employee', SERVICE: 'service', GUEST: 'guest' };

const ZONES = { main: 'Wejście główne', r101: 'Sala 101', office: 'Biuro 102', server: 'Serwerownia', tech: 'Węzeł cieplny' };
const RESULTS = ['granted', 'denied', 'unknown_card', 'outside_hours', 'blocked'];
const BUZZER = ['none', 'short', 'double', 'long'];

// Metoda w panelu ↔ access_logs.auth_method
const METHOD_TO_DB = { rfid: 'RFID', pin: 'PIN', rfid_pin: 'RFID_AND_PIN' };
const METHOD_FROM_DB = { RFID: 'rfid', PIN: 'pin', RFID_AND_PIN: 'rfid_pin' };

// Powód odmowy w bazie (access_logs.denial_reason) → wynik pokazywany w panelu i na czytniku
const DENIAL_TO_RESULT = {
    NONE: 'granted',
    UNKNOWN_CREDENTIAL: 'unknown_card',
    EXPIRED: 'blocked',
    INACTIVE_USER: 'blocked',
    WRONG_PIN: 'denied',
    ZONE_NOT_ALLOWED: 'denied',
    OUTSIDE_SCHEDULE: 'outside_hours'
};
const RESULT_TO_DENIALS = {
    granted: ['NONE'],
    unknown_card: ['UNKNOWN_CREDENTIAL'],
    blocked: ['EXPIRED', 'INACTIVE_USER'],
    denied: ['WRONG_PIN', 'ZONE_NOT_ALLOWED'],
    outside_hours: ['OUTSIDE_SCHEDULE']
};

const DEFAULT_SIGNALS = {
    granted: { color: '#22c55e', message: 'Dostęp przyznany. Witaj, {imie}!', duration_s: 3, buzzer: 'short' },
    denied: { color: '#ef4444', message: 'Odmowa dostępu', duration_s: 4, buzzer: 'long' },
    unknown_card: { color: '#f59e0b', message: 'Nieznana karta – zgłoś się do recepcji', duration_s: 4, buzzer: 'double' },
    outside_hours: { color: '#8b5cf6', message: 'Poza godzinami dostępu', duration_s: 4, buzzer: 'double' },
    blocked: { color: '#64748b', message: 'Konto zablokowane – skontaktuj się z administratorem', duration_s: 5, buzzer: 'long' }
};

const UID_RE = /^([0-9A-F]{2}[:\- ]?){3,9}[0-9A-F]{2}$/i;
const PIN_RE = /^\d{4,8}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeUid(uid) {
    if (!uid) return null;
    const hex = String(uid).replace(/[^0-9a-f]/gi, '').toUpperCase();
    return hex.match(/.{1,2}/g)?.join(':') ?? null;
}

function hhmm(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Decyzja dostępu → powód odmowy w formacie bazy ('NONE' = dostęp przyznany).
// user: { active, zones, schedule }, credential: { is_active, valid_from, valid_until }
function decideAccess({ user, credential, zone = 'main', at = new Date() }) {
    if (!user || !credential) return 'UNKNOWN_CREDENTIAL';
    if (!user.active || !credential.is_active) return 'INACTIVE_USER';
    if ((credential.valid_from && new Date(credential.valid_from) > at) || (credential.valid_until && new Date(credential.valid_until) < at)) {
        return 'EXPIRED';
    }
    if (!(user.zones || []).includes(zone)) return 'ZONE_NOT_ALLOWED';
    const s = user.schedule;
    if (s) {
        const now = hhmm(at);
        if (!(s.days || []).includes(at.getDay()) || now < s.from || now > s.to) return 'OUTSIDE_SCHEDULE';
    }
    return 'NONE';
}

// Opis do dziennika dostępu.
function denialMessage(reason, zone) {
    switch (reason) {
        case 'NONE': return 'Dostęp przyznany';
        case 'UNKNOWN_CREDENTIAL': return 'Nieznana karta';
        case 'EXPIRED': return 'Uprawnienia wygasły';
        case 'INACTIVE_USER': return 'Konto zablokowane';
        case 'WRONG_PIN': return 'Błędny kod PIN';
        case 'ZONE_NOT_ALLOWED': return `Brak uprawnień do strefy: ${ZONES[zone] || zone || '?'}`;
        case 'OUTSIDE_SCHEDULE': return 'Poza godzinami dostępu';
        default: return reason;
    }
}

function fillTemplate(message, user) {
    const first = user?.name ? user.name.split(' ')[0] : '';
    return String(message || '').replaceAll('{imie}', first).replaceAll('{imię}', first);
}

// ---------- PIN: w bazie tylko skrót scrypt (sól + skrót), nigdy sam PIN ----------
const SCRYPT_N = 4096;

async function hashPin(pin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(String(pin), salt, 32, { N: SCRYPT_N });
    return `scrypt$${SCRYPT_N}$${salt}$${hash.toString('hex')}`;
}

async function verifyPin(pin, stored) {
    if (typeof stored !== 'string') return false;
    const [algo, n, salt, hash] = stored.split('$');
    if (algo !== 'scrypt' || !salt || !hash) return false;
    const calc = await scrypt(String(pin), salt, 32, { N: Number(n) || SCRYPT_N });
    const expected = Buffer.from(hash, 'hex');
    return expected.length === calc.length && crypto.timingSafeEqual(calc, expected);
}

// ---------- Użytkownicy ----------
function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

// Data → 'RRRR-MM-DD' (tak oczekuje panel).
function toDayString(value) {
    if (!value) return null;
    if (value instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
    }
    return String(value).slice(0, 10);
}

// Wiersz users + jego identyfikatory → obiekt dla panelu (bez skrótów PIN).
// „Ważne do” w panelu = najwcześniejsze valid_until identyfikatorów osoby.
function userToJson(row, credentials = []) {
    const own = credentials.filter((c) => c.user_id === row.user_id);
    const cards = own.filter((c) => c.credential_type === 'RFID_TAG');
    const card = cards.find((c) => c.is_active) || cards[0];
    const validUntil = own
        .map((c) => c.valid_until)
        .filter(Boolean)
        .sort((a, b) => new Date(a) - new Date(b))[0];
    return {
        user_id: row.user_id,
        name: row.full_name,
        email: row.email ?? null,
        username: row.username ?? null,
        role: ROLE_FROM_DB[row.role] ?? 'employee',
        card_uid: card?.rfid_uid ?? null,
        has_pin: own.some((c) => c.credential_type === 'PIN_CODE'),
        zones: parseJson(row.access_zones, []),
        schedule: parseJson(row.access_schedule, null),
        valid_until: toDayString(validUntil),
        active: Boolean(row.is_active),
        created_at: row.created_at ?? null
    };
}

// Lista użytkowników (albo jeden – userId) razem z identyfikatorami.
async function loadUsers(userId = null) {
    const [rows] = userId
        ? await db.query('SELECT * FROM users WHERE user_id = ?', [userId])
        : await db.query('SELECT * FROM users ORDER BY full_name');
    if (!rows.length) return [];
    const [credentials] = userId
        ? await db.query('SELECT * FROM access_credentials WHERE user_id = ?', [userId])
        : await db.query('SELECT * FROM access_credentials');
    return rows.map((row) => userToJson(row, credentials));
}

// Walidacja danych z formularza panelu. `existing` – edytowany użytkownik (przy PUT).
function validateUser(body, existing = null) {
    const b = body || {};
    const errors = [];
    const data = {
        name: typeof b.name === 'string' ? b.name.trim() : '',
        email: typeof b.email === 'string' && b.email.trim() ? b.email.trim() : null,
        role: b.role,
        card_uid: b.card_uid ? normalizeUid(b.card_uid) : null,
        pin: b.pin ? String(b.pin) : null,
        zones: Array.isArray(b.zones) ? [...new Set(b.zones)] : [],
        schedule: b.schedule,
        valid_until: b.valid_until || null,
        active: b.active === undefined ? true : Boolean(b.active)
    };

    if (data.name.length < 3) errors.push('Podaj imię i nazwisko (min. 3 znaki).');
    if (data.name.length > 100) errors.push('Imię i nazwisko do 100 znaków.');
    if (data.email && !EMAIL_RE.test(data.email)) errors.push('Niepoprawny adres e-mail.');
    if (!ROLES.includes(data.role)) errors.push(`Rola musi być jedną z: ${ROLES.join(', ')}.`);
    if (b.card_uid && !UID_RE.test(String(b.card_uid).trim())) errors.push('UID karty w formacie HEX, np. 04:A3:2F:1B.');
    if (data.pin && !PIN_RE.test(data.pin)) errors.push('PIN musi mieć 4–8 cyfr.');
    if (!data.card_uid && !data.pin && !existing?.has_pin) errors.push('Wymagany co najmniej jeden identyfikator: karta RFID lub PIN.');
    if (!data.zones.length || data.zones.some((z) => !ZONES[z])) errors.push(`Strefy muszą być z listy: ${Object.keys(ZONES).join(', ')}.`);

    const s = data.schedule;
    if (!s || !Array.isArray(s.days) || !s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        errors.push('Harmonogram: wybierz dni tygodnia (0 = niedziela … 6 = sobota).');
    } else if (!TIME_RE.test(s.from) || !TIME_RE.test(s.to) || s.from >= s.to) {
        errors.push('Harmonogram: godziny w formacie GG:MM, „od” wcześniej niż „do”.');
    } else {
        data.schedule = { days: [...new Set(s.days)].sort(), from: s.from, to: s.to };
    }
    if (data.valid_until && !DAY_RE.test(data.valid_until)) errors.push('Data ważności w formacie RRRR-MM-DD.');

    return { errors, data };
}

// ---------- Wyszukiwanie identyfikatora (czytnik, kontrola duplikatów) ----------
const CREDENTIAL_SELECT = `
    SELECT c.credential_id, c.user_id, c.credential_type, c.pin_code_hash, c.is_active AS credential_active,
           c.valid_from, c.valid_until, u.full_name, u.access_zones, u.access_schedule, u.is_active AS user_active
    FROM access_credentials c JOIN users u ON u.user_id = c.user_id`;

function toMatch(row) {
    return {
        credential: { credential_id: row.credential_id, is_active: Boolean(row.credential_active), valid_from: row.valid_from, valid_until: row.valid_until },
        user: {
            user_id: row.user_id,
            name: row.full_name,
            active: Boolean(row.user_active),
            zones: parseJson(row.access_zones, []),
            schedule: parseJson(row.access_schedule, null)
        }
    };
}

async function findByCard(uid) {
    const [rows] = await db.query(`${CREDENTIAL_SELECT} WHERE c.credential_type = 'RFID_TAG' AND c.rfid_uid = ?`, [normalizeUid(uid)]);
    return rows[0] ? toMatch(rows[0]) : null;
}

// PIN-y są zapisane jako skróty z solą, więc sprawdzamy kolejno (przy kilkudziesięciu osobach to szybkie).
async function findByPin(pin, { userId = null, excludeUserId = null } = {}) {
    const where = ["c.credential_type = 'PIN_CODE'"];
    const params = [];
    if (userId !== null) {
        where.push('c.user_id = ?');
        params.push(userId);
    }
    if (excludeUserId !== null) {
        where.push('c.user_id <> ?');
        params.push(excludeUserId);
    }
    const [rows] = await db.query(`${CREDENTIAL_SELECT} WHERE ${where.join(' AND ')}`, params);
    for (const row of rows) {
        if (await verifyPin(pin, row.pin_code_hash)) return toMatch(row);
    }
    return null;
}

// ---------- Sygnalizacja ----------
async function loadSignals() {
    const [rows] = await db.query('SELECT * FROM access_signals');
    const signals = JSON.parse(JSON.stringify(DEFAULT_SIGNALS));
    for (const r of rows) {
        if (!signals[r.result]) continue;
        signals[r.result] = { color: r.color, message: r.message, duration_s: Number(r.duration_s), buzzer: r.buzzer };
    }
    return signals;
}

function validateSignals(body) {
    const errors = [];
    const rows = [];
    for (const result of RESULTS) {
        const s = body?.[result];
        if (!s) continue;
        if (!/^#[0-9a-f]{6}$/i.test(s.color)) errors.push(`${result}: kolor w formacie #RRGGBB.`);
        if (typeof s.message !== 'string' || s.message.length > 120) errors.push(`${result}: komunikat do 120 znaków.`);
        const duration = Number(s.duration_s);
        if (!Number.isInteger(duration) || duration < 1 || duration > 30) errors.push(`${result}: czas 1–30 s.`);
        if (!BUZZER.includes(s.buzzer)) errors.push(`${result}: dźwięk jeden z: ${BUZZER.join(', ')}.`);
        rows.push([result, s.color, s.message, duration, s.buzzer]);
    }
    return { errors, rows };
}

module.exports = {
    ROLES,
    ROLE_TO_DB,
    ZONES,
    RESULTS,
    METHOD_TO_DB,
    METHOD_FROM_DB,
    DENIAL_TO_RESULT,
    RESULT_TO_DENIALS,
    DEFAULT_SIGNALS,
    normalizeUid,
    decideAccess,
    denialMessage,
    fillTemplate,
    hashPin,
    verifyPin,
    userToJson,
    loadUsers,
    validateUser,
    findByCard,
    findByPin,
    loadSignals,
    validateSignals
};
