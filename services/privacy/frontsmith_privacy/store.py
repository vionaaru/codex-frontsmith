"""Приватное хранилище сессий псевдонимизации.

Отдельная SQLite вне рабочей области Codex. Хранит только состояние pii-guard
(счётчики, словари дедупликации и накопленный mapping) с версией для контроля
параллельных записей. Исходные тексты сообщений сюда не попадают.
"""

from __future__ import annotations

import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS privacy_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state_format TEXT NOT NULL,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS privacy_sessions_tenant ON privacy_sessions (tenant_id);
"""


class StateStoreUnavailable(Exception):
    """Хранилище не открыто или не отвечает. Обработка блокируется."""


class SessionNotFound(Exception):
    """Сессии нет или она принадлежит другой компании."""


class VersionConflict(Exception):
    """Сессию изменили параллельно. Состояние не сохранено."""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class SessionStore:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._db: sqlite3.Connection | None = None
        self._db_lock = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def open(self) -> None:
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript(SCHEMA)
        self._db = db

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    def ready(self) -> bool:
        if self._db is None:
            return False
        try:
            with self._db_lock:
                self._db.execute("SELECT count(*) FROM privacy_sessions").fetchone()
            return True
        except sqlite3.Error:
            return False

    def _conn(self) -> sqlite3.Connection:
        if self._db is None:
            raise StateStoreUnavailable("state store is not open")
        return self._db

    @contextmanager
    def session_lock(self, session_id: str):
        """Сериализует обработку одной сессии внутри процесса."""
        with self._locks_guard:
            lock = self._locks.setdefault(session_id, threading.Lock())
        with lock:
            yield

    def create(self, tenant_id: str, state_format: str, state_json: str) -> dict:
        session_id = "ps_" + secrets.token_urlsafe(18)
        now = _now()
        try:
            with self._db_lock:
                self._conn().execute(
                    "INSERT INTO privacy_sessions (id, tenant_id, state_format, state_json, version, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, 1, ?, ?)",
                    (session_id, tenant_id, state_format, state_json, now, now),
                )
        except sqlite3.Error as error:
            raise StateStoreUnavailable("state store write failed") from error
        return {"id": session_id, "tenant_id": tenant_id, "version": 1, "created_at": now, "updated_at": now}

    def load(self, tenant_id: str, session_id: str) -> dict:
        try:
            with self._db_lock:
                row = self._conn().execute(
                    "SELECT id, tenant_id, state_format, state_json, version, created_at, updated_at"
                    " FROM privacy_sessions WHERE id = ? AND tenant_id = ?",
                    (session_id, tenant_id),
                ).fetchone()
        except sqlite3.Error as error:
            raise StateStoreUnavailable("state store read failed") from error
        if row is None:
            raise SessionNotFound(session_id)
        keys = ("id", "tenant_id", "state_format", "state_json", "version", "created_at", "updated_at")
        return dict(zip(keys, row, strict=True))

    def save(self, tenant_id: str, session_id: str, state_json: str, expected_version: int) -> int:
        try:
            with self._db_lock:
                cursor = self._conn().execute(
                    "UPDATE privacy_sessions SET state_json = ?, version = version + 1, updated_at = ?"
                    " WHERE id = ? AND tenant_id = ? AND version = ?",
                    (state_json, _now(), session_id, tenant_id, expected_version),
                )
        except sqlite3.Error as error:
            raise StateStoreUnavailable("state store write failed") from error
        if cursor.rowcount != 1:
            raise VersionConflict(session_id)
        return expected_version + 1
