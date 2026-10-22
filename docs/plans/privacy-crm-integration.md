# План интеграции

Опорная записка: [docs/architecture/privacy-crm-integration.md](../architecture/privacy-crm-integration.md).

## Текущее состояние
- Текущий этап: 0. Аудит выполнен, маршрут `codex exec` через локальный шлюз доказан на синтетических данных; реальный upstream не проверен.
- Последний принятый результат: PoC `tools/codex-gateway-poc/` 22.10.2026, результат PASS; до него аудит рабочей копии на ветке `feature/privacy-crm-integration`.
- Следующий шаг: спроектировать доступ шлюза к upstream (API key или OAuth) без копирования секретов владельца.
- База интеграции: `main`. Универсальная часть офиса перенесена из `autoservice` коммитом 78145b1; навык `register-auto-work`, дизайн сайта, логотип и ссылка записи T-Max остаются в `autoservice`.
- Блокирующие вопросы: см. раздел «Блокирующие вопросы».

## Этапы
- [ ] 0. Аудит Frontsmith и проверка маршрута Codex → защитный шлюз.
- [ ] 1. Контракты, идентификаторы, хранилища и разделение доступа.
- [ ] 2. Подключение crmkit и интерфейс работы с клиентами.
- [ ] 3. Privacy Service на основе pii-guard.
- [ ] 4. Единый LLM-сервис и запрет обходных подключений.
- [ ] 5. Разбор отчётов и отображение клиентов в офисной панели.
- [ ] 6. AI-диспетчер для первого выбранного канала.
- [ ] 7. Сквозные проверки, восстановление данных и подготовка выпуска.

### Этап 0: что проверено
- [x] Рабочая офисная панель найдена — `office/`, на момент аудита только в локальной ветке `autoservice`; универсальная часть перенесена в `main` (78145b1)
- [x] Определена офисная SQLite — `.frontsmith/business/office.sqlite` (WAL), путь через `FRONTSMITH_BUSINESS_ROOT`; миграции `office/db/migrations/001–003`
- [x] Составлена карта обращений к LLM — автоматических вызовов в коде обеих веток нет
- [x] Проверен Codex CLI — `codex-cli 0.163.0-alpha.10.2`, `codex exec` доступен, вне `PATH`
- [x] Перечислены чувствительные данные и границы доступа Codex — см. «Результаты аудита»
- [x] Доказана маршрутизация codex exec через custom model provider — `tools/codex-gateway-poc/`, синтетический шлюз на 127.0.0.1
- [x] Доказано прохождение повторного модельного раунда после tool call через gateway — 2 запроса `/v1/responses`, второй с `function_call_output`
- [x] При недоступном gateway Codex не переключается на прямой provider — `turn.failed`, код 1, с повторами и без
- [ ] Доказано отсутствие других сетевых маршрутов — не доказано: `netstat` раз в ~0,2 с видит соединение со шлюзом и не видит посторонних, но короткие соединения и DNS не контролируются
- [ ] Проверен маршрут с реальным upstream — намеренно не выполнялся, сначала нужен способ авторизации шлюза
- [ ] Проверено, какие файлы вне репозитория Codex читает в режиме `workspace-write` — требуется практическая проверка
- [ ] Проверено содержимое свободных текстов в базе на реальные персональные данные — требуется отдельная проверка с согласия владельца

## Результаты аудита

### Ветки и код
- `main` (= `origin/main`, 7d7980d): сайт `website/`, демонстрация `demo/`, CLI-скрипты в `scripts/`, рабочие процессы в `workflows/`, функция Vercel `api/contact.js`. Офисной панели, SQLite, зависимостей и команды `office` нет.
- `autoservice` (локальная, 5 коммитов поверх общей истории, на GitHub отсутствует): `office/` (сервер, панель, слои SQL и операций), `scripts/office.mjs`, `better-sqlite3@12.9.0`, навык Codex `.agents/skills/register-auto-work`, тесты `tests/office.mjs` и `tests/work-reports.mjs`.
- Частные скрипты кастомизации T-Max лежат в игнорируемом `.frontsmith/` (`customize-tmax.mjs`, `finish-tmax.mjs`, `verify-tmax.mjs`).

### Офисная панель (`autoservice`)
- Запуск: `npm run office:serve` → `http://127.0.0.1:4180`; данные: `office:init`, `office:import`, `office:seed`, `office:status`, `office:backup`, `office:restore`, `npm run office -- <команда>`.
- Сервер `office/server.mjs`: только GET/HEAD, только Host `127.0.0.1`/`localhost`, база открыта read-only, CSP. Авторизации и ролей нет; изменения только через CLI и Codex.
- Разделы: обзор с месячным дашбордом, клиенты и автомобили, обращения и заказы, выполненные работы, задачи, услуги и цены, расписание.
- API: `/api/health`, `/api/meta`, `/api/overview`, `/api/customers[/:id]`, `/api/vehicles/:id`, `/api/inquiries[/:id]`, `/api/orders[/:id]`, `/api/tasks`, `/api/services`, `/api/schedule`, `/api/events`. Ответы содержат имена и телефоны клиентов.

