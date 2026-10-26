// ==========================================
// API: urządzenia, pomiary, stan, komendy, zdarzenia
// ==========================================
const express = require('express');
const db = require('../db');
const mqtt = require('../mqtt');
const { describeError, dbError, parseRange, parseLimit } = require('../lib/http');

const router = express.Router();

const deviceName = (d) => (d ? d.friendly_name || d.ieee_address : null);

// Stan backendu, brokera MQTT i bazy (Pulpit → „Stan systemu”)
router.get('/health', async (req, res) => {
    let dbStatus = 'ok';
    try {
        await db.query('SELECT 1');
    } catch {
        dbStatus = 'error';
    }
    res.json({
        api: 'ok',
        mqtt: mqtt.isConnected() ? 'connected' : 'disconnected',
        db: dbStatus,
        uptime_s: Math.round(process.uptime())
    });
});

// Pobieranie wszystkich urządzeń (z nazwą pomieszczenia jako `location`)
router.get('/devices', async (req, res) => {
    try {
        res.json(await mqtt.refreshDevices());
    } catch (error) {
        dbError(res, error, 'Błąd pobierania urządzeń');
    }
});

// Ostatni stan każdego urządzenia: z pamięci (ostatnia wiadomość MQTT), a po restarcie
// backendu – z kolumn devices (bateria, jakość łącza, ostatni kontakt).
router.get('/state', async (req, res) => {
    try {
        const devices = await mqtt.refreshDevices();
        res.json(
            devices.map((d) => {
                const s = mqtt.getState(d.ieee_address);
                const fromDb = {};
                if (d.battery_percent !== null && d.battery_percent !== undefined) fromDb.battery = d.battery_percent;
                if (d.lqi !== null && d.lqi !== undefined) fromDb.linkquality = d.lqi;
                return {
                    device_id: d.device_id,
                    ieee_address: d.ieee_address,
                    last_seen: s?.last_seen ?? d.last_seen ?? null,
                    payload: { ...fromDb, ...(s?.payload ?? {}) }
                };
            })
        );
    } catch (error) {
        dbError(res, error, 'Błąd pobierania stanu urządzeń');
    }
});

// Pomiary środowiskowe w zakresie dat: ?from=&to=&limit= (domyślnie 7 dni)
router.get('/readings/:deviceId', async (req, res) => {
    const { from, to } = parseRange(req.query, 7);
    const limit = parseLimit(req.query.limit, 5000, 20000);
    try {
        const [rows] = await db.query(
            'SELECT * FROM env_readings WHERE device_id = ? AND recorded_at BETWEEN ? AND ? ORDER BY recorded_at DESC LIMIT ?',
            [req.params.deviceId, from, to, limit]
        );
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania pomiarów');
    }
});

// Przełączenia wyjść z panelu (state, state_l1…) zapisujemy w binary_io_logs jako OUTPUT / CLIENT_APP.
async function logOutputs(deviceId, payload) {
    const rows = [];
    for (const [key, value] of Object.entries(payload)) {
        const m = /^state(?:_l(\d+))?$/.exec(key);
        if (!m || typeof value !== 'string') continue;
        const v = value.toUpperCase();
        const actionType = { ON: 'SET_ON', OFF: 'SET_OFF', TOGGLE: 'TOGGLE' }[v];
        if (!actionType) continue;
        rows.push([deviceId, m[1] ? Number(m[1]) : 1, 'OUTPUT', 'OUTPUT', v === 'OFF' ? 0 : 1, actionType, `${key}:${v}`, 'CLIENT_APP']);
    }
    if (!rows.length) return;
    try {
        await db.query('INSERT INTO binary_io_logs (device_id, channel, io_direction, event_type, state, action_type, raw_action, triggered_by) VALUES ?', [rows]);
    } catch (error) {
        console.error('[API] Nie zapisano przełączenia w binary_io_logs:', describeError(error));
    }
}

