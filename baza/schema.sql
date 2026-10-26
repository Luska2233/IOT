-- =====================================================================================
-- Baza danych systemu IoT ZigBee – zigbee_smarthome
-- Model bazy: Osoba 4 (MySQL Workbench, 25.10.2026)
-- Poprawki zgodności z backendem i MariaDB: 26.10.2026
--
-- Zmiany względem wersji wygenerowanej w MySQL Workbench:
--  * usunięte słowo VISIBLE przy indeksach – to składnia MySQL 8; MariaDB 13 ją przyjmuje,
--    ale starsze wersje (np. z Raspberry Pi OS) mogą nie, a bez niego skrypt działa wszędzie,
--  * usunięte zdublowane indeksy kluczy obcych (pokrywa je indeks (device_id, recorded_at)),
--  * users: + full_name, access_zones, access_schedule; username, email i password_hash
--    mogą być NULL (osoba z kartą/PIN-em nie musi mieć konta w aplikacji); rola + SERVICE,
--  * devices: + model, vendor, access_zone,
--  * binary_io_logs: + event_type, raw_action; action_type + DETECTED, CLEARED
--    (obecność, wibracje i alarm też trafiają do tej tabeli),
--  * access_credentials: CHECK – karta musi mieć UID, PIN musi mieć skrót,
--  * access_logs: + user_id, user_name, zone; denial_reason + ZONE_NOT_ALLOWED, OUTSIDE_SCHEDULE,
--  * heat_meter_readings: pola pomiarowe mogą być NULL (brak jednego pola nie odrzuca pomiaru),
--    + battery_percent (historia baterii do szacowania czasu pracy),
--  * nowe tabele: access_signals (sygnalizacja wyniku na czytniku), energy_readings (listwa).
--
-- Wymaga: MariaDB 10.6+ albo MySQL 8.0.16+.
-- Uruchomienie: npm run db:init (szczegóły w baza/README.md).
-- =====================================================================================

SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0;
SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;
SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';

-- -----------------------------------------------------
-- Schema zigbee_smarthome
-- -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS zigbee_smarthome DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci ;
USE zigbee_smarthome ;