### Офисная SQLite
- Схема версии 3: `business`, `customers`, `vehicles`, `services`, `inquiries`, `work_orders`, `order_items`, `appointments`, `tasks`, `activity_events`, `schema_migrations`. ID — UUID (TEXT), таблицы STRICT, FK `ON DELETE RESTRICT`.
- Связи: `customers 1─* vehicles`; `inquiries → customers, vehicles, services`; `work_orders → customers, vehicles, inquiries`; `order_items → work_orders, services`; `appointments` и `tasks → inquiries/work_orders`; `activity_events` без FK.
- Персональные данные хранятся в офисной базе: `customers.full_name` (обязательно), `phone`, `email`, `note`, генерируемый `phone_key`; `vehicles.vin`, `plate`, `plate_key`; свободные тексты `inquiries.description`, `work_orders.note`, `appointments.confirmation_basis`, `activity_events.summary/details_json` (основания и перечни работ из сообщений владельца).
- Текущее наполнение: 27 клиентов, 27 автомобилей, 24 заказа, 285 событий; все клиенты, автомобили и заказы помечены `is_demo = 1`. 21 ремонт зарегистрирован через навык Codex. Содержимое свободных текстов не просматривалось.
- Копии: 5 файлов `office*.sqlite` (+`-wal`/`-shm`) в `.frontsmith/business/backups/`.

### Клиенты и отчёты
- Собственная модель клиента есть: `customers.id` (UUID) — стабильный внутренний идентификатор, на него ссылаются автомобили, обращения и заказы. Кандидат на `client_id` Frontsmith.
- Создание клиента: `customer:add` в CLI; поиск по имени, телефону и email в API; сопоставление `match` по VIN, госномеру и телефону с вердиктами. Форм создания в панели нет.
- Сущности `report_id` нет. Отчёт фиксируется событием `work_report_registered` в `activity_events` с `fingerprint` и уникальным индексом; результат — поля `work_orders.performed_on`, `actual_duration_minutes`, `final_total_kopecks`, `note`.
- Источник обращения: `inquiries.source` (нормализованный список), длительность и стоимость — в `work_orders`.

### Обращения к LLM и Codex
- Автоматических вызовов LLM, `codex exec`, OpenAI API или MCP в коде `main` и `autoservice` нет.
- Фактический маршрут: владелец пишет в приложении Codex → навык `register-auto-work` → `node scripts/office.mjs match/show/report:register` → запись в `office.sqlite`. Текст владельца и результаты команд (имена, телефоны из `match`/`show`) уходят в модель OpenAI через учётную запись ChatGPT без промежуточного слоя.
- Codex также строил отчёт-приложение `.frontsmith/business/reports/october-2026-brands/`, читая `office.sqlite` напрямую через `openOfficeDb({ readonly: true })`.
- Единственная внешняя интеграция кода — Resend в `api/contact.js` (заявки с сайта по email, режимы `dry-run`/`resend`).

### Codex CLI
- `codex.exe` в `%LOCALAPPDATA%\OpenAI\Codex\bin\…`, `CODEX_HOME = D:\CodexData\.codex`, вход через ChatGPT.
- `config.toml`: `model = "gpt-6.1-sol"`, `sandbox_mode = "workspace-write"`, `windows.sandbox = "unelevated"`, проект `d:\codex_project\frontsmith` в режиме `trusted`; `model_provider` и `model_providers` не заданы.
- `codex exec` поддерживает `-c key=value`, `--profile`, `--ignore-user-config`, `--oss`/`--local-provider`, `--sandbox`, `--json`, `--output-schema`, `--ephemeral`. Бинарник содержит ключи `model_providers`, `base_url`, `openai_base_url`, `env_key`, `wire_api`, `requires_openai_auth`, `supports_websockets`; строка `chat/completions` отсутствует, поэтому шлюзу, вероятно, нужен Responses API. Практически не проверено.
- Включены плагины и MCP с внешним доступом: `vk@personal` (`vk-local`), `browseros-neo`, браузер, Chrome, computer use, Slack, Google Calendar, функция `memories`.

### Граница доступа Codex
| Класс данных | Есть | Путь | Может ли прочитать Codex |
| --- | --- | --- | --- |
| Офисная SQLite и WAL/SHM | есть | `.frontsmith/business/office.sqlite*` | да, внутри рабочей области, запись тоже |
| Копии базы | есть | `.frontsmith/business/backups/` | да, внутри рабочей области |
| Контакты клиентов | есть, в офисной базе | `customers` | да, отдельного CRM нет |
| Таблицы соответствий | нет | — | — |
| Ключи LLM | есть, у Codex | `D:\CodexData\.codex\auth.json` | вероятно да: `workspace-write` ограничивает запись, не чтение; не проверено |
| Env-файлы проекта | нет | только `.env.example` | — |
| Секреты в `.frontsmith/` | не найдены поиском шаблонов | — | — |
| История сессий Codex | есть | `D:\CodexData\.codex\sessions`, `thread_history_1.sqlite`, `logs_2.sqlite`, `memories_1.sqlite` | да; содержит прежние сообщения владельца |
| Вложения | каталог пуст | `.frontsmith/business/files/` | да |
| Конфигурация Codex и MCP | есть | `D:\CodexData\.codex\config.toml` | да |