// Wysyłanie komendy / sterowanie urządzeniem
// Adres IEEE bierzemy z bazy po device_id – nie ufamy temu, co przyśle klient.
router.post('/command', async (req, res) => {
    const { device_id, command_type, payload } = req.body || {};

    if (!device_id || !command_type) {
        return res.status(400).json({ error: 'Brak wymaganych pól: device_id lub command_type' });
    }
    if (payload !== undefined && (payload === null || typeof payload !== 'object' || Array.isArray(payload))) {
        return res.status(400).json({ error: 'Pole payload musi być obiektem JSON, np. {"state": "ON"}' });
    }
    const body = payload || {};

    let device;
    let commandId;
    try {
        const [rows] = await db.query('SELECT * FROM devices WHERE device_id = ?', [device_id]);
        device = rows[0];
        if (!device) {
            return res.status(404).json({ error: `Nie ma urządzenia o device_id = ${device_id}` });
        }
        // 1. Zapis rozkazu w kolejce komend (ślad audytowy)
        const [dbResult] = await db.query(
            'INSERT INTO command_queue (device_id, command_type, payload, status) VALUES (?, ?, ?, ?)',
            [device.device_id, String(command_type).slice(0, 50), JSON.stringify(body), 'PENDING']
        );
        commandId = dbResult.insertId;
    } catch (error) {
        return dbError(res, error, 'Błąd przetwarzania komendy');
    }

    // 2. Wysłanie fizycznej wiadomości przez MQTT do bramki i zapis wyniku
    const topic = `zigbee2mqtt/${device.ieee_address}/set`;
    let status = 'SENT';
    let publishError = null;
    try {
        await mqtt.publish(device.ieee_address, body);
    } catch (error) {
        status = 'FAILED';
        publishError = error.message;
    }
    try {
        await db.query(
            `UPDATE command_queue SET status = ?, executed_at = ${status === 'SENT' ? 'NOW(3)' : 'NULL'} WHERE command_id = ?`,
            [status, commandId]
        );
    } catch (error) {
        console.error('[API] Nie zaktualizowano statusu komendy:', describeError(error));
    }

    if (status === 'FAILED') {
        return res.status(503).json({ error: `Komenda zapisana, ale nie wysłana: ${publishError}`, command_id: commandId, topic });
    }
    await logOutputs(device.device_id, body);
    res.json({ success: true, command_id: commandId, topic, message: 'Komenda zapisana w bazie i wysłana do urządzenia' });
});

// Historia komend (ślad audytowy)
router.get('/commands', async (req, res) => {
    const limit = parseLimit(req.query.limit, 50, 500);
    try {
        const [rows] = await db.query('SELECT * FROM command_queue ORDER BY created_at DESC LIMIT ?', [limit]);
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania historii komend');
    }
});

const EVENT_TYPES = ['BUTTON', 'OCCUPANCY', 'VIBRATION', 'ALARM'];
const CLICK_NAMES = { SINGLE_CLICK: 'single', DOUBLE_CLICK: 'double', HOLD: 'hold', RELEASE: 'release', TOGGLE: 'toggle', SET_ON: 'on', SET_OFF: 'off' };

// Wiersz binary_io_logs → akcja w formacie panelu (jak w Zigbee2MQTT).
function eventAction(row) {
    switch (row.event_type) {
        case 'OCCUPANCY': return row.state ? 'occupied' : 'vacant';
        case 'VIBRATION': return 'vibration';
        case 'ALARM': return 'siren_on';
        default: return row.raw_action || `${row.channel}_${CLICK_NAMES[row.action_type] || String(row.action_type).toLowerCase()}`;
    }
}

// Zdarzenia z wejść binarnych i czujników (binary_io_logs): ?from=&to=&type=&device_id=
router.get('/events', async (req, res) => {
    const { from, to } = parseRange(req.query, 7);
    const where = ["io_direction = 'INPUT'", 'recorded_at BETWEEN ? AND ?'];
    const params = [from, to];
    const type = String(req.query.type || '').toUpperCase();
    if (EVENT_TYPES.includes(type)) {
        where.push('event_type = ?');
        params.push(type);
    }
    if (req.query.device_id) {
        where.push('device_id = ?');
        params.push(req.query.device_id);
    }
    params.push(parseLimit(req.query.limit, 5000, 20000));
    try {
        const [rows] = await db.query(
            `SELECT log_id, device_id, channel, event_type, state, action_type, raw_action, recorded_at
             FROM binary_io_logs WHERE ${where.join(' AND ')} ORDER BY recorded_at DESC LIMIT ?`,
            params
        );
        const devices = await mqtt.refreshDevices();
        const byId = new Map(devices.map((d) => [String(d.device_id), d]));
        res.json(
            rows.map((r) => ({
                event_id: r.log_id,
                device_id: r.device_id,
                device_name: deviceName(byId.get(String(r.device_id))),
                type: r.event_type.toLowerCase(),
                action: eventAction(r),
                value: r.event_type === 'BUTTON' ? null : Boolean(r.state),
                recorded_at: r.recorded_at
            }))
        );
    } catch (error) {
        dbError(res, error, 'Błąd pobierania zdarzeń');
    }
});

module.exports = router;
