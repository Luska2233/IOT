// ==========================================
// OBSŁUGA MQTT (komunikacja ze sprzętem przez Zigbee2MQTT)
// Tabele: devices, env_readings, binary_io_logs, lighting_states, heat_meter_readings,
// energy_readings, access_logs (baza/schema.sql).
// ==========================================
const mqtt = require('mqtt');
const db = require('./db');
const access = require('./lib/access');
const { describeError: describe } = require('./lib/http');

const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://localhost:1883';
const BASE_TOPIC = 'zigbee2mqtt';
const AUTO_REGISTER = process.env.AUTO_REGISTER_DEVICES !== 'false';
const ENERGY_SAVE_INTERVAL_MS = 60e3; // listwa raportuje często – zapisujemy maks. raz na minutę
const DEVICE_TOUCH_INTERVAL_MS = 60e3; // aktualizacja last_seen / lqi / baterii w devices
const SCAN_DEDUPE_MS = 5e3;

const client = mqtt.connect(MQTT_BROKER);

// Ostatni znany stan urządzeń: klucz = ieee_address, wartość = { payload, last_seen }
const state = new Map();
// Urządzenia z tabeli devices (po ieee_address i friendly_name)
let devicesByKey = new Map();
let devicesLoadedAt = 0;
// Nazwa w Zigbee2MQTT → adres IEEE (z zigbee2mqtt/bridge/devices) – działa też po zmianie nazwy w Z2M
const z2mNames = new Map();

const lastEnergySave = new Map();
const lastTouch = new Map();
const lastScan = new Map();
const lastLogged = new Map();

