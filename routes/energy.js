// ==========================================
// API: ciepłomierz i zużycie energii listwy
// Zużycie dzienne liczymy z przyrostów licznika (LAG – wymaga MySQL 8 / MariaDB 10.2+).
// Gdy urządzenie nie przysyła licznika, energia jest całkowana z mocy chwilowej.
// ==========================================
const express = require('express');
const db = require('../db');
const mqtt = require('../mqtt');
const { dbError, parseRange, parseLimit, num, round } = require('../lib/http');

const router = express.Router();
const DAY_MS = 24 * 3600e3;

// Okno do liczenia przyrostów; przerwy dłuższe niż godzina nie są doliczane do energii z mocy.
const OVER = 'OVER (PARTITION BY device_id ORDER BY recorded_at)';
const HOURS_SINCE_PREV = `LEAST(TIMESTAMPDIFF(SECOND, LAG(recorded_at) ${OVER}, recorded_at), 3600) / 3600`;

function deviceFilter(query, params) {
    if (!query.device_id) return '';
    params.push(query.device_id);
    return 'AND device_id = ?';
}

// Dzienny zakres: od północy dnia `from` do `to`.
function dayRange(query, defaultDays) {
    const { from, to } = parseRange(query, defaultDays);
    const start = new Date(from);
    start.setHours(0, 0, 0, 0);
    return { from: start, to };
}

router.get('/heatmeter/readings', async (req, res) => {
    const { from, to } = parseRange(req.query, 1);
    const params = [from, to];
    const filter = deviceFilter(req.query, params);
    params.push(parseLimit(req.query.limit, 20000, 50000));
    try {
        const [rows] = await db.query(
            `SELECT recorded_at, temp_supply_c AS supply_temp_c, temp_return_c AS return_temp_c,
                    flow_rate_lpm * 0.06 AS flow_m3h, thermal_power_w / 1000 AS power_kw, total_energy_kwh AS energy_kwh
             FROM heat_meter_readings
             WHERE recorded_at BETWEEN ? AND ? ${filter}
             ORDER BY recorded_at DESC LIMIT ?`,
            params
        );
        res.json(rows);
    } catch (error) {
        dbError(res, error, 'Błąd pobierania pomiarów ciepłomierza');
    }
});

router.get('/heatmeter/daily', async (req, res) => {
    const { from, to } = dayRange(req.query, 30);
    const params = [new Date(from.getTime() - DAY_MS), to];
    const filter = deviceFilter(req.query, params);
    params.push(from);
    try {
        const [rows] = await db.query(
            `SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d') AS day,
                    SUM(GREATEST(delta, 0)) AS energy_counter,
                    SUM(e_power) AS energy_power,
                    AVG(power_kw) AS avg_power_kw,
                    AVG(supply_temp_c) AS avg_supply_c,
                    AVG(return_temp_c) AS avg_return_c
             FROM (
                 SELECT recorded_at, thermal_power_w / 1000 AS power_kw,
                        temp_supply_c AS supply_temp_c, temp_return_c AS return_temp_c,
                        total_energy_kwh - LAG(total_energy_kwh) ${OVER} AS delta,
                        thermal_power_w / 1000 * ${HOURS_SINCE_PREV} AS e_power
                 FROM heat_meter_readings
                 WHERE recorded_at BETWEEN ? AND ? ${filter}
             ) AS t
             WHERE recorded_at >= ?
             GROUP BY day
             ORDER BY day`,
            params
        );
        res.json(
            rows.map((r) => ({
                day: r.day,
                energy_kwh: round(num(r.energy_counter) ?? num(r.energy_power), 3),
                avg_power_kw: round(num(r.avg_power_kw), 3),
                avg_supply_c: round(num(r.avg_supply_c), 1),
                avg_return_c: round(num(r.avg_return_c), 1)
            }))
        );
    } catch (error) {
        dbError(res, error, 'Błąd liczenia dziennego zużycia energii cieplnej');
    }
});

