# Privacy Service

Обёртка Frontsmith над Python API [pii-guard](https://github.com/redmadrobot-rnd/pii-guard) с сохранением состояния псевдонимизации между сообщениями. Статус: PoC.

## Зависимости

Версии зафиксированы в `runtime.mjs` (`PINS`) и `requirements.lock`:

- pii-guard commit `24230abb72949a9f85499244dd4f15a0ad0cdd9e` (версия пакета 0.1.0), extra `ner`. Исходники лежат без изменений в `vendor/pii-guard/source`; дополнения Frontsmith — отдельно, в `frontsmith_privacy/`.
- NER `redmadrobot-rnd/rubert-base-pii-ner` ревизии `c802e8cd26f85d1cf920973ea6f83965a0618d63`: веса, конфигурация и токенизатор в `vendor/ner-model/rubert-base-pii-ner` (Git LFS). Сервис загружает модель из этого каталога, Hugging Face не используется (`HF_HUB_OFFLINE=1`).
- spaCy `ru_core_news_sm` 3.8.0, torch CPU, Python 3.11.14, uv 0.12.24.
- Windows: MSVC runtime из пакета `msvc-runtime` в venv (torch требует `msvcp140.dll`); подпись Microsoft проверяется при подготовке.

## Runtime без Docker

Сервис — локальный процесс Python, который запускает Node-процесс Frontsmith. Docker, системный Python, venv и pip вручную не нужны.

```bash
npm run privacy:bootstrap
```

сверяет поставку с `vendor/manifest.json`, распаковывает uv и Python из `vendor/runtime-assets`, создаёт venv и ставит `requirements.lock` без сети (`uv pip sync --offline --no-index` по wheelhouse, pii-guard собирается из `vendor/pii-guard/source`) и проверяет `/health`. Ничего не скачивается. Runtime лежит в каталоге данных Frontsmith вне Git:

```text
<каталог данных>\runtime\{uv,python,privacy-env,tmp}
<каталог данных>\privacy\privacy.sqlite      состояние сессий, права только пользователя
```

Каталог данных выбирается при первом `npm run bootstrap` (по умолчанию `%LOCALAPPDATA%\Frontsmith`, выбор запоминается в `%LOCALAPPDATA%\Frontsmith\data-root.txt`). Установки, подготовленные до поставки в `vendor/`, продолжают работать без переустановки.

Обычно сервис поднимает `npm run ai:start` вместе с Codex App Server. Отдельно для диагностики: `npm run privacy:start` (127.0.0.1:4310, токен генерируется на запуск).

## API

| Метод | Назначение | Ответ |
| --- | --- | --- |
| `GET /health` | готовность | `status`, `ready`, `reasons`, `pii_guard_version`, `pii_guard_commit`, `ner_enabled`, `available_entity_types`, `state_store_ready` |
| `POST /sessions` | новая privacy-session компании | `privacy_session_id`, `model_instructions` |
| `POST /sessions/{id}/prepare` | псевдонимизация текста пользователя или инструмента | `text`, `replacements`, `entity_types`, `version` |
| `POST /sessions/{id}/restore` | восстановление ответа модели для адресата | `text` |

Все методы, кроме `/health`, требуют `Authorization: Bearer $PRIVACY_SERVICE_TOKEN`. Операций выдачи mapping, `normalized_text`, исходных значений или дампа сессии нет.

## Поведение

- Состояние pii-guard (`PseudonymizationState`) сериализуется в явный JSON-формат `pii-guard-state/1` и сохраняется в приватной SQLite (`<данные Frontsmith>/privacy/privacy.sqlite`) с `tenant_id`, `version`, `created_at`, `updated_at` до возврата результата. Pickle не используется.
- Сессия обрабатывается под блокировкой; запись проверяет `version`, параллельное изменение даёт 409.
- После псевдонимизации текст сверяется со всеми исходными значениями сессии; совпадение блокирует ответ.
- `restore` использует mapping только этой сессии и только для адресатов из `PRIVACY_RESTORE_RECIPIENTS` (по умолчанию `operator`). Чужие и придуманные теги заменяются на `****`.
- Fail closed: без NER, без `PERSON`/`PHONE_NUMBER`, без хранилища, без токена или при ошибке pii-guard сервис `not_ready`, а `prepare` отвечает 503.
- Журнал содержит события, счётчики и типы сущностей, без текста.

- Имена: разметка pii-guard дополняется словами вплотную к PERSON, которые морфологически являются именем, фамилией или отчеством, и словами, чья нормальная форма совпадает с частью имени, уже известного сессии (`frontsmith_privacy/persons.py`). Причина — реальный пропуск NER: «Что мы знаем про Ивана Петрова?» → PERSON только для «Ивана». Оставшаяся в тексте известная часть имени блокирует ответ.

## Тесты

```bash
npm run test:privacy
```

Запускает на управляемом runtime: pytest (логика сервиса; настоящий pii-guard с NER — формы «Иван Петров», «Ивана Петрова», «Ивану Петрову», «с Иваном Петровым», «про Ивана Петрова», телефоны `+7 916 123-45-67`, `8 916 123 45 67`, `+7(916)1234567`, `89161234567`, две реплики одной сессии, изоляция сессий), затем настоящий процесс сервиса и fail closed через CodexHost с двойником App Server: ошибка pii-guard на `prepare`, остановленный процесс, незагруженные веса NER, недоступная SQLite — `turn/start` не вызывается. Без подготовленного runtime команда завершается FAIL с подсказкой `npm run privacy:bootstrap`.

Шифрование состояния в хранилище в PoC не реализовано: каталог состояния вне Git и рабочей области Codex, доступ только текущему пользователю.
