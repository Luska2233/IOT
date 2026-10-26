# Baza danych `zigbee_smarthome`

Model bazy przygotował **Osoba 4** (MySQL Workbench). Tutaj jest jego skrypt z poprawkami, dzięki którym pasuje do backendu i panelu oraz działa zarówno na MySQL 8, jak i na MariaDB (Raspberry Pi).

| Plik | Zawartość |
|---|---|
| [schema.sql](schema.sql) | tabele, klucze, indeksy (na początku pliku lista zmian względem wersji z Workbencha) |
| [dane_startowe.sql](dane_startowe.sql) | przykładowe pomieszczenia i domyślna sygnalizacja czytnika |
| [init.js](init.js) | wykonuje oba pliki – `npm run db:init` |

Oba pliki SQL można uruchamiać wielokrotnie: `CREATE TABLE IF NOT EXISTS` i `INSERT IGNORE` niczego nie nadpisują. Uwaga: ponowne uruchomienie **nie zmienia** już istniejących tabel – po zmianie schematu trzeba je zaktualizować (`ALTER TABLE`) albo usunąć bazę i utworzyć ją od nowa.

## Uruchomienie

### Raspberry Pi (Raspberry Pi OS / Debian)

```bash
sudo apt install mariadb-server
sudo mysql
```

W konsoli MariaDB utwórz użytkownika dla backendu (hasło wymyślcie własne):

```sql
CREATE USER 'zigbee'@'localhost' IDENTIFIED BY 'haslo_backendu';
GRANT ALL PRIVILEGES ON zigbee_smarthome.* TO 'zigbee'@'localhost';
FLUSH PRIVILEGES;
```

W pliku `.env` backendu ustaw `DB_USER=zigbee` i `DB_PASSWORD=haslo_backendu`, a następnie w katalogu backendu:

```bash
npm run db:init
```

Na Raspberry Pi użytkownik `root` loguje się bez hasła tylko przez `sudo` (unix_socket), dlatego backend potrzebuje osobnego użytkownika.

### Windows (komputer deweloperski)

MariaDB z winget (hasło `root` jak w `.env`):

```bash
winget install --id MariaDB.Server -e --silent --custom "PASSWORD=root SERVICENAME=MariaDB PORT=3306"
```

Potem w katalogu backendu: `npm run db:init`. Na Windows MariaDB działa jako usługa „MariaDB” (uruchamiana razem z systemem).

### MySQL Workbench

Można też otworzyć `schema.sql`, a potem `dane_startowe.sql` w Workbenchu i wykonać (błyskawica). Wynik jest taki sam.

## Urządzenia dodają się same

Tabeli `devices` nie trzeba wypełniać ręcznie. Gdy backend połączy się z brokerem, Zigbee2MQTT wysyła listę sparowanych urządzeń (`zigbee2mqtt/bridge/devices`), a backend dodaje nowe do bazy: adres IEEE, nazwę, typ (`device_type` zgadnięty z tego, co urządzenie udostępnia), model i producenta. Wyłączenie: `AUTO_REGISTER_DEVICES=false` w `.env`.

Po rejestracji warto:

```sql
-- ładniejsza nazwa w panelu
UPDATE devices SET friendly_name = 'Czujnik T/H – sala 101' WHERE ieee_address = '0xa4c138f1e2d30001';
-- przypisanie do pomieszczenia (tabela rooms)
UPDATE devices SET room_id = 2 WHERE ieee_address = '0xa4c138f1e2d30001';
-- czytnik RFID otwierający inną strefę niż wejście główne
UPDATE devices SET access_zone = 'server' WHERE device_type = 'RFID_KEYPAD' AND friendly_name LIKE '%serwerownia%';
-- moduły własne
UPDATE devices SET mcu_platform = 'ESP32-C6' WHERE is_custom_module = 1;
```

Zmiana `friendly_name` w bazie nie wpływa na Zigbee2MQTT – backend rozpoznaje urządzenia po adresie IEEE.

## Co zmieniono względem wersji z Workbencha i dlaczego

