# Поставка сторонних компонентов

Здесь лежат зафиксированные версии всего, что `npm run bootstrap` ставит на Windows x64. Bootstrap берёт файлы только отсюда, проверяет SHA-256 по `manifest.json` и в интернет за ними не ходит. Если исходный проект удалят или закроют, уже опубликованная версия Frontsmith остаётся устанавливаемой.

| Каталог | Что это | Источник |
|---|---|---|
| `crmkit/source/` | исходники crmkit v0.9.1 | github.com/crmkit/crmkit, commit `59f21852597bd2de5090293f10f0330151291d05` |
| `crmkit/release/` | архив `crmkitd` для Windows amd64 и официальный `checksums.txt` | релиз v0.9.1 crmkit |
| `pii-guard/source/` | исходники pii-guard 0.1.0 | github.com/redmadrobot-rnd/pii-guard, commit `24230abb72949a9f85499244dd4f15a0ad0cdd9e` |
| `ner-model/rubert-base-pii-ner/` | веса, конфигурация и токенизатор модели NER | huggingface.co/redmadrobot-rnd/rubert-base-pii-ner, revision `c802e8cd26f85d1cf920973ea6f83965a0618d63` |
| `runtime-assets/uv/` | uv 0.12.24 | релиз astral-sh/uv |
| `runtime-assets/python/` | CPython 3.11.14 (python-build-standalone 20260211, install_only_stripped) | релиз astral-sh/python-build-standalone |
| `runtime-assets/wheels/` | все wheels `services/privacy/requirements.lock` для cp311 / win_amd64, а также setuptools и wheel для сборки pii-guard | PyPI, download.pytorch.org/whl/cpu (torch), релиз ru_core_news_sm-3.8.0 |

Исходники crmkit и pii-guard скопированы командой `git archive` без изменений: их `LICENSE`, `NOTICE` и вложенные `.gitignore` сохранены. Дополнения Frontsmith к pii-guard — в `services/privacy/frontsmith_privacy/`, не здесь. Лицензии — в `THIRD_PARTY_NOTICES.md` в корне репозитория.

## Git LFS

Архивы, wheels и `model.safetensors` хранятся в Git LFS (`.gitattributes` в корне), около 1 ГБ. Без `git lfs pull` вместо них в рабочей копии лежат текстовые указатели; `npm run bootstrap` и `npm run release:check` сообщают об этом до установки. Файлы в `vendor/` хранятся без преобразования концов строк (`-text`), поэтому отпечатки исходников совпадают в любом клоне.

## Проверка

```bash
npm run release:check
```

Команда сверяет каждый файл с `manifest.json`, отпечатки деревьев исходников, покрытие `requirements.lock` wheelhouse-ом, лицензии и то, что большие файлы попадают в LFS.

## Обновление компонента

Обновление — отдельное решение: Bootstrap не переходит на новые версии сам.

1. Положите новые файлы на место старых: исходники — `git archive <commit> | tar -x -C vendor/<компонент>/source`, архивы релизов — со сверкой с официальными контрольными суммами релиза.
2. Обновите зафиксированные значения в коде: `CRMKIT` (`services/crm/runtime.mjs`), `PINS`, `UV_DIST`, `PYTHON_DIST` (`services/privacy/runtime.mjs`) и `gitTree` исходников в `scripts/vendor-manifest.mjs`.
3. Для Python-зависимостей пересоберите lock (`services/privacy/requirements.in`) и скачайте wheels для Windows x64 / Python 3.11 в `runtime-assets/wheels/`, например в отдельном venv: `python -m pip download --no-deps --only-binary=:all: --dest vendor/runtime-assets/wheels --extra-index-url https://download.pytorch.org/whl/cpu -r <lock без строки pii-guard>`.
4. Пересчитайте manifest: `npm run vendor:manifest`.
5. Проверьте: `npm run release:check`, `npm run test:privacy`, `npm run test:crm`.
