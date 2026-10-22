# Privacy Service

Обёртка Frontsmith над Python API [pii-guard](https://github.com/redmadrobot-rnd/pii-guard) с сохранением состояния псевдонимизации между сообщениями. Статус: PoC.

## Зависимости

- pii-guard commit `24230abb72949a9f85499244dd4f15a0ad0cdd9e` (версия пакета 0.1.0), extra `ner`. Исходники не копируются, ядро не меняется.
- NER `redmadrobot-rnd/rubert-base-pii-ner` ревизии `c802e8cd26f85d1cf920973ea6f83965a0618d63`, веса запекаются в образ, при старте `HF_HUB_OFFLINE=1`.
- spaCy `ru_core_news_sm`, torch CPU.

## API

| Метод | Назначение | Ответ |
| --- | --- | --- |
| `GET /health` | готовность | `status`, `ready`, `reasons`, `pii_guard_version`, `pii_guard_commit`, `ner_enabled`, `available_entity_types`, `state_store_ready` |
| `POST /sessions` | новая privacy-session компании | `privacy_session_id`, `model_instructions` |
| `POST /sessions/{id}/prepare` | псевдонимизация текста пользователя или инструмента | `text`, `replacements`, `entity_types`, `version` |
| `POST /sessions/{id}/restore` | восстановление ответа модели для адресата | `text` |

Все методы, кроме `/health`, требуют `Authorization: Bearer $PRIVACY_SERVICE_TOKEN`. Операций выдачи mapping, `normalized_text`, исходных значений или дампа сессии нет.

## Поведение

- Состояние pii-guard (`PseudonymizationState`) сериализуется в явный JSON-формат `pii-guard-state/1` и сохраняется в приватной SQLite (`/data/privacy.sqlite`, том Docker) с `tenant_id`, `version`, `created_at`, `updated_at` до возврата результата. Pickle не используется.
- Сессия обрабатывается под блокировкой; запись проверяет `version`, параллельное изменение даёт 409.
- После псевдонимизации текст сверяется со всеми исходными значениями сессии; совпадение блокирует ответ.
- `restore` использует mapping только этой сессии и только для адресатов из `PRIVACY_RESTORE_RECIPIENTS` (по умолчанию `operator`). Чужие и придуманные теги заменяются на `****`.
- Fail closed: без NER, без `PERSON`/`PHONE_NUMBER`, без хранилища, без токена или при ошибке pii-guard сервис `not_ready`, а `prepare` отвечает 503.
- Журнал содержит события, счётчики и типы сущностей, без текста.

## Запуск и тесты

```bash
PRIVACY_SERVICE_TOKEN=<случайное значение> docker compose -f services/privacy/compose.yml up -d --build
```

```bash
npm run test:privacy
```

`test:privacy` собирает образ, запускает pytest в контейнере (логика сервиса и настоящий pii-guard с NER) и проверяет, что образ с `PII_GUARD_NER_DISABLED=1` объявляет себя `not_ready`. Если демон Docker выключен, тесты помечаются `SKIPPED`.

Шифрование состояния в хранилище в PoC не реализовано: том Docker защищается правами хоста.
