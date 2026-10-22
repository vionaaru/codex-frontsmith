-- Frontsmith office: факты выполненных работ и ключи сопоставления автомобиля
-- Только добавление колонок, индексов и триггеров: данные 001 не переписываются

-- Фактические трудозатраты и итоговая стоимость заказа. Известны только после работ,
-- поэтому допустимы лишь в статусах «Готов к выдаче» и «Выдан».
-- Итог хранится отдельно от позиций: распределение между работами и запчастями может быть неизвестно
ALTER TABLE work_orders ADD COLUMN actual_duration_minutes INTEGER
  CHECK (actual_duration_minutes IS NULL OR (actual_duration_minutes BETWEEN 1 AND 525600 AND status IN ('ready', 'completed')));

ALTER TABLE work_orders ADD COLUMN final_total_kopecks INTEGER
  CHECK (final_total_kopecks IS NULL OR (final_total_kopecks >= 0 AND status IN ('ready', 'completed')));

-- completed_at может задаваться задним числом из отчёта, поэтому формат проверяется базой
CREATE TRIGGER work_orders_completed_at_insert BEFORE INSERT ON work_orders
WHEN NEW.completed_at IS NOT NULL AND NOT (
  NEW.completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z'
  AND julianday(NEW.completed_at) IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'work_orders.completed_at: ожидается ISO 8601 UTC с суффиксом Z');
END;

CREATE TRIGGER work_orders_completed_at_update BEFORE UPDATE OF completed_at ON work_orders
WHEN NEW.completed_at IS NOT NULL AND NOT (
  NEW.completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]*Z'
  AND julianday(NEW.completed_at) IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'work_orders.completed_at: ожидается ISO 8601 UTC с суффиксом Z');
END;

CREATE INDEX work_orders_completed_idx ON work_orders (completed_at) WHERE completed_at IS NOT NULL;

-- VIN уже уникален (vehicles_vin_uidx). Сопоставление требует канонической записи: заглавные, без I, O, Q
CREATE TRIGGER vehicles_vin_insert BEFORE INSERT ON vehicles
WHEN NEW.vin IS NOT NULL AND NEW.vin GLOB '*[^A-HJ-NPR-Z0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'vehicles.vin: 17 заглавных латинских букв и цифр без I, O, Q');
END;

CREATE TRIGGER vehicles_vin_update BEFORE UPDATE OF vin ON vehicles
WHEN NEW.vin IS NOT NULL AND NEW.vin GLOB '*[^A-HJ-NPR-Z0-9]*'
BEGIN
  SELECT RAISE(ABORT, 'vehicles.vin: 17 заглавных латинских букв и цифр без I, O, Q');
END;

-- Ключ госномера: без пробелов и дефисов, кириллица номерного алфавита заменена латиницей, заглавными.
-- «х 000 хх 77» и «X000XX77» дают один ключ. Номер не уникален: он переходит между машинами.
-- Правило продублировано в plateKey() из office/lib/domain.mjs, тест сверяет их
ALTER TABLE vehicles ADD COLUMN plate_key TEXT GENERATED ALWAYS AS (nullif(upper(
  replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
  replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
  replace(replace(replace(coalesce(plate, ''), ' ', ''), '-', ''), char(160), ''),
  'А', 'A'), 'В', 'B'), 'Е', 'E'), 'К', 'K'), 'М', 'M'), 'Н', 'H'), 'О', 'O'), 'Р', 'P'), 'С', 'C'), 'Т', 'T'), 'У', 'Y'), 'Х', 'X'),
  'а', 'A'), 'в', 'B'), 'е', 'E'), 'к', 'K'), 'м', 'M'), 'н', 'H'), 'о', 'O'), 'р', 'P'), 'с', 'C'), 'т', 'T'), 'у', 'Y'), 'х', 'X')
  ), '')) VIRTUAL;

CREATE INDEX vehicles_plate_key_idx ON vehicles (plate_key) WHERE plate_key IS NOT NULL;

-- Ключ телефона: только цифры, российский номер приводится к 7XXXXXXXXXX.
-- Номера короче 10 цифр и записи с буквами (например, «доб.») ключа не получают.
-- Телефон не уникален: один номер бывает у нескольких членов семьи.
-- Правило продублировано в phoneKey() из office/lib/domain.mjs, тест сверяет их
ALTER TABLE customers ADD COLUMN phone_key TEXT GENERATED ALWAYS AS (CASE
  WHEN replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '') GLOB '*[^0-9]*'
    OR length(replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '')) < 10 THEN NULL
  WHEN length(replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '')) = 10
    THEN '7' || replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '')
  WHEN length(replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '')) = 11
    AND substr(replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), ''), 1, 1) = '8'
    THEN '7' || substr(replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), ''), 2)
  ELSE replace(replace(replace(replace(replace(replace(replace(coalesce(phone, ''), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), char(160), '')
END) VIRTUAL;

CREATE INDEX customers_phone_key_idx ON customers (phone_key) WHERE phone_key IS NOT NULL;

-- Проверка уже сохранённых строк новыми триггерами: при нарушении миграция откатывается целиком
UPDATE work_orders SET completed_at = completed_at WHERE completed_at IS NOT NULL;
UPDATE vehicles SET vin = vin WHERE vin IS NOT NULL;