// Ten sam błąd (np. brak tabeli) logujemy najwyżej raz na minutę.
function logOnce(key, ...args) {
    const now = Date.now();
    if (now - (lastLogged.get(key) || 0) < 60e3) return;
    lastLogged.set(key, now);
    console.error(...args);
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isOn = (v) => v === true || v === 'ON' || v === 1;
const round = (v, digits) => (v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits);

async function refreshDevices() {
    const [rows] = await db.query('SELECT d.*, r.name AS location FROM devices d LEFT JOIN rooms r ON r.room_id = d.room_id ORDER BY d.device_id');
    const map = new Map();
    for (const row of rows) {
        if (row.friendly_name) map.set(String(row.friendly_name), row);
        if (row.ieee_address) map.set(String(row.ieee_address), row);
    }
    devicesByKey = map;
    devicesLoadedAt = Date.now();
    return rows;
}

async function findDevice(topicName) {
    const key = z2mNames.get(topicName) || topicName;
    if (!devicesByKey.has(key) && Date.now() - devicesLoadedAt > 30e3) {
        try {
            await refreshDevices();
        } catch (error) {
            logOnce('devices', '[MQTT] Nie można odczytać tabeli devices:', describe(error));
        }
    }
    return devicesByKey.get(key) || devicesByKey.get(topicName) || null;
}

async function save(table, sql, params) {
    try {
        await db.query(sql, params);
        return true;
    } catch (error) {
        logOnce(`save:${table}`, `[MQTT] Nie zapisano do ${table}:`, describe(error));
        return false;
    }
}

// ---------- Rejestracja urządzeń z listy Zigbee2MQTT ----------

function exposed(exposes = []) {
    const names = new Set();
    const types = new Set();
    const walk = (list) =>
        list.forEach((e) => {
            if (e.type) types.add(e.type);
            if (e.property) names.add(e.property);
            if (e.name) names.add(e.name);
            if (Array.isArray(e.features)) walk(e.features);
        });
    walk(Array.isArray(exposes) ? exposes : []);
    return { names, types };
}

// Typ z ENUM devices.device_type na podstawie tego, co urządzenie udostępnia („exposes”).
function guessDeviceType(d) {
    if (d.type === 'Coordinator') return 'GATEWAY';
    const { names, types } = exposed(d.definition?.exposes);
    const has = (...keys) => keys.some((k) => names.has(k));
    if (has('card_uid', 'pin', 'scan_id')) return 'RFID_KEYPAD';
    if (has('temp_supply_c', 'supply_temp_c')) return 'HEAT_METER';
    if (types.has('light')) return 'RGB_LIGHT';
    if (has('temperature') && has('humidity')) return 'ENV_SENSOR';
    if (has('occupancy', 'presence', 'vibration')) return 'OTHER_SENSOR';
    if (has('action')) return 'BINARY_INPUT';
    if (types.has('switch') || has('state', 'state_l1')) return 'BINARY_OUTPUT';
    return 'OTHER_SENSOR';
}

async function registerDevices(list) {
    if (!Array.isArray(list)) return;
    const rows = [];
    for (const d of list) {
        if (!d?.ieee_address) continue;
        if (d.friendly_name) z2mNames.set(String(d.friendly_name), String(d.ieee_address));
        const type = guessDeviceType(d);
        const model = d.definition?.model ?? d.model_id ?? null;
        const vendor = d.definition?.vendor ?? d.manufacturer ?? null;
        // Gdy w Z2M nie nadano nazwy (nazwa = adres IEEE), wyświetlamy producenta i model.
        const name = d.friendly_name && d.friendly_name !== d.ieee_address ? d.friendly_name : [vendor, model].filter(Boolean).join(' ') || d.ieee_address;
        const network = Number.isInteger(d.network_address) ? `0x${d.network_address.toString(16).toUpperCase().padStart(4, '0')}` : null;
        const custom = !d.definition || type === 'RFID_KEYPAD' || type === 'HEAT_METER' ? 1 : 0;
        rows.push([d.ieee_address, network, String(name).slice(0, 100), type, model, vendor, custom, d.software_build_id ?? null]);
    }
    if (!AUTO_REGISTER || !rows.length) return;
    try {
        const [before] = await db.query('SELECT COUNT(*) AS n FROM devices');
        await db.query(
            `INSERT INTO devices (ieee_address, network_address, friendly_name, device_type, model, vendor, is_custom_module, firmware_version) VALUES ?
             ON DUPLICATE KEY UPDATE network_address = VALUES(network_address),
                                     model = COALESCE(model, VALUES(model)),
                                     vendor = COALESCE(vendor, VALUES(vendor)),
                                     firmware_version = COALESCE(VALUES(firmware_version), firmware_version)`,
            [rows]
        );
        const [after] = await db.query('SELECT COUNT(*) AS n FROM devices');
        const added = after[0].n - before[0].n;
        if (added > 0) console.log(`[MQTT] Zarejestrowano nowe urządzenia z Zigbee2MQTT: ${added}`);
        await refreshDevices();
    } catch (error) {
        logOnce('register', '[MQTT] Nie zarejestrowano urządzeń z Zigbee2MQTT:', describe(error));
    }
}

// Stan łączności i baterii w tabeli devices (maks. raz na minutę na urządzenie).
function touchDevice(device, payload) {
    const now = Date.now();
    if (now - (lastTouch.get(device.device_id) || 0) < DEVICE_TOUCH_INTERVAL_MS) return null;
    lastTouch.set(device.device_id, now);
    const lqi = num(payload.linkquality);
    const battery = num(payload.battery);
    return save('devices', 'UPDATE devices SET last_seen = NOW(), is_online = 1, lqi = COALESCE(?, lqi), battery_percent = COALESCE(?, battery_percent) WHERE device_id = ?', [
        lqi === null ? null : Math.max(0, Math.min(255, Math.round(lqi))),
        battery === null ? null : Math.max(0, Math.min(100, Math.round(battery))),
        device.device_id
    ]);
}

async function handleAvailability(name, message) {
    const text = message.toString();
    let online = text === 'online';
    try {
        online = JSON.parse(text)?.state === 'online';
    } catch {
        // stary format: zwykły tekst online/offline
    }
    const device = await findDevice(name);
    if (device) await save('devices', 'UPDATE devices SET is_online = ? WHERE device_id = ?', [online ? 1 : 0, device.device_id]);
}

// ---------- Zapisy pomiarów i zdarzeń ----------

// Zdarzenie wejścia binarnego / czujnika w binary_io_logs.
function saveIo(deviceId, { eventType, channel = 1, state, actionType, rawAction = null }) {
    return save('binary_io_logs', 'INSERT INTO binary_io_logs (device_id, channel, io_direction, event_type, state, action_type, raw_action, triggered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        deviceId,
        channel,
        'INPUT',
        eventType,
        state ? 1 : 0,
        actionType,
        rawAction,
        'PHYSICAL'
    ]);
}

const CLICKS = { single: 'SINGLE_CLICK', double: 'DOUBLE_CLICK', hold: 'HOLD', long: 'HOLD', release: 'RELEASE', toggle: 'TOGGLE', on: 'SET_ON', off: 'SET_OFF' };

// Akcja Z2M → kanał i typ: TS0044 „2_double” → kanał 2, DOUBLE_CLICK; SNZB-01P „long” → kanał 1, HOLD.
function parseAction(action) {
    const m = /^(\d+)_([a-z]+)$/.exec(action);
    const channel = m ? Math.min(255, Number(m[1])) : 1;
    const kind = m ? m[2] : action;
    return { channel, actionType: CLICKS[kind] || 'SINGLE_CLICK' };
}

