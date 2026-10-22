-- День выполнения не означает выдачу автомобиля и не задаёт вымышленное время суток
ALTER TABLE work_orders ADD COLUMN performed_on TEXT
  CHECK (performed_on IS NULL OR (
    performed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND date(performed_on, '+0 days') IS NOT NULL
    AND date(performed_on, '+0 days') = performed_on));

-- Защита от повторов использует существующий журнал, отдельного хранилища отчётов нет
CREATE UNIQUE INDEX activity_work_report_fingerprint_uidx
  ON activity_events (json_extract(details_json, '$.fingerprint'))
  WHERE action = 'work_report_registered';
