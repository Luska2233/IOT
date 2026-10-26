// ==========================================
// API: kontrola dostępu – użytkownicy (users + access_credentials), dziennik, sygnalizacja
// ==========================================
const express = require('express');
const db = require('../db');
const access = require('../lib/access');
const { dbError, parseRange, parseLimit } = require('../lib/http');

const router = express.Router();

// Konflikt identyfikatorów: ta sama karta albo ten sam PIN u innej osoby.
async function credentialConflict(data, selfId = null) {
    if (data.card_uid) {
        const [rows] = await db.query('SELECT user_id FROM access_credentials WHERE rfid_uid = ? AND user_id <> ?', [data.card_uid, selfId ?? 0]);
        if (rows.length) return 'Ta karta jest już przypisana do innego użytkownika.';
    }
    if (data.pin && (await access.findByPin(data.pin, { excludeUserId: selfId ?? 0 }))) {
        return 'Ten kod PIN jest już używany – wybierz inny.';
    }
    return null;
}

function duplicateMessage(error) {
    if (/uq_users_email/.test(error.sqlMessage || '')) return 'Ten adres e-mail jest już przypisany innej osobie.';
    return 'Ta karta jest już przypisana do innego użytkownika.';
}

// Karta i PIN z formularza panelu → wiersze access_credentials; „Ważne do” → valid_until identyfikatorów.
async function saveCredentials(conn, userId, data) {
    const [cards] = await conn.query("SELECT credential_id, rfid_uid FROM access_credentials WHERE user_id = ? AND credential_type = 'RFID_TAG' ORDER BY credential_id", [userId]);
    if (data.card_uid) {
        if (!cards.some((c) => c.rfid_uid === data.card_uid)) {
            if (cards.length) await conn.query('UPDATE access_credentials SET rfid_uid = ? WHERE credential_id = ?', [data.card_uid, cards[0].credential_id]);
            else await conn.query("INSERT INTO access_credentials (user_id, credential_type, rfid_uid, label) VALUES (?, 'RFID_TAG', ?, 'Karta główna')", [userId, data.card_uid]);
        }
    } else if (cards.length) {
        // Pole karty wyczyszczone w panelu – usuwamy karty osoby (historia wejść zostaje w access_logs)
        await conn.query("DELETE FROM access_credentials WHERE user_id = ? AND credential_type = 'RFID_TAG'", [userId]);
    }

    if (data.pin) {
        // PIN zmieniamy tylko, gdy panel przysłał nowy
        const hash = await access.hashPin(data.pin);
        const [pins] = await conn.query("SELECT credential_id FROM access_credentials WHERE user_id = ? AND credential_type = 'PIN_CODE' ORDER BY credential_id", [userId]);
        if (pins.length) await conn.query('UPDATE access_credentials SET pin_code_hash = ? WHERE credential_id = ?', [hash, pins[0].credential_id]);
        else await conn.query("INSERT INTO access_credentials (user_id, credential_type, pin_code_hash, label) VALUES (?, 'PIN_CODE', ?, 'PIN')", [userId, hash]);
    }

    await conn.query('UPDATE access_credentials SET valid_until = ? WHERE user_id = ?', [data.valid_until ? `${data.valid_until} 23:59:59` : null, userId]);
}

const userParams = (data) => [data.name, data.email, access.ROLE_TO_DB[data.role], JSON.stringify(data.zones), JSON.stringify(data.schedule), data.active ? 1 : 0];

// Operacje na users + access_credentials w jednej transakcji.
async function inTransaction(work) {
    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        const result = await work(conn);
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
}

router.get('/users', async (req, res) => {
    try {
        res.json(await access.loadUsers());
    } catch (error) {
        dbError(res, error, 'Błąd pobierania użytkowników');
    }
});