function saveEnergy(deviceId, p) {
    const now = Date.now();
    if (now - (lastEnergySave.get(deviceId) || 0) < ENERGY_SAVE_INTERVAL_MS) return null;
    lastEnergySave.set(deviceId, now);
    return save('energy_readings', 'INSERT INTO energy_readings (device_id, power_w, voltage_v, current_a, energy_kwh) VALUES (?, ?, ?, ?, ?)', [
        deviceId,
        num(p.power),
        num(p.voltage),
        num(p.current),
        num(p.energy)
    ]);
}

// Ciepłomierz: przyjmuje nazwy pól z bazy (temp_supply_c, flow_rate_lpm, thermal_power_w, …)
// albo z kontraktu MQTT (supply_temp_c, flow_m3h, power_kw, …) i zapisuje w jednostkach bazy.
function saveHeat(deviceId, p) {
    const supply = num(p.temp_supply_c ?? p.supply_temp_c);
    const ret = num(p.temp_return_c ?? p.return_temp_c);
    if (supply === null || ret === null) return null;
    const flowM3h = num(p.flow_m3h);
    const flowLpm = num(p.flow_rate_lpm) ?? (flowM3h === null ? null : (flowM3h * 1000) / 60);
    const powerKw = num(p.power_kw);
    let powerW = num(p.thermal_power_w) ?? (powerKw === null ? null : powerKw * 1000);
    // Gdy moduł nie przysyła mocy: Q [W] = 1,163 · qv [m³/h] · ΔT [K] · 1000 = 69,78 · qv [l/min] · ΔT
    if (powerW === null && flowLpm !== null) powerW = 69.78 * flowLpm * (supply - ret);
    return save('heat_meter_readings', 'INSERT INTO heat_meter_readings (device_id, temp_supply_c, temp_return_c, flow_rate_lpm, thermal_power_w, total_energy_kwh, total_volume_m3, error_flags, battery_percent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        deviceId,
        supply,
        ret,
        round(flowLpm, 3),
        round(powerW, 2),
        num(p.total_energy_kwh ?? p.energy_kwh),
        num(p.total_volume_m3 ?? p.volume_m3),
        num(p.error_flags) ?? 0,
        num(p.battery) === null ? null : Math.max(0, Math.min(100, Math.round(num(p.battery))))
    ]);
}

// Kolor CIE xy (raport żarówki) → #RRGGBB (wzór Philips Hue, sRGB).
function xyToHex(x, y) {
    if (!(y > 0)) return null;
    const X = x / y;
    const Z = (1 - x - y) / y;
    let rgb = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.01153];
    rgb = rgb.map((v) => Math.max(0, v));
    const max = Math.max(...rgb, 1e-9);
    return `#${rgb
        .map((v) => v / max)
        .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
        .map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0'))
        .join('')}`;
}

// Stan żarówki w lighting_states (endpoint /api/lighting).
function saveLighting(deviceId, s) {
    return save(
        'lighting_states',
        `INSERT INTO lighting_states (device_id, is_on, brightness, color_hex, color_temp_mired) VALUES (?, ?, ?, COALESCE(?, '#FFFFFF'), ?)
         ON DUPLICATE KEY UPDATE is_on = VALUES(is_on), brightness = VALUES(brightness),
                                 color_hex = COALESCE(?, color_hex), color_temp_mired = VALUES(color_temp_mired)`,
        [deviceId, isOn(s.state) ? 1 : 0, Math.max(0, Math.min(255, num(s.brightness) ?? 255)), s.color?.hex ?? null, num(s.color_temp), s.color?.hex ?? null]
    );
}

