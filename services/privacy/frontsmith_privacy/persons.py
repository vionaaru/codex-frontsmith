"""Дополнение NER pii-guard именами, уже известными privacy-session.

Настоящий pii-guard (rubert-base-pii-ner c802e8c) в отдельных фразах размечает
только часть имени: «Что мы знаем про Ивана Петрова?» → PERSON только для «Ивана»,
«Петрова» остаётся в тексте открытым. Модель и ядро pii-guard не меняются.
Обёртка берёт его разметку, добавляет PERSON для слов, чья нормальная форма
совпадает с частью имени, уже известного этой сессии, и передаёт спаны в
штатный `pseudonymize_batch` pii-guard: склейка соседних PERSON и дедупликация
по именительному падежу дают тот же тег, что и в первом сообщении.
"""

from __future__ import annotations

import re
from typing import Any

_WORD_RE = re.compile(r"[А-ЯЁA-Z][а-яёa-z]+(?:-[А-ЯЁA-Z][а-яёa-z]+)?")
_PERSON_TAG_RE = re.compile(r'<PII\b[^>]*type="PERSON"[^>]*/>', re.IGNORECASE)
_MIN_TOKEN = 3


def _morph():
    import pymorphy3

    global _MORPH
    try:
        return _MORPH
    except NameError:
        _MORPH = pymorphy3.MorphAnalyzer()
        return _MORPH


def known_person_tokens(state: Any) -> set[str]:
    """Части имён (в нижнем регистре, именительный падеж) из состояния сессии."""
    names = set(getattr(state, "person_nom_to_tag", {}) or {})
    for tag, value in (getattr(state, "mapping", {}) or {}).items():
        if _PERSON_TAG_RE.fullmatch(tag):
            names.add(value)
    return {token.casefold() for name in names for token in name.split() if len(token) >= _MIN_TOKEN}


def matches_known(word: str, tokens: set[str]) -> bool:
    if not tokens:
        return False
    if word.casefold() in tokens:
        return True
    return any(parse.normal_form in tokens for parse in _morph().parse(word))


def person_words_left(text: str, tokens: set[str]) -> list[str]:
    """Слова с заглавной буквы вне тегов, совпадающие с известной частью имени."""
    outside = re.sub(r"<PII\b[^>]*/>", " ", text, flags=re.IGNORECASE)
    return [m.group(0) for m in _WORD_RE.finditer(outside) if matches_known(m.group(0), tokens)]


def is_name_part(word: str) -> bool:
    return any({"Name", "Surn", "Patr"} & set(parse.tag.grammemes) for parse in _morph().parse(word))


def complete_person_spans(text: str, entities: list[dict], tokens: set[str]) -> list[dict]:
    """Добавляет PERSON-спаны для не размеченных слов:

    - нормальная форма совпадает с частью имени, известного сессии;
    - слово стоит вплотную (через пробел) к PERSON-спану и морфологически
      является именем, фамилией или отчеством («Ивана [Петрова]»).
    """
    result = [dict(e) for e in entities]
    words = [m for m in _WORD_RE.finditer(text)]
    changed = True
    while changed:
        changed = False
        persons = [(e["start"], e["end"]) for e in result if e.get("entity_type") == "PERSON"]
        covered = [(e["start"], e["end"]) for e in result]
        for match in words:
            start, end = match.span()
            if any(s < end and start < e for s, e in covered):
                continue
            word = match.group(0)
            adjacent = any(
                (text[e:start].strip() == "" and e <= start) or (text[end:s].strip() == "" and end <= s) for s, e in persons
            )
            if matches_known(word, tokens) or (adjacent and is_name_part(word)):
                result.append({"start": start, "end": end, "entity_type": "PERSON", "score": 0.7, "source": "frontsmith"})
                changed = True
                break
    return sorted(result, key=lambda e: (e["start"], e["end"]))


class SessionAwareAnonymizer:
    """pii-guard Anonymizer с дополнением PERSON из состояния сессии.

    `anonymize(mode="pseudonymize")`: детекция pii-guard (`mode="mask"`, обе ветки),
    дополнение спанов, затем `pii_guard.pseudonymize.pseudonymize_batch` с тем же state.
    Остальные режимы и `deanonymize` — без изменений.
    """

    def __init__(self, anonymizer: Any) -> None:
        self._inner = anonymizer
        self.config = anonymizer.config

    @property
    def ner_enabled(self) -> bool:
        return bool(self._inner.ner_enabled)

    def anonymize(self, texts, *, mode: str = "mask", entities=None, state=None):
        if mode != "pseudonymize":
            return self._inner.anonymize(texts, mode=mode, entities=entities, state=state)
        from pii_guard.pseudonymize import PseudonymizationState, pseudonymize_batch

        detected = self._inner.anonymize(texts, mode="mask", entities=entities)
        state = state if state is not None else PseudonymizationState()
        tokens = known_person_tokens(state)
        completed = [
            complete_person_spans(normalized, found, tokens)
            for normalized, found in zip(detected.normalized_texts, detected.entities, strict=True)
        ]
        pseudo_texts, mapping, new_state = pseudonymize_batch(detected.normalized_texts, completed, state=state)
        detected.texts = pseudo_texts
        detected.entities = completed
        detected.mapping = mapping
        detected.state = new_state
        detected.mode = "pseudonymize"
        return detected

    def deanonymize(self, texts, mapping):
        return self._inner.deanonymize(texts, mapping)
