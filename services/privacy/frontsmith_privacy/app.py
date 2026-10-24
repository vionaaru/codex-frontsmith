"""HTTP-обёртка Privacy Service для доверенного Codex Host.

    GET  /health                          готовность и доступные типы сущностей
    POST /sessions                        новая privacy-session компании
    POST /sessions/{id}/prepare           псевдонимизация текста пользователя или инструмента
    POST /sessions/{id}/restore           восстановление ответа модели для адресата

Операций выдачи mapping, исходных значений или дампа сессии нет намеренно.
"""

from __future__ import annotations

import hmac
import logging
import os
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from frontsmith_privacy.persons import SessionAwareAnonymizer
from frontsmith_privacy.service import PrivacyError, PrivacyService, ServiceInfo
from frontsmith_privacy.store import SessionStore, StateStoreUnavailable

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", force=True)
logger = logging.getLogger("frontsmith_privacy.app")


class SessionRequest(BaseModel):
    tenant_id: str


class PrepareRequest(BaseModel):
    tenant_id: str
    text: str
    source: str = "user"


class RestoreRequest(BaseModel):
    tenant_id: str
    text: str
    recipient: str


def load_pii_guard_service(store: SessionStore, auth_token: str | None) -> PrivacyService:
    """Загружает настоящий pii-guard. Ошибка загрузки оставляет сервис not_ready."""
    from pii_guard import __version__
    from pii_guard.config import NER_ONLY_ENTITIES, Config
    from pii_guard.pseudonymize import PseudonymizationState

    info = ServiceInfo(
        pii_guard_version=__version__,
        pii_guard_commit=os.getenv("PII_GUARD_COMMIT", "unknown"),
        ner_only_entities=frozenset(NER_ONLY_ENTITIES),
        restore_recipients=frozenset(
            r.strip() for r in os.getenv("PRIVACY_RESTORE_RECIPIENTS", "operator").split(",") if r.strip()
        ),
    )
    anonymizer = None
    try:
        from pii_guard import Anonymizer

        config = Config.load()
        # Модель Frontsmith загружается из локального каталога поставки: в /health —
        # её идентификатор и ревизия Hugging Face, а не путь на диске
        info.ner_model = os.getenv("FRONTSMITH_NER_MODEL_ID") or config.ner_model
        info.ner_revision = os.getenv("FRONTSMITH_NER_REVISION") or config.ner_revision
        info.entity_types = tuple(config.entities)
        anonymizer = SessionAwareAnonymizer(Anonymizer(config))
        info.model_instructions = Anonymizer.pseudonymize_system_prompt()
    except Exception as error:  # noqa: BLE001 -- любая ошибка загрузки блокирует обработку
        info.load_error = type(error).__name__
        logger.error("event=pii_guard_load_failed error=%s", info.load_error)
    return PrivacyService(
        anonymizer=anonymizer,
        store=store,
        info=info,
        state_factory=PseudonymizationState,
        auth_token=auth_token,
    )


def create_app(service: PrivacyService | None = None) -> FastAPI:
    holder: dict[str, PrivacyService] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if service is not None:
            holder["service"] = service
        else:
            store = SessionStore(os.getenv("PRIVACY_DB_PATH", "/data/privacy.sqlite"))
            try:
                store.open()
            except Exception as error:  # noqa: BLE001
                logger.error("event=state_store_open_failed error=%s", type(error).__name__)
            holder["service"] = load_pii_guard_service(store, os.getenv("PRIVACY_SERVICE_TOKEN") or None)
        health = holder["service"].health()
        logger.info("event=startup status=%s reasons=%s", health["status"], ",".join(health["reasons"]))
        yield
        holder["service"].store.close()

    app = FastAPI(title="Frontsmith Privacy Service", version="0.1.0", lifespan=lifespan)

    def current() -> PrivacyService:
        return holder["service"]

    def authorized(authorization: str | None = Header(default=None), svc: PrivacyService = Depends(current)) -> None:
        token = svc.auth_token
        presented = (authorization or "").removeprefix("Bearer ").strip()
        if not token or not hmac.compare_digest(presented.encode(), token.encode()):
            raise PrivacyError("unauthorized")

    @app.exception_handler(PrivacyError)
    async def privacy_error(_request: Request, error: PrivacyError):
        status = 401 if error.code == "unauthorized" else error.status
        body = {"error": error.code}
        if error.detail and status == 503:
            body["reasons"] = error.detail.split(",")
        return JSONResponse(status_code=status, content=body)

    @app.exception_handler(StateStoreUnavailable)
    async def store_error(_request: Request, _error: StateStoreUnavailable):
        return JSONResponse(status_code=503, content={"error": "state_store_unavailable"})

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, error: RequestValidationError):
        # Как в pii-guard: не возвращаем отклонённое значение, в нём могут быть ПД.
        fields = [".".join(str(part) for part in e.get("loc", ()))[:64] for e in error.errors()]
        return JSONResponse(status_code=422, content={"error": "invalid_request", "fields": fields})

    @app.get("/health")
    def health(svc: PrivacyService = Depends(current)):
        body = svc.health()
        return JSONResponse(status_code=200 if body["ready"] else 503, content=body)

    @app.post("/sessions", dependencies=[Depends(authorized)])
    def create_session(request: SessionRequest, svc: PrivacyService = Depends(current)):
        return svc.create_session(request.tenant_id)

    @app.post("/sessions/{session_id}/prepare", dependencies=[Depends(authorized)])
    def prepare(session_id: str, request: PrepareRequest, svc: PrivacyService = Depends(current)):
        return svc.prepare(request.tenant_id, session_id, request.text, request.source)

    @app.post("/sessions/{session_id}/restore", dependencies=[Depends(authorized)])
    def restore(session_id: str, request: RestoreRequest, svc: PrivacyService = Depends(current)):
        return svc.restore(request.tenant_id, session_id, request.text, request.recipient)

    return app


app = create_app()
