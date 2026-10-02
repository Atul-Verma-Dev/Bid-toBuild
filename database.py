"""SQLite storage layer. Plain sqlite3, no ORM, so it stays easy to read."""

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from auth import hash_password

DB_PATH = os.getenv("DB_PATH", "app.db")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def get_db():
    """FastAPI dependency: one connection per request, committed on success."""
    connection = get_connection()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'user'))
);

CREATE TABLE IF NOT EXISTS venues (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    capacity     INTEGER NOT NULL,
    occupancy    INTEGER NOT NULL DEFAULT 0,
    opening_time TEXT NOT NULL DEFAULT '09:00',
    closing_time TEXT NOT NULL DEFAULT '21:00',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message    TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('INFO', 'WARNING', 'REDIRECT', 'EMERGENCY')),
    venue_id   INTEGER REFERENCES venues(id) ON DELETE SET NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
);
"""


def init_db() -> None:
    """Create tables and seed demo data on first run."""
    connection = get_connection()
    try:
        connection.executescript(SCHEMA)
        _seed_users(connection)
        _seed_venues(connection)
        _seed_announcements(connection)
        connection.commit()
    finally:
        connection.close()


def _seed_users(connection: sqlite3.Connection) -> None:
    if connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
        return
    connection.executemany(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        [
            ("admin", hash_password("admin123"), "admin"),
            ("user", hash_password("user123"), "user"),
        ],
    )


def _seed_venues(connection: sqlite3.Connection) -> None:
    if connection.execute("SELECT COUNT(*) FROM venues").fetchone()[0]:
        return
    timestamp = now_iso()
    # (name, capacity, occupancy, opening, closing) — deliberately varied levels.
    venues = [
        ("Main Auditorium", 800, 760, "08:00", "23:00"),   # 95.0  CRITICAL
        ("Food Court", 600, 210, "08:00", "23:00"),        # 35.0  NORMAL
        ("Tech Expo Hall", 600, 510, "08:00", "23:00"),    # 85.0  WARNING
        ("Workshop Arena", 500, 420, "08:00", "23:00"),    # 84.0  MODERATE
        ("Central Plaza", 600, 700, "08:00", "23:00"),     # 116.7 OVERCROWDED
        ("VIP Lounge", 150, 120, "08:00", "23:00"),        # 80.0  MODERATE
        ("Sunrise Stage", 300, 0, "06:00", "06:30"),       # inactive right now
    ]
    connection.executemany(
        """INSERT INTO venues
           (name, capacity, occupancy, opening_time, closing_time, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [(*venue, timestamp, timestamp) for venue in venues],
    )


def _seed_announcements(connection: sqlite3.Connection) -> None:
    if connection.execute("SELECT COUNT(*) FROM announcements").fetchone()[0]:
        return
    timestamp = now_iso()
    announcements = [
        ("Welcome to Smart Event! All gates are now open.", "INFO"),
        ("Tech Expo Hall is nearing capacity. Please plan accordingly.", "WARNING"),
        ("Central Plaza is overcrowded. Head to Food Court for more space.", "REDIRECT"),
    ]
    connection.executemany(
        "INSERT INTO announcements (message, type, created_at) VALUES (?, ?, ?)",
        [(message, kind, timestamp) for message, kind in announcements],
    )
