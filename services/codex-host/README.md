# Codex Host

Доверенный компонент Frontsmith между модулями офиса (будущие reports, dispatcher, analytics) и Frontsmith-controlled Codex App Server. Статус: PoC.

```text
вызывающий модуль
   ↓ исходный текст
Codex Host ──prepare──► Privacy Service (pii-guard + NER)
   ↓ псевдонимизированный текст
codex app-server (stdio, отдельный CODEX_HOME)
   ↓
Codex по подписке ChatGPT
   ↓ ответ с <PII .../>
Codex Host ──restore──► Privacy Service
   ↓ ответ для адресата (в thread не возвращается)
```

## Состав

- `app-server-client.mjs` — JSON-RPC по stdio дочернего `codex app-server`; WebSocket — отладочный режим.
- `codex-host.mjs` — `CodexHost`: `start` (readiness Privacy Service, `initialize`), `openConversation`/`resumeConversation` (privacy-session + thread), `send` (prepare → `turn/start` → события → restore), инструменты Host через `dynamicTools` и `item/tool/call`, отклонение всех запросов одобрения.
- `privacy-client.mjs` — только `readiness`, `createSession`, `prepare`, `restoreFinalForRecipient`. Методов получения mapping или исходных значений нет.
- `codex-home.mjs` — отдельный `CODEX_HOME` (`%LOCALAPPDATA%\Frontsmith\codex-host\home`), `config.toml` без оболочки, плагинов, браузера, памяти и истории; окружение процесса по белому списку без `OPENAI_API_KEY`.
- `login.mjs` — вход ChatGPT в отдельный `CODEX_HOME`. API key не принимается.
- `smoke.mjs` — реальный сквозной прогон по подписке.
- `testing/` — двойники App Server и Privacy Service для `npm test`, тестовый инструмент `get_test_customer`.

## Команды

```bash
npm run test:codex-host
```

```bash
npm run test:codex-host:app-server
```

```bash
npm run codex-host:login
```

```bash
npm run smoke:codex-host -- --docker
```

`test:codex-host` входит в `npm test`. `test:codex-host:app-server` запускает установленный `codex app-server` с синтетической локальной моделью и проверяет фактические HTTP-запросы к модели. `smoke:codex-host` тратит лимиты подписки и в `npm test` не входит; без Docker, Privacy Service или входа завершается `SKIPPED` (код 2).

## Границы

- Всё, что видит модель, проходит `prepare`: ввод пользователя и результаты инструментов Host. Ошибка Privacy Service — `privacy_processing_failed`, `turn/start` не вызывается.
- `restore` вызывается после `turn/completed`; восстановленный текст возвращается вызывающему и в thread не отправляется.
- Workspace агента — отдельный пустой каталог вне репозитория. Встроенных инструментов оболочки у модели нет: в фактическом запросе к модели только `request_user_input` и инструменты Host.
- Диагностический журнал (`%LOCALAPPDATA%\Frontsmith\codex-host\logs`) хранит SHA-256, длину и число тегов, без текста.
- Codex Desktop запускает собственный App Server и этот Host не использует.
