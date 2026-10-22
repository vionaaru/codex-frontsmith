# syntax=docker/dockerfile:1
# Frontsmith Privacy Service: pii-guard с NER как библиотека + собственные сессии.
#
#   docker compose -f services/privacy/compose.yml build
#
# pii-guard ставится из зафиксированного commit, веса NER — из зафиксированной
# ревизии Hugging Face и запекаются в образ. При старте сеть не нужна
# (HF_HUB_OFFLINE=1): отсутствие весов делает сервис not_ready, а не rules-only.
FROM python:3.11-slim

ARG PII_GUARD_COMMIT=24230abb72949a9f85499244dd4f15a0ad0cdd9e
ARG NER_MODEL=redmadrobot-rnd/rubert-base-pii-ner
ARG NER_REVISION=c802e8cd26f85d1cf920973ea6f83965a0618d63
ARG SPACY_MODEL=ru_core_news_sm
ARG TORCH_INDEX=https://download.pytorch.org/whl/cpu

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf-cache

WORKDIR /app

RUN useradd --create-home --uid 10001 privacy \
    && mkdir -p "$HF_HOME" /data \
    && chown privacy:privacy "$HF_HOME" /data /app

RUN pip install torch --index-url "$TORCH_INDEX"

COPY requirements.txt ./
RUN pip install -r requirements.txt \
      "pii-guard[ner] @ https://github.com/redmadrobot-rnd/pii-guard/archive/${PII_GUARD_COMMIT}.tar.gz" \
    && python -m spacy download "$SPACY_MODEL"

USER privacy

RUN python -c "\
from transformers import AutoTokenizer, AutoModelForTokenClassification as M; \
AutoTokenizer.from_pretrained('${NER_MODEL}', revision='${NER_REVISION}'); \
M.from_pretrained('${NER_MODEL}', revision='${NER_REVISION}')"

COPY --chown=privacy:privacy frontsmith_privacy ./frontsmith_privacy
COPY --chown=privacy:privacy tests ./tests

ENV PII_GUARD_COMMIT=${PII_GUARD_COMMIT} \
    PII_GUARD_NER_MODEL=${NER_MODEL} \
    PII_GUARD_NER_REVISION=${NER_REVISION} \
    PII_GUARD_SPACY_MODEL=${SPACY_MODEL} \
    HF_HUB_OFFLINE=1 \
    PRIVACY_DB_PATH=/data/privacy.sqlite

VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health').status==200 else 1)"

CMD ["python", "-m", "uvicorn", "frontsmith_privacy.app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
