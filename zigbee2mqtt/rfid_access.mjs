// =====================================================================
// Zigbee2MQTT – external converter dla czytnika RFID (ESP32-C6, PabloDIY RFID_ACCESS)
//
// Firmware (rfid_zigbee/main/main.c):
//   Basic:  manufacturerName "PabloDIY", modelID "RFID_ACCESS"
//   EP1:    On/Off (wyjście PIN_ONOFF_OUT)
//   EP2:    klaster 0xFC00 (bez manufacturer code)
//             0x0000 lastUid  – CHAR_STR, raportowany przy każdej karcie
//             0x0002 decision – UINT8, zapis: 1 = otwórz, 2 = odmowa
//
// Kontrakt z backendem IOT (mqtt.js):
//   urządzenie → zigbee2mqtt/<nazwa>      {"card_uid": "04A1B2C3", "scan_id": 1731785000000}
//   backend    → zigbee2mqtt/<ieee>/set   {"access_result": "granted", "led_color": …, "message": …,
//                                          "duration_s": …, "buzzer": …}
//   access_result: granted → decision 1; denied / unknown_card / outside_hours / blocked → decision 2
//
// Instalacja: skopiuj do <katalog danych Z2M>/external_converters/rfid_access.mjs,
// w configuration.yaml ustaw  advanced: enable_external_js: true  i zrestartuj Z2M.
// Urządzenie już sparowane: po restarcie zrób „Reconfigure” (rejestruje klaster 0xFC00).
// =====================================================================

import * as m from 'zigbee-herdsman-converters/lib/modernExtend';
import * as exposes from 'zigbee-herdsman-converters/lib/exposes';
import {Zcl} from 'zigbee-herdsman';

const e = exposes.presets;
const ea = exposes.access;

const UID_EP = 2;
const RESULTS = ['granted', 'denied', 'unknown_card', 'outside_hours', 'blocked'];
const DECISION = {GRANTED: 1, DENIED: 2};

const fzCardUid = {
    cluster: 'rfidAccess',
    // Tylko raporty: readResponse (np. odczyt z frontendu Z2M) nie może wyglądać jak nowe przyłożenie karty.
    type: ['attributeReport'],
    convert: (model, msg, publish, options, meta) => {
        if (msg.endpoint.ID !== UID_EP || msg.data.lastUid === undefined) return;
        const uid = String(msg.data.lastUid).replace(/[^0-9a-f]/gi, '').toUpperCase();
        // Wartość startowa atrybutu w firmware to same zera – to nie jest karta.
        if (!uid || /^0+$/.test(uid)) return;
        // scan_id: Z2M trzyma ostatni stan i dokleja card_uid do każdej kolejnej wiadomości
        // (np. raportu On/Off). Backend odrzuca powtórzone scan_id, więc liczy się tylko nowy raport.
        return {card_uid: uid, scan_id: Date.now()};
    },
};

const tzAccess = {
    // Wszystkie pola, które backend wysyła w odpowiedzi – inaczej Z2M loguje „No converter available”.
    key: ['access_result', 'led_color', 'message', 'duration_s', 'buzzer'],
    convertSet: async (entity, key, value, meta) => {
        // led_color / message / duration_s / buzzer: firmware ich jeszcze nie obsługuje.
        if (key !== 'access_result') return;
        if (!RESULTS.includes(value)) throw new Error(`access_result musi być jednym z: ${RESULTS.join(', ')}`);
        const decision = value === 'granted' ? DECISION.GRANTED : DECISION.DENIED;
        await meta.device.getEndpoint(UID_EP).write('rfidAccess', {decision}, {disableDefaultResponse: true});
    },
};

export default {
    fingerprint: [{modelID: 'RFID_ACCESS', manufacturerName: 'PabloDIY'}],
    model: 'RFID_ACCESS',
    vendor: 'PabloDIY',
    description: 'Czytnik RFID MFRC522 na ESP32-C6 (kontrola dostępu)',
    extend: [
        m.deviceAddCustomCluster('rfidAccess', {
            name: 'rfidAccess',
            ID: 0xfc00,
            attributes: {
                lastUid: {name: 'lastUid', ID: 0x0000, type: Zcl.DataType.CHAR_STR},
                decision: {name: 'decision', ID: 0x0002, type: Zcl.DataType.UINT8, write: true, max: 0xff},
            },
            commands: {},
            commandsResponse: {},
        }),
        m.onOff({powerOnBehavior: false}),
    ],
    fromZigbee: [fzCardUid],
    toZigbee: [tzAccess],
    exposes: [
        e.text('card_uid', ea.STATE).withDescription('UID ostatnio przyłożonej karty (hex)'),
        e.numeric('scan_id', ea.STATE).withDescription('Znacznik czasu odczytu (ms) – do odrzucania powtórzeń'),
        e.enum('access_result', ea.SET, RESULTS).withDescription('Decyzja dla czytnika (wysyła backend)'),
    ],
};
