"""Privacy Service: сессии псевдонимизации поверх Python API pii-guard.

Граница доверия: наружу уходят только псевдонимизированный текст и счётчики.
Mapping, normalized_text и найденные исходные значения остаются внутри процесса
и в приватном хранилище сессий.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from typing import Any, Protocol

from frontsmith_privacy.persons import known_person_tokens, person_words_left
from frontsmith_privacy.store import SessionNotFound, SessionStore, StateStoreUnavailable, VersionConflict

logger = logging.getLogger("frontsmith_privacy")

STATE_FORMAT = "pii-guard-state/1"
REQUIRED_ENTITIES: tuple[str, ...] = ("PERSON", "PHONE_NUMBER")
MAX_TEXT_CHARS = 20_000
_TAG_RE = re.compile(r"<PII\b[^>]*/>", re.IGNORECASE)
_DIGITS_RE = re.compile(r"\D")


class PrivacyError(Exception):
    """Ошибка с кодом без исходных данных в тексте."""

    status = 500

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail


class NotReady(PrivacyError):
    status = 503


class BadRequest(PrivacyError):
    status = 422


class Forbidden(PrivacyError):
    status = 403


class Missing(PrivacyError):
    status = 404


class Conflict(PrivacyError):
    status = 409


class AnonymizerLike(Protocol):
    ner_enabled: bool

    def anonymize(self, texts, *, mode: str, entities=None, state=None): ...

    def deanonymize(self, texts, mapping: dict[str, str]) -> list[str]: ...


@dataclass
class ServiceInfo:
    pii_guard_version: str = "unknown"
    pii_guard_commit: str = "unknown"
    ner_model: str | None = None
    ner_revision: str | None = None
    entity_types: tuple[str, ...] = ()
    ner_only_entities: frozenset[str] = frozenset()
    model_instructions: str = ""
    restore_recipients: frozenset[str] = frozenset({"operator"})
    load_error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


_STATE_DICT_FIELDS = ("exact_key_to_tag", "person_nom_to_tag", "location_nom_to_tag", "mapping")


def state_to_json(state: Any) -> str:
    """Явный версионированный формат вместо pickle."""
    if not is_dataclass(state):
        raise TypeError("pseudonymization state must be a dataclass")
    return json.dumps({"format": STATE_FORMAT, "state": asdict(state)}, ensure_ascii=False, sort_keys=True)


def state_from_json(raw: str, state_factory) -> Any:
    payload = json.loads(raw)
    if payload.get("format") != STATE_FORMAT:
        raise ValueError("unsupported state format")
    data = payload.get("state")
    if not isinstance(data, dict):
        raise ValueError("state must be an object")
    counters = data.get("type_counters", {})
    if not isinstance(counters, dict) or not all(
        isinstance(k, str) and isinstance(v, int) and not isinstance(v, bool) for k, v in counters.items()
    ):
        raise ValueError("type_counters must map str to int")
    values: dict[str, Any] = {"type_counters": dict(counters)}
    for name in _STATE_DICT_FIELDS:
        value = data.get(name, {})
        if not isinstance(value, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in value.items()):
            raise ValueError(f"{name} must map str to str")
        values[name] = dict(value)
    known = {f.name for f in fields(state_factory)}
    unknown = set(data) - known
    if unknown:
        raise ValueError("state has unknown fields")
    return state_factory(**{k: v for k, v in values.items() if k in known})


def _leaks(prepared: str, originals: list[str]) -> bool:
    """Проверяет, что ни одно исходное значение сессии не осталось в тексте."""
    outside = _TAG_RE.sub(" ", prepared)
    lowered = outside.casefold()
    digits = _DIGITS_RE.sub("", outside)
    for original in originals:
        value = original.strip()
        if len(value) >= 3 and value.casefold() in lowered:
            return True
        original_digits = _DIGITS_RE.sub("", value)
        if len(original_digits) >= 7 and original_digits in digits:
            return True
    return False


class PrivacyService:
    def __init__(
        self,
        *,
        anonymizer: AnonymizerLike | None,
        store: SessionStore,
        info: ServiceInfo,
        state_factory,
        auth_token: str | None,
        required_entities: tuple[str, ...] = REQUIRED_ENTITIES,
    ) -> None:
        self.anonymizer = anonymizer
        self.store = store
        self.info = info
        self.state_factory = state_factory
        self.auth_token = auth_token
        self.required_entities = required_entities

    # ── readiness ─────────────────────────────────────────────────

    @property
    def ner_enabled(self) -> bool:
        if self.anonymizer is None:
            return False
        return bool(self.anonymizer.ner_enabled)

    def available_entities(self) -> list[str]:
        if self.anonymizer is None:
            return []
        if self.ner_enabled:
            return list(self.info.entity_types)
        return [e for e in self.info.entity_types if e not in self.info.ner_only_entities]

    def readiness(self) -> list[str]:
        reasons: list[str] = []
        if self.info.load_error:
            reasons.append("pii_guard_load_failed")
        if self.anonymizer is None:
            reasons.append("pii_guard_not_loaded")
        if not self.ner_enabled:
            reasons.append("ner_disabled")
        available = set(self.available_entities())
        reasons.extend(f"entity_unavailable:{e}" for e in self.required_entities if e not in available)
        if not self.store.ready():
            reasons.append("state_store_unavailable")
        if not self.auth_token:
            reasons.append("auth_token_missing")
        return reasons

    def health(self) -> dict:
        reasons = self.readiness()
        return {
            "status": "ready" if not reasons else "not_ready",
            "ready": not reasons,
            "reasons": reasons,
            "pii_guard_version": self.info.pii_guard_version,
            "pii_guard_commit": self.info.pii_guard_commit,
            "ner_enabled": self.ner_enabled,
            "ner_model": self.info.ner_model,
            "ner_revision": self.info.ner_revision,
            "available_entity_types": self.available_entities(),
            "required_entity_types": list(self.required_entities),
            "state_store_ready": self.store.ready(),
            "state_format": STATE_FORMAT,
        }

    def _require_ready(self) -> None:
        reasons = self.readiness()
        if reasons:
            # Причины без данных; клиент обязан не отправлять текст дальше.
            raise NotReady("privacy_not_ready", ",".join(reasons))

    # ── sessions ──────────────────────────────────────────────────

    @staticmethod
    def _check_tenant(tenant_id: Any) -> str:
        if not isinstance(tenant_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", tenant_id):
            raise BadRequest("invalid_tenant_id")
        return tenant_id

    @staticmethod
    def _check_text(text: Any) -> str:
        if not isinstance(text, str) or not text:
            raise BadRequest("invalid_text")
        if len(text) > MAX_TEXT_CHARS:
            raise BadRequest("text_too_large")
        return text

    def create_session(self, tenant_id: Any) -> dict:
        self._require_ready()
        tenant = self._check_tenant(tenant_id)
        row = self.store.create(tenant, STATE_FORMAT, state_to_json(self.state_factory()))
        logger.info("event=session_created tenant=%s", tenant)
        return {
            "privacy_session_id": row["id"],
            "tenant_id": tenant,
            "created_at": row["created_at"],
            "model_instructions": self.info.model_instructions,
        }

    def _load_state(self, tenant: str, session_id: str):
        try:
            row = self.store.load(tenant, session_id)
        except SessionNotFound:
            raise Missing("privacy_session_not_found") from None
        try:
            return row, state_from_json(row["state_json"], self.state_factory)
        except (ValueError, TypeError):
            raise NotReady("state_corrupted") from None

    def prepare(self, tenant_id: Any, session_id: str, text: Any, source: str = "user") -> dict:
        """Псевдонимизирует текст и сохраняет состояние ДО возврата результата."""
        self._require_ready()
        tenant = self._check_tenant(tenant_id)
        original = self._check_text(text)
        with self.store.session_lock(session_id):
            row, state = self._load_state(tenant, session_id)
            try:
                result = self.anonymizer.anonymize(original, mode="pseudonymize", state=state)
            except Exception:
                logger.warning("event=prepare_failed reason=anonymizer_error")
                raise NotReady("anonymizer_failed") from None
            prepared = result.texts[0] if result.texts else ""
            new_state = result.state
            if new_state is None:
                raise NotReady("anonymizer_returned_no_state")
            if _leaks(prepared, list(new_state.mapping.values())) or person_words_left(
                prepared, known_person_tokens(new_state)
            ):
                logger.warning("event=prepare_blocked reason=verification_failed")
                raise NotReady("verification_failed")
            try:
                version = self.store.save(tenant, session_id, state_to_json(new_state), row["version"])
            except VersionConflict:
                raise Conflict("privacy_session_conflict") from None
        entity_types = sorted({e["entity_type"] for e in (result.entities[0] if result.entities else [])})
        replacements = len(_TAG_RE.findall(prepared))
        logger.info(
            "event=prepared source=%s replacements=%d types=%s version=%d",
            source if source in {"user", "tool"} else "other", replacements, ",".join(entity_types), version,
        )
        # Белый список полей ответа: ни mapping, ни normalized_text, ни entities.value.
        return {"text": prepared, "replacements": replacements, "entity_types": entity_types, "version": version}

    def restore(self, tenant_id: Any, session_id: str, text: Any, recipient: Any) -> dict:
        """Восстанавливает значения только этой сессии и только для разрешённого адресата."""
        self._require_ready()
        tenant = self._check_tenant(tenant_id)
        model_text = self._check_text(text)
        if recipient not in self.info.restore_recipients:
            raise Forbidden("recipient_not_allowed")
        with self.store.session_lock(session_id):
            _row, state = self._load_state(tenant, session_id)
        try:
            restored = self.anonymizer.deanonymize(model_text, dict(state.mapping))
        except Exception:
            logger.warning("event=restore_failed reason=anonymizer_error")
            raise NotReady("restore_failed") from None
        logger.info("event=restored tags=%d", len(_TAG_RE.findall(model_text)))
        return {"text": restored[0] if restored else ""}
