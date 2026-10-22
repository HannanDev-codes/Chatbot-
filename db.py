"""SQLite storage for users, conversations and messages."""

import hashlib
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "chat.db"


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            TEXT PRIMARY KEY,
                username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                salt          TEXT NOT NULL,
                created_at    REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title      TEXT NOT NULL,
                model      TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                content         TEXT NOT NULL,
                created_at      REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
            CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at);
            """
        )


# ── Auth helpers ──────────────────────────────────────────────

def _hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120_000).hex()


def create_user(username: str, email: str, password: str) -> dict | None:
    uid = uuid.uuid4().hex
    salt = secrets.token_hex(16)
    pw_hash = _hash_password(password, salt)
    now = time.time()
    try:
        with connect() as c:
            c.execute(
                "INSERT INTO users (id, username, email, password_hash, salt, created_at) VALUES (?,?,?,?,?,?)",
                (uid, username.strip(), email.strip().lower(), pw_hash, salt, now),
            )
        return {"id": uid, "username": username.strip(), "email": email.strip().lower()}
    except sqlite3.IntegrityError:
        return None


def authenticate(login: str, password: str) -> dict | None:
    """Login can be username or email."""
    with connect() as c:
        row = c.execute(
            "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
            (login.strip(), login.strip().lower()),
        ).fetchone()
    if not row:
        return None
    if _hash_password(password, row["salt"]) != row["password_hash"]:
        return None
    return {"id": row["id"], "username": row["username"], "email": row["email"]}


def get_user(uid: str) -> dict | None:
    with connect() as c:
        row = c.execute("SELECT id, username, email, created_at FROM users WHERE id = ?", (uid,)).fetchone()
    return dict(row) if row else None


# ── Conversations ─────────────────────────────────────────────

def create_conversation(user_id: str, title: str, model: str) -> dict:
    now = time.time()
    conv = {
        "id": uuid.uuid4().hex,
        "user_id": user_id,
        "title": title,
        "model": model,
        "created_at": now,
        "updated_at": now,
    }
    with connect() as c:
        c.execute(
            "INSERT INTO conversations (id, user_id, title, model, created_at, updated_at) "
            "VALUES (:id, :user_id, :title, :model, :created_at, :updated_at)",
            conv,
        )
    return conv


def list_conversations(user_id: str) -> list[dict]:
    with connect() as c:
        rows = c.execute(
            "SELECT id, title, model, created_at, updated_at FROM conversations "
            "WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(cid: str, user_id: str | None = None) -> dict | None:
    with connect() as c:
        if user_id:
            row = c.execute(
                "SELECT * FROM conversations WHERE id = ? AND user_id = ?", (cid, user_id)
            ).fetchone()
        else:
            row = c.execute("SELECT * FROM conversations WHERE id = ?", (cid,)).fetchone()
    return dict(row) if row else None


def get_messages(cid: str, limit: int | None = None) -> list[dict]:
    with connect() as c:
        if limit:
            rows = c.execute(
                "SELECT role, content, created_at FROM messages WHERE conversation_id = ? "
                "ORDER BY id DESC LIMIT ?",
                (cid, limit),
            ).fetchall()
            rows = list(reversed(rows))
        else:
            rows = c.execute(
                "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
                (cid,),
            ).fetchall()
    return [dict(r) for r in rows]


def add_message(cid: str, role: str, content: str) -> None:
    with connect() as c:
        c.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?,?,?,?)",
            (cid, role, content, time.time()),
        )


def touch(cid: str, model: str) -> None:
    with connect() as c:
        c.execute(
            "UPDATE conversations SET updated_at = ?, model = ? WHERE id = ?",
            (time.time(), model, cid),
        )


def rename_conversation(cid: str, title: str, user_id: str) -> bool:
    with connect() as c:
        cur = c.execute(
            "UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?",
            (title, cid, user_id),
        )
    return cur.rowcount > 0


def delete_conversation(cid: str, user_id: str) -> bool:
    with connect() as c:
        cur = c.execute(
            "DELETE FROM conversations WHERE id = ? AND user_id = ?", (cid, user_id)
        )
    return cur.rowcount > 0
