# Czytnik RFID (ESP32-C6) w Zigbee2MQTT

Konwerter `rfid_access.mjs` uczy Zigbee2MQTT obsługi własnego czytnika RFID
(firmware `rfid_zigbee`, Basic: `PabloDIY` / `RFID_ACCESS`). Bez niego Z2M widzi
urządzenie jako „nieobsługiwane” i nie przekazuje UID karty do backendu.

## Jak to działa

```
karta → ESP32-C6 (EP2, klaster 0xFC00, atrybut 0x0000 = UID)
      → koordynator → Zigbee2MQTT + rfid_access.mjs
      → MQTT  zigbee2mqtt/<nazwa>      {"card_uid": "04A1B2C3", "scan_id": …}
      → backend (mqtt.js → handleAccess) sprawdza bazę, zapisuje access_logs
      → MQTT  zigbee2mqtt/<ieee>/set   {"access_result": "granted", …}
      → Zigbee2MQTT zapisuje atrybut 0x0002 (1 = otwórz, 2 = odmowa)
      → ESP: zielona LED + przekaźnik albo czerwona LED
```

Czytnik czeka na decyzję 3 s (`DECISION_TIMEOUT_MS` w `main.c`). Po tym czasie
miga 3× na czerwono („brak odpowiedzi z sieci”).

## Instalacja w działającym Zigbee2MQTT

Gdy Z2M, Mosquitto, baza i backend już działają (np. na Raspberry Pi w laboratorium):

1. Pobierz zmiany z repozytorium: `git pull`.
2. Skopiuj `zigbee2mqtt/rfid_access.mjs` do folderu `external_converters` obok
   `configuration.yaml` Zigbee2MQTT (zwykle `/opt/zigbee2mqtt/data/external_converters/`
   na Linuksie albo `C:\zigbee2mqtt\data\external_converters\` na Windows).
3. W `configuration.yaml` w sekcji `advanced:` ustaw (klucz może wystąpić **tylko raz**):
   ```yaml
   advanced:
     enable_external_js: true
   ```
   Od Z2M 2.11 nowe instalacje mają to domyślnie wyłączone.
4. Zrestartuj Zigbee2MQTT (`sudo systemctl restart zigbee2mqtt` albo Ctrl+C i `pnpm start`).
   W logu nie może być `External JS (converters/extensions) is disabled`.
5. Sparuj czytnik (niżej). Jeśli był sparowany wcześniej, w panelu Z2M kliknij
   przy nim **Reconfigure**.
6. Zrestartuj backend (`npm start`). Urządzenie doda się samo do tabeli `devices`
   jako `RFID_KEYPAD` (pole `card_uid` w „exposes”).

## Parowanie czytnika

1. Panel Z2M (port 8080) → **Permit join (All)**.
2. Wyczyść pamięć sieci w ESP i wgraj firmware (folder `rfid_zigbee`, terminal ESP-IDF):
   ```
   idf.py -p COMx erase-flash flash monitor
   ```
3. W monitorze: `Dolaczono do sieci Zigbee`. W Z2M urządzenie **RFID_ACCESS (PabloDIY)**
   z polami `card_uid`, `scan_id`, `access_result` i przełącznikiem.

## Test

1. Przyłóż kartę. Backend wypisze `[DOSTĘP] …: nieznany → unknown_card`, czytnik mignie na czerwono.
2. Panel aplikacji → Kontrola dostępu → Użytkownicy: dodaj użytkownika z tym UID
   i strefą `main` (albo strefą z `devices.access_zone` czytnika).
3. Przyłóż kartę ponownie → `granted`, zielona LED i przekaźnik na 3 s.

## Nowa instalacja na Windows (od zera)

| Program | Instalacja |
|---|---|
| Node.js **24 LTS** | nodejs.org (instalator .msi, bez „Automatically install the necessary tools”). Z2M 2.14 wymaga Node `^22.2 \|\| ^24 \|\| <=26.2`. |
| MariaDB | mariadb.org/download (MSI), hasło `root`, usługa `MariaDB`, port 3306 |
| Mosquitto | mosquitto.org/download (Windows x64), potem `net start mosquitto` jako administrator |
| Koordynator | ESP32-C6 z firmware ZBOSS: install.busware.de/zboss/ (Chrome/Edge) |
| Zigbee2MQTT | `cd C:\` → `git clone --depth 1 https://github.com/Koenkk/zigbee2mqtt.git` → `cd zigbee2mqtt` → `npm install -g --allow-scripts=pnpm pnpm` → `pnpm install --frozen-lockfile` → `pnpm run build` → `pnpm start` |

Pierwszy start Z2M otwiera konfigurację na http://localhost:8080: port COM koordynatora,
adapter `zboss`, MQTT `mqtt://localhost:1883`, base topic `zigbee2mqtt`. Potem kroki
z sekcji „Instalacja w działającym Zigbee2MQTT”.

Backend (ten folder):
```
copy <plik .env od zespołu> .env      # DB_PASSWORD musi pasować do MariaDB
npm install
npm run db:init
npm start                              # http://localhost:3000
```

Frontend (folder `frontend` z repozytorium panelu): `npm install`, `npm run dev` → http://localhost:5173.

## Typowe problemy

| Objaw | Przyczyna |
|---|---|
| Z2M: `configuration.yaml is invalid` | powtórzony klucz (np. dwa razy `enable_external_js`) albo złe wcięcia |
| Z2M: `External JS … is disabled` | brak `advanced.enable_external_js: true` |
| Z2M: `Unsupported engine` | Node spoza listy wspieranych – zainstaluj Node 24 |
| Czytnik miga 3× na czerwono | brak odpowiedzi w 3 s: backend nie działa, nie ma połączenia z MQTT albo czytnik nie jest w sieci |
| Backend: `Nieznane urządzenie` | urządzenia nie ma w `devices` (sprawdź `AUTO_REGISTER_DEVICES`) |