// Czytnik RFID/PIN (moduł ESP32-C6): decyzja → dziennik → odpowiedź do czytnika.
async function handleAccess(device, p) {
    const uid = p.card_uid ? access.normalizeUid(p.card_uid) : null;
    const pin = p.pin !== undefined && p.pin !== null && p.pin !== '' ? String(p.pin) : null;
    if (!uid && !pin) return;

    // Zigbee2MQTT może powtórzyć ostatni odczyt przy innym raporcie – odrzucamy duplikaty.
    const key = p.scan_id !== undefined ? `scan:${p.scan_id}` : `${uid}|${pin}`;
    const last = lastScan.get(device.ieee_address);
    if (last && last.key === key && (p.scan_id !== undefined || Date.now() - last.at < SCAN_DEDUPE_MS)) return;
    lastScan.set(device.ieee_address, { key, at: Date.now() });

    const zone = typeof p.zone === 'string' && access.ZONES[p.zone] ? p.zone : device.access_zone || 'main';
    const method = uid && pin ? 'rfid_pin' : uid ? 'rfid' : 'pin';
    const now = new Date();
    let match = null;
    let reason = null;
    let systemError = false;
    try {
        if (uid) {
            match = await access.findByCard(uid);
            // Karta + PIN: PIN musi należeć do właściciela karty
            if (match && pin && !(await access.findByPin(pin, { userId: match.user.user_id }))) reason = 'WRONG_PIN';
        } else {
            match = await access.findByPin(pin);
            if (!match) reason = 'WRONG_PIN';
        }
        if (!reason) reason = access.decideAccess({ user: match?.user, credential: match?.credential, zone, at: now });
    } catch (error) {
        logOnce('access', '[DOSTĘP] Błąd sprawdzania uprawnień:', describe(error));
        systemError = true;
    }

    const result = systemError ? 'denied' : access.DENIAL_TO_RESULT[reason];
    if (!systemError) {
        await save('access_logs', 'INSERT INTO access_logs (device_id, credential_id, user_id, user_name, auth_method, raw_identifier, zone, access_granted, denial_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            device.device_id,
            match?.credential.credential_id ?? null,
            match?.user.user_id ?? null,
            match?.user.name ?? null,
            access.METHOD_TO_DB[method],
            uid ?? '••••',
            zone,
            reason === 'NONE' ? 1 : 0,
            reason
        ]);
    }
    const name = device.friendly_name || device.ieee_address;
    console.log(`[DOSTĘP] ${name}: ${match?.user.name ?? 'nieznany'} → ${result} (${systemError ? 'błąd bazy' : access.denialMessage(reason, zone)})`);

    let signals = access.DEFAULT_SIGNALS;
    try {
        signals = await access.loadSignals();
    } catch {
        // brak tabeli access_signals – zostają wartości domyślne
    }
    const sig = signals[result] || access.DEFAULT_SIGNALS[result];
    try {
        await publish(device.ieee_address, {
            access_result: result,
            led_color: sig.color,
            message: access.fillTemplate(sig.message, match?.user),
            duration_s: sig.duration_s,
            buzzer: sig.buzzer
        });
    } catch (error) {
        logOnce('access-publish', '[DOSTĘP] Nie wysłano odpowiedzi do czytnika:', describe(error));
    }
}