| Tabela | Zmiana | Powód |
|---|---|---|
| wszystkie | usunięte `VISIBLE` przy indeksach | składnia MySQL 8; MariaDB 13 ją przyjmuje, ale starsze wersje (np. z Raspberry Pi OS) mogą nie |
| wszystkie | usunięte zdublowane indeksy FK (`fk_env_device` itd.) | pokrywa je indeks `(device_id, recorded_at)` |
| `users` | + `full_name`, `access_zones` (JSON), `access_schedule` (JSON) | wymaganie „różne prawa dostępu”: strefy i godziny dla każdej osoby |
| `users` | `username`, `email`, `password_hash` mogą być NULL | osoba z kartą/PIN-em nie musi mieć konta w aplikacji ani e-maila |
| `users` | rola + `SERVICE` | panel ma rolę „Serwis” (pomieszczenia techniczne, także poza godzinami) |
| `devices` | + `model`, `vendor`, `access_zone` | rozpoznawanie typu w panelu, karta urządzenia, strefa czytnika |
| `binary_io_logs` | + `event_type`, `raw_action`; `action_type` + `DETECTED`, `CLEARED` | do tej tabeli trafiają też obecność, wibracje i alarm; `raw_action` zachowuje np. `2_double` z pilota |
| `access_credentials` | CHECK: karta ma UID, PIN ma skrót | spójność danych |
| `access_logs` | + `user_id`, `user_name`, `zone`; powody + `ZONE_NOT_ALLOWED`, `OUTSIDE_SCHEDULE` | po usunięciu osoby jej identyfikatory znikają (CASCADE) – bez tych kolumn dziennik traciłby informację, kto wszedł; brakowało powodów odmowy dla stref i godzin |
| `heat_meter_readings` | pola pomiarowe mogą być NULL, + `battery_percent` | brak jednego pola (np. objętości) odrzucał cały pomiar; historia baterii do szacowania czasu pracy |
| nowa | `access_signals` | wymaganie „sygnalizacja kolorami i komunikatami” – konfiguracja z panelu |
| nowa | `energy_readings` | pomiary listwy NOUS A11Z (dzienne zużycie energii) |

Bez zmian: `rooms`, `env_readings`, `lighting_states`, `lighting_presets`, `automations`, `command_queue`. Jednostki kolegi zostały (przepływ w l/min, moc w W) – backend przelicza je dla panelu.

## Jak backend używa tabel

| Tabela | Zapis | Odczyt |
|---|---|---|
| `devices` | rejestracja z Z2M, `last_seen`, `lqi`, `battery_percent`, `is_online` | lista urządzeń, stan |
| `env_readings` | temperatura i wilgotność z MQTT | Środowisko, Pulpit, Raporty |
| `binary_io_logs` | przyciski, obecność, wibracje, alarm; przełączenia z panelu (OUTPUT) | Zdarzenia, analiza obecności |
| `lighting_states` | stan żarówki z MQTT | `/api/lighting` |
| `heat_meter_readings` | pomiary ciepłomierza | Ciepłomierz, Raporty |
| `energy_readings` | pomiary listwy (maks. 1/min) | dzienne zużycie energii |
| `users`, `access_credentials` | panel: Kontrola dostępu → Użytkownicy | decyzja przy czytniku |
| `access_logs` | każda próba dostępu | dziennik, raport dostępu użytkownika |
| `access_signals` | panel: Kontrola dostępu → Sygnalizacja | odpowiedź do czytnika |
| `command_queue` | każda komenda z panelu (`PENDING` → `SENT`/`FAILED`, `executed_at`) | historia komend |
| `rooms` | ręcznie / dane startowe | nazwa pomieszczenia urządzenia |
| `automations`, `lighting_presets` | – | `/api/automations` (na przyszłość) |

## Typowe problemy

- **`ER_ACCESS_DENIED_ERROR`** – złe `DB_USER` / `DB_PASSWORD` w `.env` (na Raspberry Pi nie używajcie `root`).
- **`ECONNREFUSED` przy `db:init`** – serwer bazy nie działa (`sudo systemctl start mariadb`, na Windows usługa „MariaDB”).
- **Panel: „Backend z błędami”, w dymku „brakuje tabeli …”** – baza była tworzona starszym skryptem; uruchomcie `npm run db:init` albo dodajcie brakującą tabelę/kolumnę.
- **Pomiary się nie zapisują** – sprawdźcie w konsoli backendu komunikat „Nieznane urządzenie …”: urządzenia nie ma w `devices` (np. `AUTO_REGISTER_DEVICES=false`), albo ma w Zigbee2MQTT nazwę ze znakiem `/` (backend obsługuje nazwy bez `/`).
- **Przesunięte godziny na wykresach** – MariaDB i system muszą mieć tę samą strefę czasową (`SELECT @@time_zone, @@system_time_zone;`).
