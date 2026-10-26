-- =====================================================================================
-- Dane startowe bazy zigbee_smarthome (można uruchamiać wielokrotnie – nie nadpisuje zmian).
-- Urządzeń tu nie ma: backend dodaje je sam z listy Zigbee2MQTT (zigbee2mqtt/bridge/devices).
-- =====================================================================================

USE zigbee_smarthome ;

-- Przykładowe pomieszczenia – dopasujcie nazwy do laboratorium.
-- Przypisanie urządzenia: UPDATE devices SET room_id = 2 WHERE friendly_name = 'czujnik_sala';
INSERT IGNORE INTO rooms (room_id, name, floor, description) VALUES
  (1, 'Recepcja', 0, 'Wejście główne'),
  (2, 'Sala 101', 1, 'Sala laboratoryjna'),
  (3, 'Biuro 102', 1, NULL),
  (4, 'Korytarz', 1, NULL),
  (5, 'Serwerownia', 1, 'Strefa o ograniczonym dostępie'),
  (6, 'Węzeł cieplny', 0, 'Ciepłomierz');

-- Domyślna sygnalizacja wyniku weryfikacji na czytniku (edycja w panelu: Kontrola dostępu → Sygnalizacja).
INSERT IGNORE INTO access_signals (result, color, message, duration_s, buzzer) VALUES
  ('granted',       '#22c55e', 'Dostęp przyznany. Witaj, {imie}!', 3, 'short'),
  ('denied',        '#ef4444', 'Odmowa dostępu', 4, 'long'),
  ('unknown_card',  '#f59e0b', 'Nieznana karta – zgłoś się do recepcji', 4, 'double'),
  ('outside_hours', '#8b5cf6', 'Poza godzinami dostępu', 4, 'double'),
  ('blocked',       '#64748b', 'Konto zablokowane – skontaktuj się z administratorem', 5, 'long');
