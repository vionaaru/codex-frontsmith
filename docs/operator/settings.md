# Справочник настроек

Все изменяемые данные — в `.frontsmith/business/`: профиль, SQLite, копии, настройки, клиентские документы и рабочий сайт в `website/`. Каталог целиком игнорируется Git. `FRONTSMITH_BUSINESS_ROOT` может указывать вне проекта или в `.frontsmith/`; отслеживаемые каталоги использовать для данных нельзя. SQL-миграции остаются в `office/db/migrations/`, дизайн сайта — в корневом `website/`.

При переходе на это размещение существующая база не перемещается и не пересоздаётся. Перед переходом создайте SQLite-копию через `office:backup` и сохраните прежнюю версию сайта. Для отката кода сохраняйте каталог данных целиком. Старые версии `update:website` снова меняют отслеживаемый сайт, поэтому не запускайте их без отдельной проверки.

Имена ключей, путей и переменных — технические идентификаторы. Не переводите их: скрипты обращаются к ним по точному имени. Описания и значения для людей задавайте по-русски.

## Настройки продукта

`frontsmith.config.json` описывает состав набора. Фактическое поведение реализовано в скриптах; изменение декларации само по себе не добавляет возможностей.

| Поле | Назначение |
| --- | --- |
| `product`, `version` | Название и версия продукта |
| `defaultBlueprint` | Базовый сценарий бизнеса из `blueprints/` |
| `defaultWorkspace` | Приватный каталог бизнеса `.frontsmith/business/` |
| `primaryInterface` | Основной интерфейс: Codex |
| `deployableOutput` | Исходники публикуемого сайта: `website/` |
| `defaultCapabilities` | Базовые возможности, перечисленные ниже |
| `extensionCandidates` | Возможные будущие расширения |
| `safety.liveActionsDefault` | Внешние действия отключены по умолчанию (`disabled`) |
| `safety.ownerApprovalRequired` | Обязательное согласие владельца (`true`) |
| `safety.neuraConnectedMode` | Подключённый режим Neura необязателен (`optional`) |

Идентификаторы базовых возможностей:

| Значение | Возможность |
| --- | --- |
| `business-setup` | Настройка бизнеса |
| `owner-brief` | Сводка владельца |
| `website` | Сайт |
| `customer-desk` | Работа с клиентами |
| `ongoing-customer-communication` | Постоянное общение с клиентами |
| `estimates-proposals` | Сметы и предложения |
| `launch-plan` | План запуска |
| `activity-log` | Журнал действий |
| `settings-integrations` | Настройки и интеграции |
| `extension-planning` | Планирование расширений |
| `connected-action-receipts` | Записи предлагаемых внешних действий |

Кандидаты расширений: `reviews-proof` — отзывы и подтверждения; `marketing` — маркетинг; `social-posting` — соцсети; `payments` — платежи; `invoices` — счета; `accounting` — бухгалтерия. Они не входят в базовую v1.0.

## Профиль бизнеса

`npm run bootstrap` читает `blueprints/auto-service/business.example.json` и создаёт `.frontsmith/business/business.json`. Начальный сценарий — локальная демонстрация автосервиса «АвтоРитм» с восемью услугами. Рабочий профиль — общий источник услуг, цен, контактов, записи и материалов сайта.

| Поле | Что указать |
| --- | --- |
| `businessName`, `businessType` | Название и тип бизнеса |
| `brandTagline`, `tagline`, `summary` | Подпись бренда, заголовок и краткое описание сайта |
| `websiteUrl` | Адрес сайта; для локальной демонстрации `http://localhost:4173` |
| `demoMode`, `blueprint` | Учебный режим (`true`) и сценарий `auto-service` |
| `currency`, `timeZone` | Валюта `RUB` и часовой пояс `Europe/Moscow` |
| `bookingUrl`, `bookingLabel` | Внешняя ссылка записи `https://example.com/booking` и подпись кнопок; URL допускает только HTTP/HTTPS без учётных данных |
| `hours.label`, `hours.days`, `hours.start`, `hours.end`, `hours.weekend` | Часы работы: Пн–Пт, 09:00–18:00; суббота и воскресенье — выходные |
| `pricingPolicy.mode`, `pricingPolicy.note`, `pricingPolicy.ownerApprovedForLiveQuotes` | Цены демонстрационные (`demo`), пояснение к ним и отсутствие одобрения реальных предложений (`false`) |
| `serviceAreas` | Список территорий обслуживания |
| `services[].name`, `services[].description` | Название и описание каждой услуги |
| `services[].id`, `services[].category` | Стабильный идентификатор услуги и техническая категория: `diagnostics`, `maintenance`, `repair` |
| `services[].priceFrom` | Цена от: `0` — бесплатно; положительное число — цена от в валюте профиля; `null` — по согласованию |
| `services[].durationMinutes` | Ориентировочная длительность в минутах; отсутствие значения — время уточняется |
| `services[].includes`, `services[].image` | Состав услуги и изображение; карточки берут данные из этого же профиля |
| `media` | Пути или URL изображений: `heroImage` — главное, `heroImageAlt` — его русское описание, `socialImage` — соцсети, `craftImage`, `faqImage`, `contactImage` — дополнительные разделы. Старые поля `kitchenImage`, `bathroomImage`, `livingImage` сохранены для совместимости с прежними CLI-флагами |
| `contact.phone`, `contact.email` | Телефон и email бизнеса |
| `contact.city`, `contact.state`, `contact.address` | Город, регион и адрес мастерской |
| `integrations.booking` | `external_link` — внешняя ссылка; `localImportEnabled: false` — импорт заявок отключён |
| `integrations.email`, `integrations.calendar`, `integrations.neura` | Почта `disabled`; календарь и Neura `not_connected`. Декларация не подключает аккаунты |
| `brandVoice` | Правила тона общения |
| `approvalPolicy.ownerApprovalRequiredForLiveActions` | Требуется ли согласие на внешние действия |
| `approvalPolicy.liveActionsDefault` | Внешние действия по умолчанию отключены |

