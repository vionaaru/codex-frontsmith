# PoC: маршрут `codex exec` через локальный gateway

Исследовательский код, не production gateway. Доказывает, что все модельные запросы `codex exec`, включая раунд после выполнения инструмента, идут в указанный нами `base_url`, а при недоступном gateway Codex завершается ошибкой без перехода на OpenAI.

Всё синтетическое: gateway сам отвечает заранее подготовленными Responses-событиями, внешних запросов нет, офисная база и `.frontsmith/business/` не используются.

## Состав

- `gateway.mjs` — Node HTTP-сервер на `127.0.0.1`, endpoint `POST /v1/responses` (SSE). Журнал JSONL без заголовков: только `has_authorization`, путь, модель, `stream`, типы элементов `input`, имена инструментов, размер и SHA-256 тела.
- `codex-home.config.example.toml` — минимальный `config.toml` изолированного `CODEX_HOME` без секретов.
- `fixture.txt` — синтетический файл для теста с инструментом.
- `run-poc.mjs` — три теста с реальным `codex exec` во временном `CODEX_HOME`.
- `gateway.test.mjs` — синтетический тест gateway без Codex.

## Запуск

```bash
npm run test:gateway-poc
```

```bash
node tools/codex-gateway-poc/run-poc.mjs
```

`run-poc.mjs` ищет `codex.exe` в `%LOCALAPPDATA%\OpenAI\Codex\bin\*\` или берёт путь из `CODEX_BIN`. Временный каталог удаляется после запуска; `--keep` оставляет его вместе с журналом gateway.

Ручной запуск gateway: `node tools/codex-gateway-poc/gateway.mjs` (порт `POC_GATEWAY_PORT`, по умолчанию 4199; журнал `POC_GATEWAY_LOG`, по умолчанию `runtime/gateway.jsonl`, игнорируется Git).

## Конфигурация, которая сработала

Проверено на `codex-cli 0.163.0-alpha.10.2` с `--strict-config`:

```toml
model = "poc-model"
model_provider = "frontsmith_poc"

[model_providers.frontsmith_poc]
name = "Frontsmith PoC gateway"
base_url = "http://127.0.0.1:<port>/v1"
wire_api = "responses"
env_key = "FRONTSMITH_POC_KEY"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0

[windows]
sandbox = "unelevated"
```

Полный пример с отключёнными плагинами, приложениями, браузером, памятью и историей — в `codex-home.config.example.toml`.

Команда запуска:

```bash
CODEX_HOME=<временный каталог> FRONTSMITH_POC_KEY=<фиктивное значение> codex exec --strict-config --ephemeral --skip-git-repo-check --sandbox read-only -C <каталог с fixture.txt> --json "Прочитай fixture.txt и верни его содержимое."
```

## Наблюдённый протокол

- Один `POST /v1/responses` на модельный раунд, `stream: true`, заголовок `Authorization: Bearer <значение env_key>`. Запросов к `/models` и WebSocket нет.
- Codex принимает SSE-события `response.created`, `response.output_item.added`, `response.output_text.delta`, `response.output_item.done` и `response.completed` с `response.id` и `usage`.
- Вызов инструмента — элемент `function_call` с `name`, `call_id` и `arguments` (JSON-строка). Инструмент оболочки — `exec_command` с параметром `cmd`.
- Следующий раунд передаёт полную историю в `input` (`message`…, `function_call`, `function_call_output`) без `previous_response_id`.

## Ограничения

- Без `windows.sandbox` вызов `exec_command` отклоняется политикой.
- Сетевой монитор в `run-poc.mjs` снимает `netstat` раз в ~0,2 с. Он видит соединение с gateway, но короткое соединение между снимками и DNS-запросы пропустит, поэтому полное отсутствие других маршрутов не доказано.
- Временный `CODEX_HOME` после запуска содержит служебные SQLite (`state_5`, `logs_2`, `memories_1`, `goals_1`, `queue_1`), `.sandbox` и системные навыки `skills/.system`.
