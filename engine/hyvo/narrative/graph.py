"""The rolling knowledge graph (SPEC §10): tokens and topics, the signals that mention them, and which appear together.

It is a local SQLite file. SPEC §10 names MiroFish's graph building on Zep Cloud, whose free tier the daily volume would pass
and which needs an account (docs/OPEN_ITEMS.md item 6). This needs neither, and survives a restart. Signals older than the
window are pruned, and an entity goes when its last mention does.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime
from pathlib import Path

from .signals import Kind, Signal

_SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  url TEXT NOT NULL,
  at REAL NOT NULL,
  seen_at REAL NOT NULL,
  numbers TEXT NOT NULL,
  refs TEXT NOT NULL,
  entities TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_by_time ON signals (at);
CREATE TABLE IF NOT EXISTS mentions (
  signal_key TEXT NOT NULL REFERENCES signals (key) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (signal_key, entity)
);
CREATE INDEX IF NOT EXISTS mentions_by_entity ON mentions (entity);
CREATE TABLE IF NOT EXISTS entities (
  name TEXT PRIMARY KEY,
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS used (
  entity TEXT NOT NULL,
  purpose TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (entity, purpose)
);
"""


class NarrativeGraph:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path)
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(_SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> NarrativeGraph:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def add(self, signals: Iterable[Signal], now: datetime) -> int:
        """Store what is new; a signal seen again changes nothing. Returns how many were new."""
        added = 0
        with self._db:
            for signal in signals:
                inserted = self._db.execute(
                    """INSERT OR IGNORE INTO signals (key, kind, source, title, text, url, at, seen_at, numbers, refs, entities)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        signal.key,
                        signal.kind,
                        signal.source,
                        signal.title,
                        signal.text,
                        signal.url,
                        signal.at.timestamp(),
                        now.timestamp(),
                        json.dumps(dict(signal.numbers)),
                        json.dumps(dict(signal.refs)),
                        json.dumps(list(signal.entities)),
                    ),
                ).rowcount
                if not inserted:
                    continue
                added += 1
                for entity in signal.entities:
                    self._db.execute("INSERT OR IGNORE INTO mentions (signal_key, entity) VALUES (?, ?)", (signal.key, entity))
                    self._db.execute(
                        """INSERT INTO entities (name, first_seen, last_seen) VALUES (?, ?, ?)
                           ON CONFLICT(name) DO UPDATE SET last_seen = MAX(last_seen, excluded.last_seen),
                                                           first_seen = MIN(first_seen, excluded.first_seen)""",
                        (entity, signal.at.timestamp(), signal.at.timestamp()),
                    )
        return added

    def prune(self, before: datetime) -> int:
        """Drop what is older than ``before``. Returns how many signals went."""
        cutoff = before.timestamp()
        with self._db:
            gone = self._db.execute("DELETE FROM signals WHERE at < ?", (cutoff,)).rowcount
            self._db.execute("DELETE FROM entities WHERE name NOT IN (SELECT entity FROM mentions)")
            self._db.execute("DELETE FROM used WHERE at < ?", (cutoff,))
        return gone

    def signals(self, *, since: datetime, until: datetime | None = None, kinds: Sequence[Kind] | None = None) -> list[Signal]:
        """Newest first."""
        query = "SELECT * FROM signals WHERE at >= ? AND at <= ?"
        args: list[object] = [since.timestamp(), (until or datetime.max.replace(tzinfo=UTC)).timestamp()]
        if kinds:
            query += f" AND kind IN ({','.join('?' * len(kinds))})"
            args += kinds
        return [_signal(row) for row in self._rows(query + " ORDER BY at DESC, key", args)]

    def about(self, entity: str, *, since: datetime, until: datetime | None = None) -> list[Signal]:
        """What mentions ``entity``, oldest first."""
        rows = self._rows(
            """SELECT s.* FROM signals s JOIN mentions m ON m.signal_key = s.key
               WHERE m.entity = ? AND s.at >= ? AND s.at <= ? ORDER BY s.at, s.key""",
            [entity, since.timestamp(), (until or datetime.max.replace(tzinfo=UTC)).timestamp()],
        )
        return [_signal(row) for row in rows]

    def top_entities(self, *, since: datetime, kinds: Sequence[Kind] = ("news", "cast"), limit: int = 8) -> list[tuple[str, int]]:
        """What is mentioned most since ``since``: the day's narratives."""
        rows = self._db.execute(
            f"""SELECT m.entity, COUNT(*) AS n FROM mentions m JOIN signals s ON s.key = m.signal_key
                WHERE s.at >= ? AND s.kind IN ({",".join("?" * len(kinds))})
                GROUP BY m.entity ORDER BY n DESC, m.entity LIMIT ?""",
            [since.timestamp(), *kinds, limit],
        ).fetchall()
        return [(name, count) for name, count in rows]

    def neighbors(self, entity: str, *, since: datetime, limit: int = 5) -> list[tuple[str, int]]:
        """The graph's edges: what appears together with ``entity``, and how often."""
        rows = self._db.execute(
            """SELECT other.entity, COUNT(*) AS n FROM mentions mine
               JOIN mentions other ON other.signal_key = mine.signal_key AND other.entity <> mine.entity
               JOIN signals s ON s.key = mine.signal_key
               WHERE mine.entity = ? AND s.at >= ?
               GROUP BY other.entity ORDER BY n DESC, other.entity LIMIT ?""",
            (entity, since.timestamp(), limit),
        ).fetchall()
        return [(name, count) for name, count in rows]

    def first_seen(self, entity: str) -> datetime | None:
        row = self._db.execute("SELECT first_seen FROM entities WHERE name = ?", (entity,)).fetchone()
        return datetime.fromtimestamp(row[0], UTC) if row else None

    def mark_used(self, entity: str, purpose: str, now: datetime) -> None:
        with self._db:
            self._db.execute(
                "INSERT INTO used (entity, purpose, at) VALUES (?, ?, ?) ON CONFLICT(entity, purpose) DO UPDATE SET at = excluded.at",
                (entity, purpose, now.timestamp()),
            )

    def used_since(self, purpose: str, since: datetime) -> set[str]:
        rows = self._db.execute("SELECT entity FROM used WHERE purpose = ? AND at >= ?", (purpose, since.timestamp())).fetchall()
        return {row[0] for row in rows}

    def _rows(self, query: str, args: Sequence[object]) -> list[sqlite3.Row]:
        self._db.row_factory = sqlite3.Row
        try:
            return self._db.execute(query, args).fetchall()
        finally:
            self._db.row_factory = None


def _signal(row: sqlite3.Row) -> Signal:
    return Signal(
        kind=row["kind"],
        source=row["source"],
        key=row["key"],
        title=row["title"],
        at=datetime.fromtimestamp(row["at"], UTC),
        text=row["text"],
        url=row["url"],
        entities=tuple(json.loads(row["entities"])),
        numbers=json.loads(row["numbers"]),
        refs=json.loads(row["refs"]),
    )
