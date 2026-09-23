"""SQLite schema, migrations and the FTS5 index.

The FTS table mixes columns from three tables (applications, documents,
form_answers), so it can't use FTS5's single-table external-content mode.
Instead it's a regular FTS5 table keyed by application id, and triggers on
all three tables rebuild an application's row whenever any of them change.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

SCHEMA_V1 = """
CREATE TABLE applications (
  id INTEGER PRIMARY KEY,
  company TEXT, position TEXT,
  folder_name TEXT, folder_path TEXT,
  applied_at TEXT,
  posting_url TEXT, posting_url_normalized TEXT,
  posting_title TEXT, posting_text TEXT, posting_html BLOB,
  location TEXT, employment_type TEXT, salary TEXT,
  date_posted TEXT, job_id TEXT, ats_platform TEXT,
  jsonld TEXT
);
CREATE INDEX idx_applications_url ON applications(posting_url_normalized);
CREATE INDEX idx_applications_job_id ON applications(job_id);
CREATE INDEX idx_applications_applied_at ON applications(applied_at);

CREATE TABLE application_pages (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  url TEXT, url_normalized TEXT, title TEXT, text TEXT, captured_at TEXT
);
CREATE INDEX idx_pages_app ON application_pages(application_id);
CREATE INDEX idx_pages_url ON application_pages(url_normalized);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  kind TEXT CHECK(kind IN ('resume','cover_letter','other')),
  filename TEXT, file_path TEXT, mime TEXT, sha256 TEXT,
  content BLOB, text_content TEXT
);
CREATE INDEX idx_documents_app ON documents(application_id);

CREATE TABLE form_answers (
  id INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  page_url TEXT, field_label TEXT, field_name TEXT, value TEXT
);
CREATE INDEX idx_answers_app ON form_answers(application_id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

CREATE VIRTUAL TABLE applications_fts USING fts5(
  company, position, posting_title, posting_text,
  posting_url, document_text, form_text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
"""


def _refresh_fts_sql(app_id: str) -> str:
    """Statements that rebuild the FTS row for application `app_id`.

    If the application no longer exists the INSERT selects nothing, so this is
    also correct for cascaded deletes of child rows.
    """
    return f"""
  DELETE FROM applications_fts WHERE rowid = {app_id};
  INSERT INTO applications_fts(rowid, company, position, posting_title,
                               posting_text, posting_url, document_text, form_text)
  SELECT a.id, a.company, a.position, a.posting_title, a.posting_text, a.posting_url,
         (SELECT group_concat(d.text_content, ' ') FROM documents d
           WHERE d.application_id = a.id),
         (SELECT group_concat(coalesce(f.field_label, '') || ' ' || coalesce(f.value, ''), ' ')
            FROM form_answers f WHERE f.application_id = a.id)
  FROM applications a WHERE a.id = {app_id};
"""


def _fts_triggers() -> str:
    parts = [
        f"CREATE TRIGGER applications_ai AFTER INSERT ON applications BEGIN{_refresh_fts_sql('NEW.id')}END;",
        f"CREATE TRIGGER applications_au AFTER UPDATE ON applications BEGIN{_refresh_fts_sql('NEW.id')}END;",
        "CREATE TRIGGER applications_ad AFTER DELETE ON applications BEGIN\n"
        "  DELETE FROM applications_fts WHERE rowid = OLD.id;\nEND;",
    ]
    for table in ("documents", "form_answers"):
        parts += [
            f"CREATE TRIGGER {table}_ai AFTER INSERT ON {table} BEGIN{_refresh_fts_sql('NEW.application_id')}END;",
            f"CREATE TRIGGER {table}_au AFTER UPDATE ON {table} BEGIN"
            f"{_refresh_fts_sql('OLD.application_id')}{_refresh_fts_sql('NEW.application_id')}END;",
            f"CREATE TRIGGER {table}_ad AFTER DELETE ON {table} BEGIN{_refresh_fts_sql('OLD.application_id')}END;",
        ]
    return "\n".join(parts)


# Each entry migrates the DB from version i to i+1. Append only; never edit.
MIGRATIONS: list[str] = [
    SCHEMA_V1 + _fts_triggers(),
]


def connect(db_path: Path) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i in range(version, len(MIGRATIONS)):
        # executescript commits any open transaction first; wrap each step so a
        # failed migration leaves the previous version intact.
        try:
            conn.executescript(f"BEGIN;\n{MIGRATIONS[i]}\nPRAGMA user_version = {i + 1};\nCOMMIT;")
        except sqlite3.Error:
            if conn.in_transaction:
                conn.rollback()
            raise


def init_db(db_path: Path) -> None:
    conn = connect(db_path)
    try:
        migrate(conn)
    finally:
        conn.close()


def get_setting(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
