"""Логика Privacy Service без модели: сессии, границы ответа, fail closed."""

from __future__ import annotations

import pytest
from conftest import PERSON, PHONE, TOKEN, FakeAnonymizer, make_service
from fastapi.testclient import TestClient

from frontsmith_privacy.app import create_app
from frontsmith_privacy.service import Conflict, Forbidden, Missing, NotReady

TENANT = "demo-tenant"


def test_prepare_returns_only_pseudonymized_text(service):
    session = service.create_session(TENANT)
    result = service.prepare(TENANT, session["privacy_session_id"], f"Клиент {PERSON}, тел. {PHONE}")
    assert set(result) == {"text", "replacements", "entity_types", "version"}
    assert PERSON not in result["text"] and PHONE not in result["text"]
    assert '<PII type="PERSON"' in result["text"] and '<PII type="PHONE_NUMBER"' in result["text"]
    assert "mapping" not in session and PERSON not in str(session)


def test_state_persists_between_messages(service):
    sid = service.create_session(TENANT)["privacy_session_id"]
    first = service.prepare(TENANT, sid, f"Клиент {PERSON}, телефон {PHONE}.")["text"]
    second = service.prepare(TENANT, sid, "Что мы знаем про Ивана Петрова?")["text"]
    tag = '<PII type="PERSON" id="1" />'
    assert tag in first and tag in second
    assert "Петров" not in second


def test_state_survives_restart(tmp_path):
    db = tmp_path / "privacy.sqlite"
    first = make_service(tmp_path, store_path=db)
    sid = first.create_session(TENANT)["privacy_session_id"]
    first.prepare(TENANT, sid, f"{PERSON}, {PHONE}")
    first.store.close()
    second = make_service(tmp_path, store_path=db)
    again = second.prepare(TENANT, sid, f"Перезвонить {PHONE}")["text"]
    assert '<PII type="PHONE_NUMBER" id="1" />' in again
    assert second.restore(TENANT, sid, again, "operator")["text"] == f"Перезвонить {PHONE}"
    second.store.close()


def test_sessions_do_not_mix(service):
    a = service.create_session(TENANT)["privacy_session_id"]
    b = service.create_session(TENANT)["privacy_session_id"]
    tag_a = service.prepare(TENANT, a, f"Звонил {PERSON}")["text"]
    assert service.restore(TENANT, b, tag_a, "operator")["text"] == "Звонил ****"
    assert service.restore(TENANT, a, tag_a, "operator")["text"] == f"Звонил {PERSON}"


def test_other_tenant_cannot_use_session(service):
    sid = service.create_session(TENANT)["privacy_session_id"]
    with pytest.raises(Missing):
        service.prepare("other-tenant", sid, f"Звонил {PERSON}")
    with pytest.raises(Missing):
        service.restore("other-tenant", sid, "x", "operator")


def test_restore_requires_allowed_recipient(service):
    sid = service.create_session(TENANT)["privacy_session_id"]
    text = service.prepare(TENANT, sid, f"Звонил {PERSON}")["text"]
    with pytest.raises(Forbidden):
        service.restore(TENANT, sid, text, "codex")


def test_invented_tags_are_scrubbed(service):
    sid = service.create_session(TENANT)["privacy_session_id"]
    restored = service.restore(TENANT, sid, 'Позвонить <PII type="PHONE_NUMBER" id="7" />', "operator")
    assert restored["text"] == "Позвонить ****"


@pytest.mark.parametrize(
    ("anonymizer", "reason"),
    [
        (FakeAnonymizer(ner_enabled=False), "ner_disabled"),
        (FakeAnonymizer(fail=True), None),
        (FakeAnonymizer(leak=True), None),
    ],
)
def test_fail_closed(tmp_path, anonymizer, reason):
    svc = make_service(tmp_path, anonymizer=FakeAnonymizer())
    sid = svc.create_session(TENANT)["privacy_session_id"]
    svc.anonymizer = anonymizer
    if reason:
        assert reason in svc.health()["reasons"] and not svc.health()["ready"]
        assert "entity_unavailable:PERSON" in svc.health()["reasons"]
    with pytest.raises(NotReady):
        svc.prepare(TENANT, sid, f"Клиент {PERSON}, тел. {PHONE}")
    svc.store.close()


def test_store_unavailable_blocks(service):
    sid = service.create_session(TENANT)["privacy_session_id"]
    service.store.close()
    assert "state_store_unavailable" in service.health()["reasons"]
    with pytest.raises(NotReady):
        service.prepare(TENANT, sid, f"Клиент {PERSON}")


def test_missing_token_is_not_ready(tmp_path):
    svc = make_service(tmp_path, token=None)
    assert "auth_token_missing" in svc.health()["reasons"]
    svc.store.close()


def test_version_conflict_is_reported(service, monkeypatch):
    sid = service.create_session(TENANT)["privacy_session_id"]
    original_save = service.store.save

    def stale_save(tenant, session_id, state_json, expected_version):
        return original_save(tenant, session_id, state_json, expected_version - 1)

    monkeypatch.setattr(service.store, "save", stale_save)
    with pytest.raises(Conflict):
        service.prepare(TENANT, sid, f"Клиент {PERSON}")


def test_http_contract(tmp_path):
    svc = make_service(tmp_path)
    with TestClient(create_app(svc)) as client:
        health = client.get("/health").json()
        assert health["ready"] and health["ner_enabled"]
        assert {"PERSON", "PHONE_NUMBER"} <= set(health["available_entity_types"])
        assert client.post("/sessions", json={"tenant_id": TENANT}).status_code == 401
        auth = {"Authorization": f"Bearer {TOKEN}"}
        sid = client.post("/sessions", json={"tenant_id": TENANT}, headers=auth).json()["privacy_session_id"]
        prepared = client.post(
            f"/sessions/{sid}/prepare", json={"tenant_id": TENANT, "text": f"{PERSON}, {PHONE}"}, headers=auth
        )
        body = prepared.json()
        assert prepared.status_code == 200 and set(body) == {"text", "replacements", "entity_types", "version"}
        assert PERSON not in prepared.text and PHONE not in prepared.text
        restored = client.post(
            f"/sessions/{sid}/restore",
            json={"tenant_id": TENANT, "text": body["text"], "recipient": "operator"},
            headers=auth,
        )
        assert restored.json() == {"text": f"{PERSON}, {PHONE}"}
        bad = client.post(f"/sessions/{sid}/prepare", json={"tenant_id": TENANT, "text": 5}, headers=auth)
        assert bad.status_code == 422 and PERSON not in bad.text
        for path in ("/sessions/{sid}/mapping", "/sessions/{sid}", "/sessions/{sid}/dump"):
            assert client.get(path.format(sid=sid), headers=auth).status_code in (404, 405)
        svc.anonymizer = FakeAnonymizer(ner_enabled=False)
        blocked = client.post(f"/sessions/{sid}/prepare", json={"tenant_id": TENANT, "text": PERSON}, headers=auth)
        assert blocked.status_code == 503 and blocked.json()["error"] == "privacy_not_ready"
        assert client.get("/health").status_code == 503
