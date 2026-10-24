# План интеграции

Опорная записка: [docs/architecture/privacy-crm-integration.md](../architecture/privacy-crm-integration.md).

## Текущее состояние
- Текущий этап: универсальный профиль по умолчанию закрыт. Чистая установка создаёт цифровой офис `generic-service` (пустые клиенты и услуги, нейтральный сайт, панель без отраслевых разделов); автосервис — отдельный профиль `auto-service` при явном выборе; существующие установки не перенастраиваются; новые копии офисной базы — вне рабочей области Codex.
- Последний принятый результат: универсальный профиль 24.10.2026 (`npm run check`, `npm test`, `npm run test:first-run`, `npm run test:crm`); до него first-run 23.10.2026 (`npm run test:first-run` на пустом каталоге данных, `npm test` — PASS); до него Customer Module 23.10.2026 (`npm test`, `npm run test:crm` на настоящем crmkitd, `npm run smoke:crm-codex` на настоящем pii-guard и Codex по подписке — PASS); до него Privacy Service без Docker (PASS), PoC `services/privacy/` + `services/codex-host/` (PARTIAL), PoC `tools/codex-gateway-poc/` (PASS) и аудит.
- Следующий шаг: перевести оставшиеся универсальные модули Frontsmith на CustomerProvider, затем — универсальный AI-диспетчер.
- База интеграции: `main`. Универсальная часть офиса перенесена из `autoservice` коммитом 78145b1; навык `register-auto-work`, дизайн сайта, логотип и ссылка записи T-Max остаются в `autoservice`.
- Блокирующие вопросы: см. раздел «Блокирующие вопросы».

## Этапы
- [ ] 0. Аудит Frontsmith и проверка маршрута Codex → защитный шлюз.
- [ ] 1. Контракты, идентификаторы, хранилища и разделение доступа.
- [x] 2. Подключение crmkit и интерфейс работы с клиентами — универсальный Customer Module, crmkit v0.9.1 без Docker и Go.
- [x] 3. Privacy Service на основе pii-guard — локальный процесс без Docker, настоящий pii-guard + NER, сквозной прогон по подписке.
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

### Этап 2: Customer Module на crmkit
- [x] crmkit автоматически bootstrap-ится без Docker/Go — `npm run crm:bootstrap`: релиз v0.9.1 windows-amd64, SHA-256 зафиксирован и сверен с checksums.txt, `<data-root>/runtime/crmkit/0.9.1/`, повтор ничего не скачивает
- [x] crmkit запускается Frontsmith автоматически — `ensureCrm` в `office:serve`, CLI и `ai:start`; только 127.0.0.1; `npm run crm:start` для отдельного запуска
- [x] Реализован универсальный CustomerProvider — `office/customers/contract.mjs`
- [x] Реализован CrmkitProvider — `office/customers/crmkit-provider.mjs`
- [x] Frontsmith сохраняет независимый client_id — прежний `customers.id` (UUID), не ID контакта crmkit
- [x] Реализована provider-link модель — `customer_provider_links`, миграция 004
- [x] Создание клиента работает через CustomerProvider — идемпотентно по `client_id`, восстановление после сбоя по `custom.frontsmith_client_id`
- [x] Редактирование клиента работает через CustomerProvider — с версией и 409 при параллельной правке
- [x] Frontsmith UI имеет список/поиск/карточку/создание/редактирование — проверено в браузере на учебной базе
- [x] Новые business records используют только client_id — подписи добавляет сервер через `resolveDisplayData`, журнал без имён
- [x] PII отсутствуют в business storage — новый клиент: 0 совпадений в ячейках и байтах файла; `phone_key` удалён
- [x] Migration старой customer-модели проверена на fixture — `npm run crm:migrate-customers`, двойник и настоящий crmkitd: тот же client_id, FK целы, ПД 0
- [x] Trusted CRM tool проходит через Privacy Service — `get_customer_context`, `npm run smoke:crm-codex` PASS
- [x] Перенос рабочей `office.sqlite` в CRM — выполнен владельцем 23.10.2026: один учебный клиент, `client_id` сохранён, связь и контакт в crmkit есть, панель получает контакт из CRM, `foreign_key_check` пуст, `integrity_check` ok, ПД клиента в офисной базе 0 совпадений; копия после переноса `office:backup`
- [ ] Резервирование business / CRM / privacy state одним согласованным процессом — не реализовано

