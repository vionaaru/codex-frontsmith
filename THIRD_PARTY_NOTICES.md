# Сторонние компоненты Frontsmith

Frontsmith распространяется по лицензии MIT (`LICENSE`). Вместе с ним в каталоге `vendor/` поставляются сторонние компоненты в неизменённом виде, чтобы установка не зависела от доступности исходных репозиториев. Версии, источники и SHA-256 каждого файла зафиксированы в `vendor/manifest.json`; как обновлять поставку — `vendor/README.md`.

Лицензии и уведомления исходных авторов сохранены рядом с компонентами. Этот файл их не заменяет.

## Компоненты

| Компонент | Версия | Лицензия | Правообладатель | В поставке |
|---|---|---|---|---|
| crmkit | 0.9.1, commit 59f21852597bd2de5090293f10f0330151291d05 | MIT | Petko D. Petkov | `vendor/crmkit/source/` (исходники, `LICENSE`) |
| crmkitd (Windows amd64) | 0.9.1 | MIT | Petko D. Petkov | `vendor/crmkit/release/` (архив релиза и официальный `checksums.txt`) |
| pii-guard | 0.1.0, commit 24230abb72949a9f85499244dd4f15a0ad0cdd9e | Apache-2.0 | Red Madrobot | `vendor/pii-guard/source/` (`LICENSE`, `NOTICE`) |
| redmadrobot-rnd/rubert-base-pii-ner | revision c802e8cd26f85d1cf920973ea6f83965a0618d63 | Apache-2.0 | Red Madrobot; дообучена на основе ai-forever/ruBert-base (Apache-2.0) | `vendor/ner-model/rubert-base-pii-ner/` (`LICENSE`, `README.md` модели) |
| uv | 0.12.24 | MIT OR Apache-2.0 | Astral Software Inc. | `vendor/runtime-assets/uv/` (лицензии внутри архива) |
| CPython (python-build-standalone) | 3.11.14, сборка 20260211 | PSF-2.0 и лицензии включённых библиотек | Python Software Foundation; сборка Astral (python-build-standalone) | `vendor/runtime-assets/python/` (`LICENSE.txt` внутри архива) |
| Python wheels Privacy Service | см. таблицу ниже | по пакетам | авторы пакетов | `vendor/runtime-assets/wheels/` (лицензии внутри каждого wheel) |

Дополнения Frontsmith к pii-guard (HTTP-сервис псевдонимизации) находятся отдельно от стороннего кода, в `services/privacy/frontsmith_privacy/`, и распространяются по лицензии Frontsmith.

## Условия, требующие внимания

- **msvc-runtime 14.44.35112** содержит DLL Microsoft Visual C++ Runtime (нужны torch на Windows). Это «Distributable Code» Microsoft Visual Studio 2022: распространять неизменённые файлы разрешено в составе своей программы при наличии действующей лицензии Visual Studio (условия — в `LICENSE` внутри wheel и на https://learn.microsoft.com/visualstudio/releases/2022/redistribution). Перед публикацией владелец подтверждает, что эти условия выполняются; иначе wheel исключается из поставки и устанавливается отдельно.
- **certifi** и **tqdm** частично распространяются по MPL-2.0: файлы включены без изменений, исходный код доступен в самих wheels.
- Веса NER — опубликованная модель Hugging Face указанной ревизии без изменений. В исходном NOTICE pii-guard сказано, что веса распространяются отдельно от pii-guard: Frontsmith распространяет их сам на условиях Apache-2.0 модели, с её LICENSE.

## Python wheels

| Пакет | Версия | Лицензия |
|---|---|---|
| annotated-doc | 0.0.5 | MIT |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.15.1 | MIT |
| blis | 1.3.3 | BSD |
| catalogue | 2.0.10 | MIT |
| certifi | 2026.10.19 | MPL-2.0 |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| cloudpathlib | 0.26.0 | MIT License |
| colorama | 0.4.6 | BSD License |
| confection | 1.3.3 | MIT |
| cryptography | 48.0.1 | Apache-2.0 OR BSD-3-Clause |
| cymem | 2.0.13 | MIT |
| DAWG2-Python | 0.9.0 | MIT |
| fastapi | 0.161.1 | MIT |
| filelock | 4.2.4 | MIT |
| fsspec | 2026.9.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| hf-xet | 1.7.0 | Apache-2.0 |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpcore2 | 2.16.0 | BSD-3-Clause |
| httpx | 0.28.1 | BSD-3-Clause |
| httpx2 | 2.16.0 | BSD-3-Clause |
| huggingface_hub | 2.2.0 | Apache-2.0 |
| idna | 3.20 | BSD-3-Clause |
| iniconfig | 2.3.1 | MIT |
| Jinja2 | 3.1.6 | BSD License |
| lingua-language-detector | 2.1.1 | Apache-2.0 |
| markdown-it-py | 4.2.0 | MIT License |
| MarkupSafe | 3.0.4 | BSD-3-Clause |
| mdurl | 0.1.2 | MIT License |
| mpmath | 1.3.0 | BSD |
| msvc_runtime | 14.44.35112 | Proprietary |
| murmurhash | 1.0.15 | MIT |
| networkx | 3.6.1 | BSD-3-Clause |
| numpy | 2.4.6 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| opentelemetry-api | 1.45.1 | Apache-2.0 |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| phonenumbers | 9.0.41 | Apache-2.0 |
| pluggy | 1.7.0 | MIT |
| preshed | 3.0.13 | MIT |
| presidio_analyzer | 2.2.364 | MIT |
| presidio_anonymizer | 2.2.364 | MIT |
| pycparser | 3.12 | BSD-3-Clause |
| pydantic | 2.14.1 | MIT |
| pydantic_core | 2.50.1 | MIT |
| Pygments | 2.21.0 | BSD-2-Clause |
| pymorphy3 | 2.0.6 | MIT license |
| pymorphy3-dicts-ru | 2.4.417150.4580142 | MIT license |
| pytest | 8.4.2 | MIT |
| PyYAML | 6.0.3 | MIT |
| RapidFuzz | 3.14.6 | MIT |
| regex | 2026.9.29 | Apache-2.0 AND CNRI-Python |
| requests | 2.34.2 | Apache-2.0 |
| requests-file | 3.0.1 | Apache 2.0 |
| rich | 15.0.0 | MIT |
| ru_core_news_sm | 3.8.0 | MIT |
| safetensors | 0.8.0 | Apache Software License |
| setuptools | 84.2.1 | MIT |
| shellingham | 1.5.4 | ISC License |
| smart_open | 8.0.4 | MIT License |
| spacy | 3.8.16 | MIT |
| spacy-legacy | 3.0.12 | MIT |
| spacy-loggers | 1.0.5 | MIT |
| srsly | 2.5.4 | MIT |
| starlette | 1.9.0 | BSD-3-Clause |
| sympy | 1.14.0 | BSD |
| thefuzz | 0.22.1 | MIT |
| thinc | 8.3.13 | MIT |
| tldextract | 5.4.0 | BSD-3-Clause |
| tokenizers | 0.23.3 | Apache Software License |
| torch | 2.14.1+cpu | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |
| transformers | 5.20.2 | Apache 2.0 License |
| truststore | 0.10.5 | MIT |
| typer | 0.27.3 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| typing-inspection | 0.4.4 | MIT |
| urllib3 | 2.8.0 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |
| wasabi | 1.1.3 | MIT |
| weasel | 1.0.0 | MIT |
| wheel | 0.48.0 | MIT |
| wrapt | 2.5.1 | BSD-2-Clause |