### PoC маршрута Codex через шлюз
- Конфигурация: изолированный `CODEX_HOME`, `model_provider` с `base_url = "http://127.0.0.1:<port>/v1"`, `wire_api = "responses"`, `env_key`, `requires_openai_auth = false`, `supports_websockets = false`; плагины, приложения, браузер, computer use, память и история отключены. Пример: `tools/codex-gateway-poc/codex-home.config.example.toml`.
- Протокол: один `POST /v1/responses` со `stream: true` на модельный раунд, SSE до `response.completed`; полная история в `input` без `previous_response_id`; инструмент оболочки `exec_command` с параметром `cmd`. Запросов `/models` и WebSocket не было.
- Шлюз получает `Authorization: Bearer` со значением из `env_key`, поэтому может подставлять собственные учётные данные upstream, не показывая их агенту.
- Без `windows.sandbox = "unelevated"` вызовы `exec_command` отклоняются политикой.
- Временный `CODEX_HOME` после запуска содержит служебные SQLite, `.sandbox` и системные навыки; для агентного процесса нужна политика очистки.

### Инфраструктура
- Node 24.19.0, npm 11.17.0. Python и Go не установлены. Docker 29.6.2 установлен, демон не запущен.
- Docker Compose, reverse proxy и контейнеров в репозитории нет. Порты: 4173 сайт, 4174 демонстрация, 4180 панель офиса, 4192 отчёт-приложение.
- Развёртывание: Vercel (`vercel.json`) только для демонстрации и `api/contact.js`. Миграции применяет `office:init` с контрольными суммами. CI: `npm install`, `npm run check`, `npm run build:demo`, `npm test`.
- Логичные места для будущих сервисов: `services/` рядом с `office/` в ветке-основе, запуск через отдельный Compose-файл в `deploy/`; crmkit (Go) и pii-guard (Python) — контейнерами, так как рантаймов на машине нет.

### Статус блоков опорной архитектуры
| Блок | Статус |
| --- | --- |
| Офисная панель | ЧАСТИЧНО ЕСТЬ — только чтение, только ветка `autoservice` |
| Office SQLite | УЖЕ ЕСТЬ — с персональными данными внутри |
| Внутренний `client_id` | ЧАСТИЧНО ЕСТЬ — `customers.id` UUID |
| `report_id` | НЕТ |
| Клиентский модуль | ЧАСТИЧНО ЕСТЬ — CLI, поиск и `match`, без форм |
| CRM abstraction / ContactsProvider | НЕТ |
| Privacy Service | НЕТ |
| pii-guard | НЕТ |
| Единый LLM gateway | НЕТ |
| Автоматический Codex runner | НЕТ |
| Разграничение доступа к PII | НЕТ |
| Очередь обработки | НЕТ |
| Журнал AI-заданий | ЧАСТИЧНО ЕСТЬ — `activity_events` с актором Codex, без статусов заданий |
| Отображение клиента по ID | ЧАСТИЧНО ЕСТЬ — панель соединяет имя из той же базы |
| AI-диспетчер | НЕТ |
| Внешние каналы | ЧАСТИЧНО ЕСТЬ — Resend для заявок; плагин VK подключён к Codex вне кода проекта |

### Рекомендация по `report_id`
Добавить отдельную таблицу отчётов в офисную базу со ссылкой на `work_orders.id` и `customers.id` и статусами из раздела 12.3 записки; `fingerprint` из `activity_events` перенести в неё как ключ идемпотентности. Авторитетная пара `report_id → client_id` дублируется в приватном хранилище заданий. В этом задании ничего не добавлено.

## Блокирующие вопросы
1. ~~База интеграции~~ — решено: `main`, универсальная часть `office/` перенесена 22.10.2026. Ветки ещё не опубликованы на GitHub.
2. Персональные данные уже в офисной базе (`customers.full_name` обязателен). Перенос контактов в CRM означает изменение схемы и очистку свободных текстов и копий; нужно решение владельца о порядке миграции.
3. История Codex в `D:\CodexData\.codex` уже содержит сообщения владельца; отдельный `CODEX_HOME` для агентного процесса проверен в PoC, политика очистки основного не решена.
4. Плагины Codex с внешним доступом (VK, браузеры, Slack, Calendar, computer use) включены в основном `CODEX_HOME`; в изолированном PoC они отключены флагами `[features]`.
5. Python и Go отсутствуют, Docker не запущен: нужно решить, где разворачивать pii-guard и crmkit.
6. Способ авторизации шлюза на upstream (API key или OAuth ChatGPT) не выбран; без него маршрут с реальной моделью не проверить.