### First-run
- [x] Один bootstrap готовит Frontsmith без Docker/Python/Go вручную — `npm run bootstrap`: Privacy runtime, crmkit, CRM, профиль, офисная база, проверки, итоговый статус
- [x] Bootstrap идемпотентен — повтор не скачивает, не меняет базу, профиль, CRM, учётные данные и privacy state (сверка SHA-256 в тесте)
- [x] Чистая установка сразу использует CustomerProvider/crmkit — клиентов 0, учебные клиенты только `npm run office:seed`
- [x] Чистая business DB никогда не получает customer PII — все миграции до схемы 4 одной командой до первого клиента; `customers` без контактных колонок, карантин пуст
- [x] Legacy installation определяется, но не мигрируется автоматически — контакты в `customers` (до 004) или в `legacy_customer_contacts`; копия до миграции схемы — в `<data-root>/crm/backups/`
- [x] Один `npm run frontsmith` запускает необходимые сервисы — crmkit, Privacy Service, Codex App Server (при входе ChatGPT), офис `http://127.0.0.1:4180`
- [x] Корректный shutdown завершает дочерние процессы — офис, App Server, Privacy Service, crmkit; порты свободны, PID завершены
- [x] Первый клиент создаётся через CustomerProvider — API панели → CrmkitProvider → crmkit → `client_id`
- [x] `test:first-run` проходит на пустом data-root — скачивает ~2 ГБ, первый старт NER на 6 ГБ RAM ~6,5 мин
- [x] README содержит короткий пользовательский first-run
- [ ] Вход ChatGPT в first-run проверен только как «sign-in required»; путь AI после единого старта покрыт `test:codex-host` и `smoke:crm-codex`
- [x] Профиль по умолчанию — универсальный `generic-service` (см. «Универсальный профиль»)

### Универсальный профиль
- [x] Чистая установка создаёт `generic-service` — `defaultBlueprint` в `frontsmith.config.json`; компания «Новая компания» как поле для заполнения, услуг и клиентов 0, демо-режима нет
- [x] В профиле нет АвтоРитм, автомобилей, VIN, автомобильного каталога, заказ-нарядов и демонстрационных клиентов; сайт из нейтрального шаблона `blueprints/generic-service/website/index.html`
- [x] Отраслевые разделы панели включает профиль — `officeModules` в `blueprint.json`, `/api/meta → modules`; generic скрывает автомобили, заказы и выполненные работы, отсутствующие разделы не открываются и не вызывают ошибок
- [x] `auto-service` сохранён и работает при явном выборе — `npm run bootstrap -- --blueprint auto-service`, `npm run business:init -- --blueprint auto-service`; автосервисные тесты без изменений поведения
- [x] CustomerProvider, crmkit, Privacy Service и Codex App Server не зависят от профиля; отраслевые таблицы в CustomerProvider не переносились
- [x] Существующая установка сохраняет профиль — bootstrap создаёт `business.json` только при отсутствии, `--blueprint` на существующей установке не применяется, профиль без поля `blueprint` считается автосервисом со всеми разделами; рабочая установка «Тмаксавто» (`auto-service`) не менялась
- [x] Новые копии офисной базы — в `<data-root>/backups/office/`, `--to` внутрь репозитория отклоняется
- [x] Перенос прежних копий подготовлен — `npm run backups:relocate` (план) и `-- --confirm` (копирование с SHA-256 вместе с WAL/SHM, исходники не удаляются)
- [x] Тесты — `tests/generic-profile.mjs` в `npm test`; `test:first-run` проверяет generic, auto-service, повторный bootstrap и копии на настоящих crmkit и pii-guard, runtime берёт из готового каталога данных через junction
- [x] Прежние копии рабочей установки убраны из рабочей области по решению владельца 24.10.2026 — отправлены в корзину Windows без переноса в каталог данных (блокирующий вопрос 2)
- [ ] Подписи категорий услуг и статусы «Оформлен заказ» в словаре обращений остаются общими для обоих профилей