// Wiadomość z danymi urządzenia (zigbee2mqtt/<nazwa>): rozpoznanie po polach payloadu.
async function handleDeviceMessage(name, message) {
    let payload;
    try {
        payload = JSON.parse(message.toString());
    } catch {
        return; // np. "online"/"offline" – to nie jest JSON z danymi
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

    const device = await findDevice(name);
    const key = device ? String(device.ieee_address) : z2mNames.get(name) || name;
    const prev = state.get(key)?.payload || {};
    const merged = { ...prev, ...payload };
    // Kolor żarówki z Z2M przychodzi jako xy – dokładamy hex dla panelu i lighting_states
    if (payload.color && typeof payload.color.x === 'number' && !payload.color.hex) {
        merged.color = { ...payload.color, hex: xyToHex(payload.color.x, payload.color.y) };
    }
    state.set(key, { payload: merged, last_seen: new Date() });

    if (!device) {
        logOnce(`unknown:${name}`, `[MQTT] Nieznane urządzenie „${name}” – brak w tabeli devices (rejestruje się samo z listy Zigbee2MQTT)`);
        return;
    }
    const deviceId = device.device_id;
    const tasks = [touchDevice(device, payload)];

    // Odczyty środowiskowe (temperatura, wilgotność, ciśnienie)
    if (payload.temperature !== undefined && payload.humidity !== undefined) {
        tasks.push(
            save('env_readings', 'INSERT INTO env_readings (device_id, temperature_c, humidity_rh, pressure_hpa) VALUES (?, ?, ?, ?)', [
                deviceId,
                payload.temperature,
                payload.humidity,
                payload.pressure || null
            ]).then((ok) => ok && console.log(`[MQTT] Zapisano odczyt środowiskowy dla urządzenia ID: ${deviceId}`))
        );
    }
    // Wejścia binarne: pilot TS0044 (1_single … 4_hold), przycisk SNZB-01P (single/double/long)
    if (typeof payload.action === 'string' && payload.action !== '') {
        const { channel, actionType } = parseAction(payload.action);
        tasks.push(saveIo(deviceId, { eventType: 'BUTTON', channel, state: true, actionType, rawAction: payload.action.slice(0, 32) }));
    }
    // Czujnik obecności SNZB-06P – tylko zmiana stanu
    if (typeof payload.occupancy === 'boolean' && payload.occupancy !== prev.occupancy) {
        tasks.push(saveIo(deviceId, { eventType: 'OCCUPANCY', state: payload.occupancy, actionType: payload.occupancy ? 'DETECTED' : 'CLEARED' }));
    }
    // Czujnik wibracji z syreną NOUS E14 – początek wibracji i włączenie alarmu
    if (payload.vibration === true && prev.vibration !== true) {
        tasks.push(saveIo(deviceId, { eventType: 'VIBRATION', state: true, actionType: 'DETECTED' }));
    }
    if (payload.alarm !== undefined && isOn(payload.alarm) && !isOn(prev.alarm)) {
        tasks.push(saveIo(deviceId, { eventType: 'ALARM', state: true, actionType: 'SET_ON', rawAction: 'siren_on' }));
    }
    // Żarówka RGB – aktualny stan w lighting_states
    if (device.device_type === 'RGB_LIGHT' && (payload.state !== undefined || payload.brightness !== undefined || payload.color || payload.color_temp !== undefined)) {
        tasks.push(saveLighting(deviceId, merged));
    }
    // Ciepłomierz (moduł własny) albo listwa z pomiarem energii (NOUS A11Z)
    if ((payload.temp_supply_c ?? payload.supply_temp_c) !== undefined) {
        tasks.push(saveHeat(deviceId, payload));
    } else if (payload.energy !== undefined || payload.power !== undefined) {
        tasks.push(saveEnergy(deviceId, payload));
    }
    // Czytnik kart / klawiatura PIN (moduł własny)
    if (payload.card_uid || (payload.pin !== undefined && payload.pin !== '')) {
        tasks.push(handleAccess(device, payload));
    }
    await Promise.all(tasks);
}

// Wszystkie wiadomości z brokera trafiają tutaj.
async function handleMessage(topic, message) {
    const parts = topic.split('/');
    if (parts[0] !== BASE_TOPIC || !parts[1]) return;
    if (topic === `${BASE_TOPIC}/bridge/devices`) {
        try {
            return await registerDevices(JSON.parse(message.toString()));
        } catch {
            return undefined;
        }
    }
    if (parts[1] === 'bridge') return undefined;
    if (parts.length === 3 && parts[2] === 'availability') return handleAvailability(parts[1], message);
    if (parts.length === 2) return handleDeviceMessage(parts[1], message);
    return undefined;
}

// Publikacja komendy na zigbee2mqtt/<ieee>/set – Promise rozwiązany po potwierdzeniu brokera.
function publish(ieeeAddress, payload) {
    return new Promise((resolve, reject) => {
        if (!client.connected) {
            reject(new Error('Brak połączenia z brokerem MQTT'));
            return;
        }
        client.publish(`${BASE_TOPIC}/${ieeeAddress}/set`, JSON.stringify(payload), { qos: 1 }, (err) => (err ? reject(err) : resolve()));
    });
}

client.on('connect', () => {
    console.log(`[MQTT] Połączono z brokerem: ${MQTT_BROKER}`);
    client.subscribe([`${BASE_TOPIC}/+`, `${BASE_TOPIC}/+/availability`, `${BASE_TOPIC}/bridge/devices`], (err) => {
        if (!err) {
            console.log(`[MQTT] Nasłuchiwanie tematów ${BASE_TOPIC}/… aktywne.`);
        }
    });
});

client.on('message', (topic, message) => {
    handleMessage(topic, message).catch((error) => console.error('[MQTT] Błąd przetwarzania wiadomości:', error));
});

client.on('error', (error) => logOnce('mqtt-error', '[MQTT] Błąd:', describe(error)));
client.on('offline', () => logOnce('mqtt-offline', `[MQTT] Brak połączenia z brokerem ${MQTT_BROKER} – ponawiam`));

refreshDevices().catch((error) => logOnce('devices', '[MQTT] Nie można odczytać tabeli devices:', describe(error)));
setInterval(() => {
    refreshDevices().catch((error) => logOnce('devices', '[MQTT] Nie można odczytać tabeli devices:', describe(error)));
}, 30e3).unref();

module.exports = {
    client,
    publish,
    handleMessage,
    refreshDevices,
    isConnected: () => client.connected,
    getState: (ieeeAddress) => state.get(String(ieeeAddress)) || null
};