После изменения профиля выполните `npm run update:website`, затем `npm run first-run:status` и `npm run owner:brief`. Профиль АвтоРитм остаётся учебным, пока владелец не предоставит и не согласует реальные сведения. `update:website` переносит весь каталог, цены, длительности и ссылку записи без сброса этих полей. Повторный `npm run bootstrap` не перезаписывает существующий профиль. Явная замена: `npm run business:init -- --profile ПУТЬ-К-ПРОФИЛЮ.json`. Прежние CLI-флаги поддерживаются и переопределяют только явно переданные поля; `--services` заменяет каталог, поэтому для сохранения всех восьми услуг его не передавайте. `npm run business:init -- --reset` удаляет весь прежний каталог бизнеса, включая рабочие записи; `npm run bootstrap` этот флаг отклоняет.

`FRONTSMITH_BUSINESS_ROOT` может переопределить каталог данных для тестов или отдельного рабочего окружения. Исходники сайта при этом остаются в `website/`.

## Внешняя запись

`bookingUrl` открывает отдельную закрытую демонстрацию Booking Flow. Она может запросить пароль; не записывайте учётные данные в профиль или другие файлы проекта. API-синхронизация, импорт заявок и связь с локальным календарём отсутствуют. Демонстрационные цены Frontsmith и цены Booking Flow могут различаться. Для изменения названия кнопки используйте `bookingLabel`, для изменения адреса — `bookingUrl` в рабочем профиле, затем выполните `npm run update:website`.

## Доставка заявок

В учебной демонстрации АвтоРитм почта отключена, календарь не подключён. Реальная отправка, подключение сервисов и публикация не нужны для локального показа. Следующие настройки относятся к отдельно согласованному рабочему запуску.

`.env.example` содержит подписанные примеры; это не рабочие секреты. Сервер читает переменные окружения. Для локального предпросмотра задайте их в терминале, для публикации — в настройках Vercel. Скрипты не загружают `.env` автоматически.

| Переменная | Назначение |
| --- | --- |
| `CONTACT_DELIVERY_MODE` | `dry-run` — без отправки; `disabled` — отключено; `resend` — реальная доставка |
| `CONTACT_TO_EMAIL` | Получатель заявок |
| `CONTACT_FROM_EMAIL` | Отправитель с подтверждённым доменом |
| `CONTACT_SUBJECT_PREFIX` | Русское начало темы письма, например «Заявка с сайта» |
| `FRONTSMITH_TENANT_ID` | Техническая метка бизнеса в доставке |
| `RESEND_API_KEY` | Секретный ключ Resend, только на сервере |

Пробный режим в PowerShell:

```powershell
$env:CONTACT_DELIVERY_MODE = "dry-run"
npm run preview:website
```

## Сборка и подключения

`package.json` хранит команды npm, версию Node и метаданные пакета. `vercel.json` задаёт статический build `dist/frontsmith-demo`, чистые URL, перенаправления и лимит времени обработчика формы. `blueprints/auto-service/business.example.json` хранит начальный профиль АвтоРитм; `blueprints/local-service/blueprint.json` сохраняет описание общего сервисного сценария и требуемых полей.

Локальные настройки интеграций находятся в `.frontsmith/business/settings/integrations.md`. Изменение этого файла не подключает аккаунты. JSON-записи в `connected-actions/` содержат машинные статусы `dry_run`, `not_approved` и `blocked`: пробный режим, отсутствие согласования и запрет выполнения. Их Markdown-пары объясняют состояние по-русски.

Публикация, настройка домена и сервисов, отправка клиентам и подключённые действия требуют явного согласия владельца.
