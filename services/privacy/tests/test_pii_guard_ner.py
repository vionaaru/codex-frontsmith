"""Настоящий pii-guard с NER на синтетических российских данных.

Требует установленный pii-guard с весами модели (контейнер Privacy Service).
Без них тесты пропускаются, а не подменяются облегчённым режимом.
"""

from __future__ import annotations

import os

import pytest
from conftest import PERSON, PHONE, TOKEN

from frontsmith_privacy.service import NotReady, PrivacyService, ServiceInfo
from frontsmith_privacy.store import SessionStore

pii_guard = pytest.importorskip("pii_guard")
if os.getenv("PII_GUARD_NER_DISABLED", "0") not in ("", "0"):
    pytest.skip("контейнер собран без NER", allow_module_level=True)

from pii_guard import Anonymizer  # noqa: E402
from pii_guard.config import NER_ONLY_ENTITIES, Config  # noqa: E402
from pii_guard.pseudonymize import PseudonymizationState  # noqa: E402

TENANT = "demo-tenant"
INN = "7707083893"  # контрольная сумма корректна, значение из примеров pii-guard


@pytest.fixture(scope="module")
def anonymizer():
    return Anonymizer(Config.load())


def build(tmp_path, anonymizer) -> PrivacyService:
    store = SessionStore(tmp_path / "privacy.sqlite")
    store.open()
    return PrivacyService(
        anonymizer=anonymizer,
        store=store,
        info=ServiceInfo(
            pii_guard_version=pii_guard.__version__,
            entity_types=tuple(anonymizer.config.entities),
            ner_only_entities=frozenset(NER_ONLY_ENTITIES),
            model_instructions=Anonymizer.pseudonymize_system_prompt(),
        ),
        state_factory=PseudonymizationState,
        auth_token=TOKEN,
    )


def test_health_with_ner(tmp_path, anonymizer):
    health = build(tmp_path, anonymizer).health()
    assert health["ready"], health["reasons"]
    assert health["ner_enabled"]
    assert {"PERSON", "PHONE_NUMBER"} <= set(health["available_entity_types"])


def test_russian_phone_and_name(tmp_path, anonymizer):
    svc = build(tmp_path, anonymizer)
    sid = svc.create_session(TENANT)["privacy_session_id"]
    text = svc.prepare(TENANT, sid, f"{PERSON}, тел. {PHONE}, ИНН {INN}")["text"]
    assert "Иван" not in text and "Петров" not in text
    assert "916" not in text and "123-45-67" not in text
    assert INN not in text
    assert '<PII type="PERSON"' in text and '<PII type="PHONE_NUMBER"' in text


def test_two_turns_keep_pseudonym_and_restore(tmp_path, anonymizer):
    svc = build(tmp_path, anonymizer)
    sid = svc.create_session(TENANT)["privacy_session_id"]
    first = svc.prepare(
        TENANT, sid, f"Клиент {PERSON}, телефон {PHONE}. Запомни, что он обратился по ремонту подвески."
    )["text"]
    second = svc.prepare(TENANT, sid, "Что мы знаем про Ивана Петрова?")["text"]
    person_tags = [part for part in first.split("<PII ")[1:] if part.startswith('type="PERSON"')]
    assert person_tags, first
    person_tag = "<PII " + person_tags[0].split("/>")[0] + "/>"
    assert person_tag in second, (first, second)
    assert "Петров" not in second
    restored = svc.restore(TENANT, sid, f"Клиент {person_tag} обращался по ремонту подвески.", "operator")["text"]
    assert "Петров" in restored and "<PII" not in restored


def test_sessions_isolated(tmp_path, anonymizer):
    svc = build(tmp_path, anonymizer)
    a = svc.create_session(TENANT)["privacy_session_id"]
    b = svc.create_session(TENANT)["privacy_session_id"]
    tagged = svc.prepare(TENANT, a, f"Звонил {PERSON}")["text"]
    assert "Петров" not in svc.restore(TENANT, b, tagged, "operator")["text"]


def test_rules_only_engine_is_not_ready(tmp_path):
    rules_only = Anonymizer(Config.load(), ner=False)
    svc = build(tmp_path, rules_only)
    health = svc.health()
    assert not health["ready"]
    assert "ner_disabled" in health["reasons"] and "entity_unavailable:PHONE_NUMBER" in health["reasons"]
    with pytest.raises(NotReady):
        svc.create_session(TENANT)
