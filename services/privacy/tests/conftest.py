"""Общие фикстуры. Все значения синтетические."""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from frontsmith_privacy.service import PrivacyService, ServiceInfo  # noqa: E402
from frontsmith_privacy.store import SessionStore  # noqa: E402

TOKEN = "test-token-not-a-secret"
PERSON = "Иван Петров"
PHONE = "+7 916 123-45-67"


@dataclass
class FakeState:
    type_counters: dict[str, int] = field(default_factory=dict)
    exact_key_to_tag: dict[str, str] = field(default_factory=dict)
    person_nom_to_tag: dict[str, str] = field(default_factory=dict)
    location_nom_to_tag: dict[str, str] = field(default_factory=dict)
    mapping: dict[str, str] = field(default_factory=dict)


@dataclass
class FakeResult:
    texts: list[str]
    entities: list[list[dict]]
    state: FakeState


class FakeAnonymizer:
    """Детерминированная замена pii-guard для проверки логики сервиса без модели."""

    _patterns = (
        ("PHONE_NUMBER", re.compile(r"\+7[\s(]*\d{3}[\s)]*\d{3}-\d{2}-\d{2}")),
        ("PERSON", re.compile(r"Иван(?:а|у|ом|е)? Петров(?:а|у|ым|е)?")),
    )

    def __init__(self, ner_enabled: bool = True, fail: bool = False, leak: bool = False) -> None:
        self.ner_enabled = ner_enabled
        self.fail = fail
        self.leak = leak

    def anonymize(self, texts, *, mode, entities=None, state=None):
        if self.fail:
            raise RuntimeError("engine down")
        text = texts if isinstance(texts, str) else texts[0]
        state = state or FakeState()
        found = []
        for entity, pattern in self._patterns:
            if entity == "PERSON" and not self.ner_enabled:
                continue
            for match in list(pattern.finditer(text)):
                value = match.group(0)
                key = f"{entity}:{PERSON if entity == 'PERSON' else value}"
                tag = state.exact_key_to_tag.get(key)
                if tag is None:
                    state.type_counters[entity] = state.type_counters.get(entity, 0) + 1
                    tag = f'<PII type="{entity}" id="{state.type_counters[entity]}" />'
                    state.exact_key_to_tag[key] = tag
                    state.mapping[tag] = PERSON if entity == "PERSON" else value
                found.append({"start": match.start(), "end": match.end(), "entity_type": entity, "score": 1.0})
                if not self.leak:
                    text = text.replace(value, tag)
        return FakeResult([text], [found], state)

    def deanonymize(self, texts, mapping):
        text = texts if isinstance(texts, str) else texts[0]
        for tag, value in mapping.items():
            text = text.replace(tag, value)
        return [re.sub(r"<PII\b[^>]*/>", "****", text)]


def make_service(tmp_path: Path, anonymizer=None, token: str | None = TOKEN, store_path=None) -> PrivacyService:
    store = SessionStore(store_path or tmp_path / "privacy.sqlite")
    store.open()
    return PrivacyService(
        anonymizer=anonymizer if anonymizer is not None else FakeAnonymizer(),
        store=store,
        info=ServiceInfo(
            pii_guard_version="fake",
            entity_types=("PERSON", "PHONE_NUMBER", "INN"),
            ner_only_entities=frozenset({"PERSON", "PHONE_NUMBER"}),
            model_instructions="keep tags",
        ),
        state_factory=FakeState,
        auth_token=token,
    )


@pytest.fixture
def service(tmp_path):
    svc = make_service(tmp_path)
    yield svc
    svc.store.close()
