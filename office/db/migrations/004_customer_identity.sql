-- frontsmith: foreign_keys=off
-- Frontsmith office: клиент — только стабильный client_id, контакты — у CustomerProvider (crmkit)
-- Пересборка таблиц по процедуре SQLite (новая таблица → копия → замена) при выключенных FK;
-- migrate() проверяет foreign_key_check до фиксации. Данные не удаляются

-- 1. Контакты прежних клиентов уходят из таблицы идентичности в карантин. Отсюда их
--    переносит в CRM только явная команда npm run crm:migrate-customers, удаляя строку
--    после сохранения связи. Новые клиенты сюда не попадают
CREATE TABLE legacy_customer_contacts (
  client_id TEXT PRIMARY KEY REFERENCES customers (id) ON DELETE RESTRICT,
  full_name TEXT,
  phone TEXT,
  email TEXT,
  note TEXT,
  captured_at TEXT NOT NULL
) STRICT;

INSERT INTO legacy_customer_contacts (client_id, full_name, phone, email, note, captured_at)
  SELECT id, full_name, phone, email, note, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM customers;

-- 2. Таблица идентичности: id остаётся прежним UUID и родителем бизнес-записей
CREATE TABLE customers_identity (
  id TEXT PRIMARY KEY,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

INSERT INTO customers_identity (id, is_demo, created_at, updated_at, revision)
  SELECT id, is_demo, created_at, updated_at, revision FROM customers;

DROP TABLE customers;
ALTER TABLE customers_identity RENAME TO customers;

-- 3. Связь client_id ↔ запись во внешнем хранилище контактов. Без имён, телефонов и email.
--    provider_instance — рабочая область crmkit или подключение внешней CRM
CREATE TABLE customer_provider_links (
  client_id TEXT NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (length(provider) > 0 AND provider NOT GLOB '*[^a-z0-9_-]*'),
  provider_instance TEXT NOT NULL CHECK (length(trim(provider_instance)) > 0),
  external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (client_id, provider, provider_instance),
  UNIQUE (provider, provider_instance, external_id)
) STRICT;

CREATE INDEX customer_provider_links_client_idx ON customer_provider_links (client_id);

-- 4. Журнал: изменения из панели получают собственный источник
CREATE TABLE activity_events_v4 (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('business', 'customer', 'vehicle', 'service', 'inquiry', 'work_order', 'order_item', 'appointment', 'task', 'database')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  source TEXT NOT NULL CHECK (source IN ('cli', 'import', 'seed', 'migration', 'panel')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
) STRICT;

INSERT INTO activity_events_v4 SELECT id, occurred_at, entity_type, entity_id, action, actor, source, summary, details_json, is_demo FROM activity_events ORDER BY rowid;
DROP TABLE activity_events;
ALTER TABLE activity_events_v4 RENAME TO activity_events;

CREATE INDEX activity_events_entity_idx ON activity_events (entity_type, entity_id);
CREATE INDEX activity_events_occurred_idx ON activity_events (occurred_at);
CREATE UNIQUE INDEX activity_work_report_fingerprint_uidx
  ON activity_events (json_extract(details_json, '$.fingerprint'))
  WHERE action = 'work_report_registered';