### Этап 3: Privacy Service перед Codex App Server
- [x] Privacy Service запускается с настоящим pii-guard + NER без Docker — `npm run privacy:bootstrap`: uv 0.12.24 → Python 3.11.14 → venv по `requirements.lock` → веса NER c802e8c; `/health ready`, NER=true
- [x] PERSON проверен на настоящем pii-guard — «Иван Петров», «Ивана Петрова», «Ивану Петрову», «с Иваном Петровым», «про Ивана Петрова» (последняя форма — с дополнением имён Frontsmith, NER сам размечает только «Ивана»)
- [x] PHONE_NUMBER проверен на настоящем pii-guard — `+7 916 123-45-67`, `8 916 123 45 67`, `+7(916)1234567`, `89161234567`, с восстановлением
- [x] Session state проверен с настоящим pii-guard — `pii-guard-state/1` в privacy SQLite, изоляция сессий, восстановление только своей сессии
- [x] Двухходовый тест с настоящим pii-guard пройден — тот же PERSON-тег во втором сообщении, «Иван»/«Петров» отсутствуют, restore локальный
- [x] Codex App Server работает через ChatGPT subscription — отдельный `CODEX_HOME`, вход ChatGPT, API key не использовался
- [x] Полный сквозной smoke-test пройден — `npm run smoke:codex-host`: codex-cli 0.163.0-alpha.11.2, stdio, 12 PASS; исходных ПД в `turn/start` и tool result нет
- [x] Trusted tool → Privacy Service → Codex проверен — `get_test_customer` в smoke
- [x] Fail-closed проверен на настоящем Privacy Service — ошибка pii-guard на `prepare`, остановленный процесс, незагруженные веса NER, недоступная SQLite: `turn/start` = 0 (`npm run test:privacy`)
- [x] User input и tool output очищаются до модели, mapping недоступен Codex, restore только после `turn/completed` — PoC 22.10.2026

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
- Копии (на момент аудита): 5 файлов `office*.sqlite` (+`-wal`/`-shm`) в `.frontsmith/business/backups/`. С 24.10.2026 новые копии создаются в `<data-root>/backups/office/`.

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
| Копии базы | есть | прежние — `.frontsmith/business/backups/`; новые — `<data-root>/backups/office/` | прежние — да; новые — нет, вне репозитория |
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
- Node 24.19.0, npm 11.17.0. Системных Python и Go нет; Python для Privacy Service ставит `npm run privacy:bootstrap` в каталог данных Frontsmith. Docker в установке не используется.
- Docker Compose, reverse proxy и контейнеров в репозитории нет. Порты: 4173 сайт, 4174 демонстрация, 4180 панель офиса, 4192 отчёт-приложение.
- Развёртывание: Vercel (`vercel.json`) только для демонстрации и `api/contact.js`. Миграции применяет `office:init` с контрольными суммами. CI: `npm install`, `npm run check`, `npm run build:demo`, `npm test`.
- Сервисы — в `services/` рядом с `office/`, запускаются Node-хостом как локальные процессы (`npm run ai:start`); контейнеров нет. Место crmkit (Go) не решено.

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
2. ~~Персональные данные в рабочей офисной базе~~ — перенесены в crmkit 23.10.2026. Прежние копии в `.frontsmith/business/backups/`: две учебные (6 клиентов «Демо-клиент», синтетические телефоны) вынесены в `D:\Frontsmith\backups\legacy-demo-office\`; `office-20261017-145808Z.sqlite` (27 учебных клиентов, 21 отчёт владельца о работах) и каталоги `tmax-before-customization-*` оставлены: нельзя доказать, что там только учебные данные. 24.10.2026 `npm run backups:relocate` показывает в рабочей области 5 единиц: `office-20261017-145808Z.sqlite` и `office-20261023-092949Z.sqlite` (SQLite + WAL/SHM), два каталога `tmax-before-customization-*` (профиль и база SQLite), `website-before-data-split-20261017` (сайт). Новые копии туда больше не пишутся. По решению владельца все 5 единиц отправлены в корзину Windows 24.10.2026; `.frontsmith/business/backups/` пуст. Окончательное удаление (очистка корзины) — за владельцем.
3. История Codex в `D:\CodexData\.codex` уже содержит сообщения владельца; отдельный `CODEX_HOME` для агентного процесса проверен в PoC, политика очистки основного не решена.
4. Плагины Codex с внешним доступом (VK, браузеры, Slack, Calendar, computer use) включены в основном `CODEX_HOME`; в изолированном PoC они отключены флагами `[features]`.
5. ~~Python для pii-guard~~ — решено: управляемый runtime `npm run privacy:bootstrap` (uv, Python, venv в каталоге данных Frontsmith), Docker не нужен. ~~Место crmkit (Go)~~ — решено: бинарный релиз в `<data-root>/runtime/crmkit/`, база в `<data-root>/crm/`.
6. ~~Способ авторизации шлюза на upstream~~ — решено: API key запрещён, модельный контур — Codex App Server с подпиской ChatGPT (записка, 11.4).
7. Текущая `office.sqlite` без контактов клиентов; свободные тексты и оставшиеся прежние копии не проверены на ПД.
