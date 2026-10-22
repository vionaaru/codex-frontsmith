"""Настоящий pii-guard с NER на синтетических российских данных.

Запускается `npm run test:privacy` на управляемом runtime Frontsmith
(FRONTSMITH_REQUIRE_NER=1): отсутствие pii-guard или весов — ошибка, а не пропуск.
Без этой переменной (pytest вне runtime) модуль пропускается, двойник не подставляется.
"""

from __future__ import annotations

import os

import pytest
from conftest import PERSON, PHONE, TOKEN

from frontsmith_privacy.persons import SessionAwareAnonymizer
from frontsmith_privacy.service import NotReady, PrivacyService, ServiceInfo
from frontsmith_privacy.store import SessionStore

if os.getenv("FRONTSMITH_REQUIRE_NER") == "1":
    import pii_guard
else:
    pii_guard = pytest.importorskip("pii_guard")

from pii_guard import Anonymizer  # noqa: E402
from pii_guard.config import NER_ONLY_ENTITIES, Config  # noqa: E402
from pii_guard.pseudonymize import PseudonymizationState  # noqa: E402

TENANT = "demo-tenant"
INN = "7707083893"  # контрольная сумма корректна, значение из примеров pii-guard


@pytest.fixture(scope="module")
def anonymizer():
    return SessionAwareAnonymizer(Anonymizer(Config.load()))


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


NAME_FORMS = [
    ("Иван Петров", "Клиент Иван Петров позвонил утром."),
    ("Ивана Петрова", "Мы ждём Ивана Петрова к десяти."),
    ("Ивану Петрову", "Передайте Ивану Петрову, что машина готова."),
    ("с Иваном Петровым", "Договорились с Иваном Петровым о замене колодок."),
    ("про Ивана Петрова", "Что мы знаем про Ивана Петрова?"),
]


@pytest.mark.parametrize(("form", "text"), NAME_FORMS, ids=[form for form, _ in NAME_FORMS])
def test_person_forms(tmp_path, anonymizer, form, text):
    svc = build(tmp_path, anonymizer)
    sid = svc.create_session(TENANT)["privacy_session_id"]
    result = svc.prepare(TENANT, sid, text)
    assert "Иван" not in result["text"] and "Петров" not in result["text"], result["text"]
    assert result["text"].count('<PII type="PERSON"') == 1, result["text"]
    assert "PERSON" in result["entity_types"]


PHONE_FORMATS = ["+7 916 123-45-67", "8 916 123 45 67", "+7(916)1234567", "89161234567"]


@pytest.mark.parametrize("phone", PHONE_FORMATS)
def test_phone_formats(tmp_path, anonymizer, phone):
    svc = build(tmp_path, anonymizer)
    sid = svc.create_session(TENANT)["privacy_session_id"]
    result = svc.prepare(TENANT, sid, f"Телефон клиента {phone}")
    digits = "".join(ch for ch in result["text"] if ch.isdigit())
    assert "916" not in digits and "4567" not in digits, result["text"]
    assert result["entity_types"] == ["PHONE_NUMBER"], result
    assert svc.restore(TENANT, sid, result["text"], "operator")["text"] == f"Телефон клиента {phone}"


def test_pii_guard_ner_alone_misses_surname_in_question(anonymizer):
    """Фиксирует реальный пропуск NER, который закрывает SessionAwareAnonymizer."""
    raw = anonymizer._inner.anonymize("Что мы знаем про Ивана Петрова?", mode="pseudonymize")
    assert "Петрова" in raw.texts[0]


def test_two_turns_keep_pseudonym_and_restore(tmp_path, anonymizer):
    svc = build(tmp_path, anonymizer)
    sid = svc.create_session(TENANT)["privacy_session_id"]
    first = svc.prepare(TENANT, sid, f"Клиент {PERSON}, телефон {PHONE}.\nОн обратился по ремонту подвески.")["text"]
    assert PHONE not in first and "Петров" not in first
    second = svc.prepare(TENANT, sid, "Что мы знаем про Ивана Петрова?")["text"]
    person_tags = [part for part in first.split("<PII ")[1:] if part.startswith('type="PERSON"')]
    assert person_tags, first
    person_tag = "<PII " + person_tags[0].split("/>")[0] + "/>"
    assert person_tag in second, (first, second)
    assert "Петров" not in second and "Иван" not in second
    assert second.count("<PII") == 1, second
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
