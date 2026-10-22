-- Frontsmith office: начальная схема учёта одного автосервиса
-- Время: ISO 8601 UTC с суффиксом Z. Деньги: целые копейки + код валюты
-- Удаление рабочих записей не предусмотрено: отмена выполняется статусом

CREATE TABLE business (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  business_type TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  address TEXT,
  time_zone TEXT NOT NULL CHECK (length(time_zone) > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  demo_mode INTEGER NOT NULL CHECK (demo_mode IN (0, 1)),
  booking_url TEXT,
  profile_source TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
  phone TEXT,
  email TEXT,
  note TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE INDEX customers_full_name_idx ON customers (full_name);

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  make TEXT NOT NULL CHECK (length(trim(make)) > 0),
  model TEXT,
  year INTEGER CHECK (year IS NULL OR year BETWEEN 1950 AND 2100),
  mileage_km INTEGER CHECK (mileage_km IS NULL OR mileage_km >= 0),
  vin TEXT CHECK (vin IS NULL OR length(vin) = 17),
  plate TEXT,
  note TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  UNIQUE (id, customer_id)
) STRICT;

CREATE INDEX vehicles_customer_idx ON vehicles (customer_id);
CREATE UNIQUE INDEX vehicles_vin_uidx ON vehicles (vin) WHERE vin IS NOT NULL;

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (length(code) > 0 AND code NOT GLOB '*[^a-z0-9-]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  category TEXT NOT NULL CHECK (length(trim(category)) > 0),
  base_price_kopecks INTEGER CHECK (base_price_kopecks IS NULL OR base_price_kopecks >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_demo_price INTEGER NOT NULL DEFAULT 1 CHECK (is_demo_price IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
) STRICT;

CREATE TABLE inquiries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  vehicle_id TEXT,
  requested_service_id TEXT REFERENCES services (id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('phone', 'website', 'booking_flow', 'walk_in', 'messenger', 'email', 'local_file', 'demo_seed', 'other')),
  external_id TEXT,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  status TEXT NOT NULL CHECK (status IN ('new', 'in_progress', 'waiting_customer', 'converted', 'closed')),
  assignee TEXT,
  received_at TEXT NOT NULL,
  closed_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES vehicles (id, customer_id) ON DELETE RESTRICT,
  CHECK ((status IN ('converted', 'closed')) = (closed_at IS NOT NULL))
) STRICT;

CREATE INDEX inquiries_customer_idx ON inquiries (customer_id);
CREATE INDEX inquiries_vehicle_idx ON inquiries (vehicle_id);
CREATE INDEX inquiries_service_idx ON inquiries (requested_service_id);
CREATE INDEX inquiries_status_received_idx ON inquiries (status, received_at);
CREATE UNIQUE INDEX inquiries_external_uidx ON inquiries (source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE work_orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE CHECK (length(number) > 0),
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  vehicle_id TEXT NOT NULL,
  inquiry_id TEXT REFERENCES inquiries (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'awaiting_approval', 'approved', 'in_progress', 'ready', 'completed', 'cancelled')),
  cost_approval TEXT NOT NULL DEFAULT 'not_requested' CHECK (cost_approval IN ('not_requested', 'requested', 'approved', 'declined')),
  approved_total_kopecks INTEGER CHECK (approved_total_kopecks IS NULL OR approved_total_kopecks >= 0),
  cost_approved_at TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  planned_start_at TEXT,
  planned_end_at TEXT,
  assignee TEXT,
  note TEXT,
  completed_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (vehicle_id, customer_id) REFERENCES vehicles (id, customer_id) ON DELETE RESTRICT,
  CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at > planned_start_at),
  CHECK (status NOT IN ('approved', 'in_progress', 'ready', 'completed') OR cost_approval = 'approved'),
  CHECK ((cost_approval = 'approved') = (approved_total_kopecks IS NOT NULL AND cost_approved_at IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
) STRICT;

CREATE INDEX work_orders_customer_idx ON work_orders (customer_id);
CREATE INDEX work_orders_vehicle_idx ON work_orders (vehicle_id);
CREATE INDEX work_orders_inquiry_idx ON work_orders (inquiry_id);
CREATE INDEX work_orders_status_start_idx ON work_orders (status, planned_start_at);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_orders (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('service', 'part')),
  service_id TEXT REFERENCES services (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  unit_price_kopecks INTEGER NOT NULL CHECK (unit_price_kopecks >= 0),
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks = (unit_price_kopecks * quantity_milli + 500) / 1000),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (service_id IS NULL OR kind = 'service')
) STRICT;

CREATE INDEX order_items_order_idx ON order_items (work_order_id, sort_order);
CREATE INDEX order_items_service_idx ON order_items (service_id);

CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT REFERENCES inquiries (id) ON DELETE RESTRICT,
  work_order_id TEXT REFERENCES work_orders (id) ON DELETE RESTRICT,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('tentative', 'confirmed', 'arrived', 'completed', 'no_show', 'cancelled')),
  confirmation_basis TEXT,
  source TEXT NOT NULL CHECK (source IN ('phone', 'website', 'booking_flow', 'walk_in', 'messenger', 'email', 'demo_seed', 'other')),
  external_id TEXT,
  note TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK (inquiry_id IS NOT NULL OR work_order_id IS NOT NULL),
  CHECK (ends_at > starts_at),
  CHECK (status NOT IN ('confirmed', 'arrived', 'completed') OR length(trim(coalesce(confirmation_basis, ''))) > 0)
) STRICT;

CREATE INDEX appointments_starts_idx ON appointments (starts_at);
CREATE INDEX appointments_inquiry_idx ON appointments (inquiry_id);
CREATE INDEX appointments_order_idx ON appointments (work_order_id);
CREATE UNIQUE INDEX appointments_external_uidx ON appointments (source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  inquiry_id TEXT REFERENCES inquiries (id) ON DELETE RESTRICT,
  work_order_id TEXT REFERENCES work_orders (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  due_at TEXT,
  assignee TEXT,
  completed_at TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((status = 'done') = (completed_at IS NOT NULL))
) STRICT;

CREATE INDEX tasks_status_due_idx ON tasks (status, due_at);
CREATE INDEX tasks_inquiry_idx ON tasks (inquiry_id);
CREATE INDEX tasks_order_idx ON tasks (work_order_id);

CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('business', 'customer', 'vehicle', 'service', 'inquiry', 'work_order', 'order_item', 'appointment', 'task', 'database')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) > 0),
  actor TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  source TEXT NOT NULL CHECK (source IN ('cli', 'import', 'seed', 'migration')),
  summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1))
) STRICT;

CREATE INDEX activity_events_entity_idx ON activity_events (entity_type, entity_id);
CREATE INDEX activity_events_occurred_idx ON activity_events (occurred_at);