// Szacunek czasu pracy baterii z trendu poziomu naładowania (regresja liniowa, ostatnie 14 dni).
function estimateBatteryDays(history, battery) {
    if (battery === null || history.length < 5) return null;
    const pts = history.map((h) => [new Date(h.recorded_at).getTime() / DAY_MS, Number(h.battery_percent)]);
    if (pts[pts.length - 1][0] - pts[0][0] < 2) return null;
    const mx = pts.reduce((a, [x]) => a + x, 0) / pts.length;
    const my = pts.reduce((a, [, y]) => a + y, 0) / pts.length;
    const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    const slope = sxx ? pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx : 0;
    return slope < 0 ? Math.round(battery / -slope) : null;
}

router.get('/heatmeter/status', async (req, res) => {
    const params = [];
    const where = req.query.device_id ? 'WHERE device_id = ?' : '';
    if (req.query.device_id) params.push(req.query.device_id);
    try {
        const [lastRows] = await db.query(`SELECT * FROM heat_meter_readings ${where} ORDER BY recorded_at DESC LIMIT 1`, params);
        const last = lastRows[0];
        if (!last) return res.json(null);

        const devices = await mqtt.refreshDevices();
        const device = devices.find((d) => String(d.device_id) === String(last.device_id));
        const cached = (device && mqtt.getState(device.ieee_address)?.payload) || {};
        const interval = num(cached.report_interval_s) ?? num(process.env.HEATMETER_REPORT_INTERVAL_S);
        const battery = num(last.battery_percent) ?? num(device?.battery_percent) ?? num(cached.battery);
        const lastReport = new Date(last.recorded_at);
        const [history] = await db.query(
            'SELECT recorded_at, battery_percent FROM heat_meter_readings WHERE device_id = ? AND battery_percent IS NOT NULL AND recorded_at >= ? ORDER BY recorded_at',
            [last.device_id, new Date(Date.now() - 14 * DAY_MS)]
        );

        // Pola, których moduł nie raportuje, zwracamy jako null (panel pokaże „–”).
        res.json({
            device_id: last.device_id,
            battery_pct: battery,
            battery_v: num(cached.battery_v),
            report_interval_s: interval,
            sleep_mode: cached.sleep_mode ?? null,
            zigbee_role: cached.zigbee_role ?? null,
            last_report: lastReport,
            next_report: interval ? new Date(lastReport.getTime() + interval * 1000) : null,
            avg_current_ua: num(cached.avg_current_ua),
            est_battery_days: estimateBatteryDays(history, battery)
        });
    } catch (error) {
        dbError(res, error, 'Błąd pobierania stanu ciepłomierza');
    }
});

// Dzienne zużycie energii elektrycznej (listwa): ?device_id=&from=&to=
router.get('/energy/daily', async (req, res) => {
    const { from, to } = dayRange(req.query, 30);
    const params = [new Date(from.getTime() - DAY_MS), to];
    const filter = deviceFilter(req.query, params);
    params.push(from);
    try {
        const [rows] = await db.query(
            `SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d') AS day,
                    SUM(GREATEST(delta, 0)) AS energy_counter,
                    SUM(e_power) AS energy_power
             FROM (
                 SELECT recorded_at,
                        energy_kwh - LAG(energy_kwh) ${OVER} AS delta,
                        power_w / 1000 * ${HOURS_SINCE_PREV} AS e_power
                 FROM energy_readings
                 WHERE recorded_at BETWEEN ? AND ? ${filter}
             ) AS t
             WHERE recorded_at >= ?
             GROUP BY day
             ORDER BY day`,
            params
        );
        res.json(
            rows.map((r) => ({
                day: r.day,
                device_id: req.query.device_id ? Number(req.query.device_id) : null,
                energy_kwh: round(num(r.energy_counter) ?? num(r.energy_power), 3)
            }))
        );
    } catch (error) {
        dbError(res, error, 'Błąd liczenia dziennego zużycia energii');
    }
});

module.exports = router;