-- -----------------------------------------------------
-- Table zigbee_smarthome.`rooms`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`rooms` (
  room_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  floor TINYINT NOT NULL DEFAULT 0,
  description VARCHAR(255) NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id))
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`users`
-- Osoby z dostępem do budynku (karta / PIN). Konto w aplikacji (username, hasło) jest opcjonalne.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`users` (
  user_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL COMMENT 'Imię i nazwisko (panel, dziennik dostępu)',
  username VARCHAR(50) NULL DEFAULT NULL COMMENT 'Login do aplikacji – tylko dla kont z dostępem do panelu',
  email VARCHAR(120) NULL DEFAULT NULL,
  password_hash VARCHAR(255) NULL DEFAULT NULL COMMENT 'Hasło do aplikacji – NULL, jeśli osoba ma tylko kartę/PIN',
  role ENUM('ADMIN', 'USER', 'SERVICE', 'GUEST') NOT NULL DEFAULT 'USER' COMMENT 'ADMIN = administrator, USER = pracownik, SERVICE = serwis, GUEST = gość',
  access_zones JSON NOT NULL COMMENT 'Strefy dostępu, np. ["main","r101"] (main, r101, office, server, tech)',
  access_schedule JSON NOT NULL COMMENT 'Harmonogram, np. {"days":[1,2,3,4,5],"from":"07:00","to":"18:00"}; 0 = niedziela',
  is_active TINYINT NOT NULL DEFAULT TRUE COMMENT '0 = konto zablokowane (np. zgubiona karta)',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE INDEX uq_users_username (username ASC),
  UNIQUE INDEX uq_users_email (email ASC))
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`devices`
-- Wypełniana automatycznie przez backend z listy urządzeń Zigbee2MQTT (zigbee2mqtt/bridge/devices).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`devices` (
  device_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  room_id INT UNSIGNED NULL DEFAULT NULL,
  ieee_address CHAR(23) NOT NULL COMMENT 'Unikalny adres MAC ZigBee np. 0x00158d00045abcde',
  network_address CHAR(6) NULL DEFAULT NULL COMMENT 'Krótki adres sieciowy 16-bit np. 0x1A2B',
  friendly_name VARCHAR(100) NOT NULL COMMENT 'Nazwa wyświetlana w panelu (można ją zmienić)',
  device_type ENUM('GATEWAY', 'ENV_SENSOR', 'BINARY_INPUT', 'BINARY_OUTPUT', 'RGB_LIGHT', 'RFID_KEYPAD', 'HEAT_METER', 'OTHER_SENSOR') NOT NULL,
  model VARCHAR(64) NULL DEFAULT NULL COMMENT 'Model z Zigbee2MQTT, np. TS0505B, SNZB-06P',
  vendor VARCHAR(64) NULL DEFAULT NULL COMMENT 'Producent z Zigbee2MQTT',
  is_custom_module TINYINT NOT NULL DEFAULT FALSE COMMENT 'TRUE dla modułów własnego opracowania',
  mcu_platform VARCHAR(64) NULL DEFAULT NULL COMMENT 'Np. ESP32-C6 / ESP32-H2 / STM32WB / CC2530',
  firmware_version VARCHAR(32) NULL DEFAULT NULL,
  access_zone VARCHAR(20) NULL DEFAULT NULL COMMENT 'Tylko RFID_KEYPAD: strefa otwierana przez czytnik (domyślnie main)',
  lqi TINYINT UNSIGNED NULL DEFAULT NULL COMMENT 'Link Quality Indicator (0-255)',
  battery_percent TINYINT UNSIGNED NULL DEFAULT NULL COMMENT 'Poziom baterii (0-100%), NULL jeśli zasilanie sieciowe',
  is_online TINYINT NOT NULL DEFAULT FALSE,
  last_seen TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  UNIQUE INDEX uq_devices_ieee (ieee_address ASC),
  INDEX idx_device_type (device_type ASC),
  INDEX idx_is_custom (is_custom_module ASC),
  INDEX fk_devices_room (room_id ASC),
  CONSTRAINT fk_devices_room
    FOREIGN KEY (room_id)
    REFERENCES zigbee_smarthome.`rooms` (room_id)
    ON DELETE SET NULL
    ON UPDATE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`env_readings`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`env_readings` (
  reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  temperature_c DECIMAL(5,2) NOT NULL COMMENT 'Temperatura w stopniach Celsjusza',
  humidity_rh DECIMAL(5,2) NOT NULL COMMENT 'Wilgotność względna w %',
  pressure_hpa DECIMAL(6,2) NULL DEFAULT NULL COMMENT 'Opcjonalnie ciśnienie atmosferyczne',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (reading_id),
  INDEX idx_env_device_time (device_id ASC, recorded_at ASC),
  CONSTRAINT fk_env_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`binary_io_logs`
-- Wejścia binarne (przyciski, obecność, wibracje, alarm) i przełączenia wyjść z panelu.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`binary_io_logs` (
  log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  channel TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Numer kanału/przycisku w urządzeniu',
  io_direction ENUM('INPUT', 'OUTPUT') NOT NULL,
  event_type ENUM('BUTTON', 'OCCUPANCY', 'VIBRATION', 'ALARM', 'OUTPUT') NOT NULL DEFAULT 'BUTTON' COMMENT 'Rodzaj zdarzenia (widok Zdarzenia w panelu)',
  state TINYINT NOT NULL COMMENT '1 = Włączony/Wciśnięty/Wykryto, 0 = Wyłączony/Zwolniony/Brak',
  action_type ENUM('SINGLE_CLICK', 'DOUBLE_CLICK', 'HOLD', 'RELEASE', 'TOGGLE', 'SET_ON', 'SET_OFF', 'DETECTED', 'CLEARED') NOT NULL,
  raw_action VARCHAR(32) NULL DEFAULT NULL COMMENT 'Oryginalna akcja z Zigbee2MQTT, np. 2_double',
  triggered_by ENUM('PHYSICAL', 'CLIENT_APP', 'AUTOMATION', 'AI_SCHEDULER') NOT NULL DEFAULT 'PHYSICAL',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (log_id),
  INDEX idx_binary_device_time (device_id ASC, recorded_at ASC),
  INDEX idx_binary_time (recorded_at ASC),
  CONSTRAINT fk_binary_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`lighting_states`
-- Aktualizowana przez backend z raportów żarówki (MQTT).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`lighting_states` (
  device_id INT UNSIGNED NOT NULL,
  is_on TINYINT NOT NULL DEFAULT FALSE,
  brightness TINYINT UNSIGNED NOT NULL DEFAULT 255 COMMENT 'Jasność 0-255',
  color_hex CHAR(7) NOT NULL DEFAULT '#FFFFFF' COMMENT 'Kolor w formacie #RRGGBB',
  color_temp_mired INT UNSIGNED NULL DEFAULT NULL COMMENT 'Temperatura barwowa dla bieli',
  effect_mode ENUM('NONE', 'RAINBOW', 'BREATHE', 'FLASH', 'FIREPLACE', 'CANDLE', 'POLICE') NOT NULL DEFAULT 'NONE',
  effect_speed TINYINT UNSIGNED NOT NULL DEFAULT 128 COMMENT 'Szybkość animacji efektu 0-255',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  CONSTRAINT fk_lighting_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`lighting_presets`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`lighting_presets` (
  preset_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(64) NOT NULL,
  brightness TINYINT UNSIGNED NOT NULL DEFAULT 200,
  color_hex CHAR(7) NOT NULL DEFAULT '#FFA500',
  effect_mode ENUM('NONE', 'RAINBOW', 'BREATHE', 'FLASH', 'FIREPLACE', 'CANDLE', 'POLICE') NOT NULL DEFAULT 'NONE',
  effect_speed TINYINT UNSIGNED NOT NULL DEFAULT 100,
  PRIMARY KEY (preset_id))
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`access_credentials`
-- Identyfikatory osoby: karty RFID i kody PIN (osoba może mieć kilka).
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`access_credentials` (
  credential_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  credential_type ENUM('RFID_TAG', 'PIN_CODE') NOT NULL,
  rfid_uid VARCHAR(32) NULL DEFAULT NULL COMMENT 'UID karty/breloka RFID w HEX, zapisywany jako AA:BB:CC:DD',
  pin_code_hash VARCHAR(255) NULL DEFAULT NULL COMMENT 'Skrót kodu PIN (scrypt z solą) – nigdy sam PIN',
  label VARCHAR(64) NULL DEFAULT NULL COMMENT 'Np. Brelok główny, Karta zapasowa',
  is_active TINYINT NOT NULL DEFAULT TRUE,
  valid_from DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_until DATETIME NULL DEFAULT NULL COMMENT 'Koniec ważności (panel: „Ważne do”)',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (credential_id),
  UNIQUE INDEX uq_cred_rfid (rfid_uid ASC),
  INDEX fk_cred_user (user_id ASC),
  CONSTRAINT chk_cred_value CHECK (
    (credential_type = 'RFID_TAG' AND rfid_uid IS NOT NULL) OR
    (credential_type = 'PIN_CODE' AND pin_code_hash IS NOT NULL)),
  CONSTRAINT fk_cred_user
    FOREIGN KEY (user_id)
    REFERENCES zigbee_smarthome.`users` (user_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`access_logs`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`access_logs` (
  access_log_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL COMMENT 'Urządzenie czytnika RFID / klawiatury',
  credential_id INT UNSIGNED NULL DEFAULT NULL COMMENT 'NULL jeśli użyto nieznanej karty lub błędnego PINu',
  user_id INT UNSIGNED NULL DEFAULT NULL COMMENT 'Osoba – zostaje po usunięciu identyfikatora',
  user_name VARCHAR(100) NULL DEFAULT NULL COMMENT 'Kopia imienia i nazwiska z chwili próby (zostaje po usunięciu osoby)',
  auth_method ENUM('RFID', 'PIN', 'RFID_AND_PIN') NOT NULL,
  raw_identifier VARCHAR(32) NULL DEFAULT NULL COMMENT 'Odczytany UID karty (także nieznanej) albo •••• dla PIN-u',
  zone VARCHAR(20) NULL DEFAULT NULL COMMENT 'Strefa, do której była próba wejścia',
  access_granted TINYINT NOT NULL,
  denial_reason ENUM('NONE', 'UNKNOWN_CREDENTIAL', 'EXPIRED', 'INACTIVE_USER', 'WRONG_PIN', 'ZONE_NOT_ALLOWED', 'OUTSIDE_SCHEDULE') NOT NULL DEFAULT 'NONE',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (access_log_id),
  INDEX idx_access_time (recorded_at ASC),
  INDEX idx_access_user_time (user_id ASC, recorded_at ASC),
  INDEX idx_access_granted (access_granted ASC),
  INDEX fk_access_device (device_id ASC),
  INDEX fk_access_credential (credential_id ASC),
  CONSTRAINT fk_access_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_access_credential
    FOREIGN KEY (credential_id)
    REFERENCES zigbee_smarthome.`access_credentials` (credential_id)
    ON DELETE SET NULL,
  CONSTRAINT fk_access_user
    FOREIGN KEY (user_id)
    REFERENCES zigbee_smarthome.`users` (user_id)
    ON DELETE SET NULL)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`access_signals`
-- Sygnalizacja wyniku weryfikacji na czytniku (kolor diody, komunikat, dźwięk).
-- Pusta tabela = wartości domyślne backendu.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`access_signals` (
  result ENUM('granted', 'denied', 'unknown_card', 'outside_hours', 'blocked') NOT NULL COMMENT 'Wynik weryfikacji',
  color CHAR(7) NOT NULL COMMENT 'Kolor diody #RRGGBB',
  message VARCHAR(120) NOT NULL COMMENT 'Komunikat na czytniku; może zawierać {imie}',
  duration_s TINYINT UNSIGNED NOT NULL DEFAULT 3 COMMENT 'Czas sygnalizacji 1-30 s',
  buzzer ENUM('none', 'short', 'double', 'long') NOT NULL DEFAULT 'short',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (result))
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`heat_meter_readings`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`heat_meter_readings` (
  reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  temp_supply_c DECIMAL(5,2) NOT NULL COMMENT 'Temperatura zasilania [°C]',
  temp_return_c DECIMAL(5,2) NOT NULL COMMENT 'Temperatura powrotu [°C]',
  delta_t_c DECIMAL(5,2) GENERATED ALWAYS AS (temp_supply_c - temp_return_c) VIRTUAL COMMENT 'Różnica temperatur dT [°C]',
  flow_rate_lpm DECIMAL(7,3) NULL DEFAULT NULL COMMENT 'Przepływ chwilowy [l/min]',
  thermal_power_w DECIMAL(9,2) NULL DEFAULT NULL COMMENT 'Chwilowa moc cieplna [W]; liczona z przepływu i dT, gdy moduł jej nie przysyła',
  total_energy_kwh DECIMAL(12,4) NULL DEFAULT NULL COMMENT 'Skumulowana energia cieplna [kWh]',
  total_volume_m3 DECIMAL(12,4) NULL DEFAULT NULL COMMENT 'Skumulowana objętość przepływu [m3]',
  error_flags TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Flagi błędów sprzętowych czujników przepływu/temp',
  battery_percent TINYINT UNSIGNED NULL DEFAULT NULL COMMENT 'Poziom baterii w chwili pomiaru (szacowanie czasu pracy)',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (reading_id),
  INDEX idx_heat_device_time (device_id ASC, recorded_at ASC),
  CONSTRAINT fk_heat_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`energy_readings`
-- Pomiary listwy z pomiarem energii (NOUS A11Z); backend zapisuje maks. 1 wiersz na minutę.
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`energy_readings` (
  reading_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  power_w DECIMAL(8,2) NULL DEFAULT NULL COMMENT 'Moc chwilowa [W]',
  voltage_v DECIMAL(6,2) NULL DEFAULT NULL COMMENT 'Napięcie [V]',
  current_a DECIMAL(7,3) NULL DEFAULT NULL COMMENT 'Prąd [A]',
  energy_kwh DECIMAL(12,4) NULL DEFAULT NULL COMMENT 'Narastający licznik energii [kWh]',
  recorded_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (reading_id),
  INDEX idx_energy_device_time (device_id ASC, recorded_at ASC),
  CONSTRAINT fk_energy_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE)
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`automations`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`automations` (
  automation_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  is_enabled TINYINT NOT NULL DEFAULT TRUE,
  is_ai_generated TINYINT NOT NULL DEFAULT FALSE COMMENT 'TRUE jeśli reguła została wygenerowana przez algorytm AI',
  ai_confidence_score DECIMAL(4,3) NULL DEFAULT NULL COMMENT 'Pewność predykcji AI (0.000 - 1.000)',
  trigger_type ENUM('SENSOR_THRESHOLD', 'TIME_SCHEDULE', 'BUTTON_ACTION', 'ACCESS_EVENT') NOT NULL,
  trigger_config JSON NOT NULL COMMENT 'Warunek uruchomienia np. {"device_id": 2, "metric": "temperature_c", "operator": "<", "value": 20.5}',
  action_config JSON NOT NULL COMMENT 'Akcja docelowa np. {"device_id": 4, "command": "SET_COLOR", "color_hex": "#FF0000"}',
  last_triggered_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (automation_id))
ENGINE = InnoDB;


-- -----------------------------------------------------
-- Table zigbee_smarthome.`command_queue`
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS zigbee_smarthome.`command_queue` (
  command_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id INT UNSIGNED NOT NULL,
  issued_by_user_id INT UNSIGNED NULL DEFAULT NULL,
  command_type VARCHAR(50) NOT NULL COMMENT 'Np. light_color, socket_state, switch_state',
  payload JSON NOT NULL COMMENT 'Parametry rozkazu wysyłane przez bramkę ZigBee',
  status ENUM('PENDING', 'SENT', 'ACKNOWLEDGED', 'FAILED') NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  executed_at TIMESTAMP(3) NULL DEFAULT NULL,
  PRIMARY KEY (command_id),
  INDEX idx_cmd_status (status ASC, created_at ASC),
  INDEX fk_cmd_device (device_id ASC),
  INDEX fk_cmd_user (issued_by_user_id ASC),
  CONSTRAINT fk_cmd_device
    FOREIGN KEY (device_id)
    REFERENCES zigbee_smarthome.`devices` (device_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_cmd_user
    FOREIGN KEY (issued_by_user_id)
    REFERENCES zigbee_smarthome.`users` (user_id)
    ON DELETE SET NULL)
ENGINE = InnoDB;


SET SQL_MODE=@OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;
SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS;