router.post('/users', async (req, res) => {
    const { errors, data } = access.validateUser(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    try {
        const conflict = await credentialConflict(data);
        if (conflict) return res.status(409).json({ error: conflict });
        const userId = await inTransaction(async (conn) => {
            const [result] = await conn.query(
                'INSERT INTO users (full_name, email, role, access_zones, access_schedule, is_active) VALUES (?, ?, ?, ?, ?, ?)',
                userParams(data)
            );
            await saveCredentials(conn, result.insertId, data);
            return result.insertId;
        });
        res.status(201).json((await access.loadUsers(userId))[0]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: duplicateMessage(error) });
        dbError(res, error, 'Błąd dodawania użytkownika');
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const existing = (await access.loadUsers(req.params.id))[0];
        if (!existing) return res.status(404).json({ error: `Nie ma użytkownika o id = ${req.params.id}` });
        const { errors, data } = access.validateUser(req.body, existing);
        if (errors.length) return res.status(400).json({ error: errors.join(' ') });
        const conflict = await credentialConflict(data, existing.user_id);
        if (conflict) return res.status(409).json({ error: conflict });
        await inTransaction(async (conn) => {
            await conn.query(
                'UPDATE users SET full_name = ?, email = ?, role = ?, access_zones = ?, access_schedule = ?, is_active = ? WHERE user_id = ?',
                [...userParams(data), existing.user_id]
            );
            await saveCredentials(conn, existing.user_id, data);
        });
        res.json((await access.loadUsers(existing.user_id))[0]);
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: duplicateMessage(error) });
        dbError(res, error, 'Błąd zapisu użytkownika');
    }
});

// Usunięcie osoby kasuje jej identyfikatory; wpisy w dzienniku zostają (user_id → NULL, user_name zostaje).
router.delete('/users/:id', async (req, res) => {
    try {
        const [result] = await db.query('DELETE FROM users WHERE user_id = ?', [req.params.id]);
        if (!result.affectedRows) return res.status(404).json({ error: `Nie ma użytkownika o id = ${req.params.id}` });
        res.status(204).end();
    } catch (error) {
        dbError(res, error, 'Błąd usuwania użytkownika');
    }
});

// Dziennik dostępu: ?from=&to=&user_id=&result=
router.get('/access-logs', async (req, res) => {
    const { from, to } = parseRange(req.query, 7);
    const where = ['l.recorded_at BETWEEN ? AND ?'];
    const params = [from, to];
    if (req.query.user_id) {
        where.push('COALESCE(l.user_id, c.user_id) = ?');
        params.push(req.query.user_id);
    }
    const reasons = access.RESULT_TO_DENIALS[req.query.result];
    if (reasons) {
        where.push(`l.denial_reason IN (${reasons.map(() => '?').join(', ')})`);
        params.push(...reasons);
    }
    params.push(parseLimit(req.query.limit, 5000, 20000));
    try {
        const [rows] = await db.query(
            `SELECT l.access_log_id, l.recorded_at, COALESCE(l.user_id, c.user_id) AS user_id,
                    COALESCE(l.user_name, u.full_name) AS user_name, l.auth_method, l.raw_identifier,
                    COALESCE(d.friendly_name, d.ieee_address) AS point, l.zone, l.denial_reason
             FROM access_logs l
             LEFT JOIN access_credentials c ON c.credential_id = l.credential_id
             LEFT JOIN users u ON u.user_id = COALESCE(l.user_id, c.user_id)
             LEFT JOIN devices d ON d.device_id = l.device_id
             WHERE ${where.join(' AND ')}
             ORDER BY l.recorded_at DESC LIMIT ?`,
            params
        );
        res.json(
            rows.map((r) => ({
                log_id: r.access_log_id,
                recorded_at: r.recorded_at,
                user_id: r.user_id,
                user_name: r.user_name,
                method: access.METHOD_FROM_DB[r.auth_method] ?? r.auth_method,
                credential: r.raw_identifier,
                point: r.point,
                zone: r.zone,
                result: access.DENIAL_TO_RESULT[r.denial_reason] ?? 'denied',
                message: access.denialMessage(r.denial_reason, r.zone)
            }))
        );
    } catch (error) {
        dbError(res, error, 'Błąd pobierania dziennika dostępu');
    }
});

// Sygnalizacja wyniku weryfikacji (kolor diody, komunikat, czas, dźwięk)
router.get('/access/signals', async (req, res) => {
    try {
        res.json(await access.loadSignals());
    } catch (error) {
        dbError(res, error, 'Błąd pobierania sygnalizacji');
    }
});

router.put('/access/signals', async (req, res) => {
    const { errors, rows } = access.validateSignals(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    if (!rows.length) return res.status(400).json({ error: 'Brak danych sygnalizacji do zapisania' });
    try {
        await db.query(
            `INSERT INTO access_signals (result, color, message, duration_s, buzzer) VALUES ?
             ON DUPLICATE KEY UPDATE color = VALUES(color), message = VALUES(message), duration_s = VALUES(duration_s), buzzer = VALUES(buzzer)`,
            [rows]
        );
        res.json(await access.loadSignals());
    } catch (error) {
        dbError(res, error, 'Błąd zapisu sygnalizacji');
    }
});

module.exports = router;
