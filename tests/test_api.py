from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime
from pathlib import Path

from fastapi.testclient import TestClient

from server import db
from server.main import create_app

from .conftest import TOKEN, multipart

JSONLD = {
    "@type": "JobPosting",
    "title": "Software Engineering Intern",
    "hiringOrganization": {"@type": "Organization", "name": "Google"},
    "jobLocation": {"address": {"addressLocality": "Mountain View", "addressRegion": "CA"}},
    "employmentType": "INTERN",
    "datePosted": "2026-09-01",
    "identifier": {"value": "R12345"},
}

RESUME = b"%PDF-fake resume bytes"
COVER = b"%PDF-fake cover letter bytes"


def full_payload(**overrides) -> dict:
    payload = {
        "company": "Google",
        "position": "SWE",
        "folder_name": "google_swe",
        "posting": {
            "url": "https://boards.greenhouse.io/google/jobs/123?utm_source=x&gh_jid=123",
            "title": "Software Engineering Intern - Google",
            "text": "Minimum qualifications ... responsibilities ...",
            "html": "<html><body>posting</body></html>",
            "jsonld": JSONLD,
        },
        "pages": [
            {"url": "https://boards.greenhouse.io/google/jobs/123", "title": "P1", "text": "page one"},
        ],
        "documents": [
            {"kind": "resume", "filename": "Resume.pdf", "mime": "application/pdf"},
            {"kind": "cover_letter", "filename": "Cover Letter.pdf", "mime": "application/pdf"},
            {"kind": "other", "filename": "transcript.pdf", "mime": "application/pdf"},
        ],
        "form_answers": [
            {"page_url": "https://boards.greenhouse.io/google/jobs/123",
             "field_label": "Why Google?", "field_name": "q1", "value": "Search is neat"},
        ],
    }
    payload.update(overrides)
    return payload


FILES = [
    ("Resume.pdf", RESUME, "application/pdf"),
    ("Cover Letter.pdf", COVER, "application/pdf"),
    ("transcript.pdf", b"transcript", "application/pdf"),
]


def query(config, sql, *args):
    conn = sqlite3.connect(config.db_path)
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


# ---------------------------------------------------------------- auth / hosts


def test_health_needs_no_token(config):
    client = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    assert client.get("/health").json() == {"ok": True}


def test_missing_or_wrong_token_is_rejected(config):
    client = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    assert client.get("/settings").status_code == 401
    assert client.get("/settings", headers={"X-API-Token": "nope"}).status_code == 401
    assert client.get("/settings", headers={"X-API-Token": TOKEN}).status_code == 200


def test_non_loopback_host_header_is_rejected(config):
    client = TestClient(create_app(config), base_url="http://evil.example.com",
                        headers={"X-API-Token": TOKEN})
    assert client.get("/health").status_code == 400


def test_cors_allows_extension_origin_only(client):
    ext = "chrome-extension://" + "a" * 32
    ok = client.options("/settings", headers={
        "Origin": ext, "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "X-API-Token"})
    assert ok.headers.get("access-control-allow-origin") == ext

    bad = client.options("/settings", headers={
        "Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


# ---------------------------------------------------------------- settings


def test_settings_default_base_path(client, config):
    body = client.get("/settings").json()
    assert body["base_path"] == str(config.base_path)
    assert body["month_folder"]["exists"] is False


def test_put_settings_validates_and_persists(client, tmp_path):
    assert client.put("/settings", json={"base_path": "relative/path"}).status_code == 400
    assert client.put("/settings", json={"base_path": str(tmp_path / "missing")}).status_code == 400

    new_base = tmp_path / "Junior"
    new_base.mkdir()
    r = client.put("/settings", json={"base_path": str(new_base)})
    assert r.status_code == 200
    assert client.get("/settings").json()["base_path"] == str(new_base)


def test_month_folder_check_and_create(client, config):
    month = datetime.now().strftime("%B")
    info = client.get("/settings/month-folder").json()
    assert info == {"month": month, "path": str(config.base_path / month), "exists": False}

    created = client.post("/settings/month-folder").json()
    assert created["created"] is True and created["exists"] is True
    assert (config.base_path / month).is_dir()

    again = client.post("/settings/month-folder").json()
    assert again["created"] is False


# ---------------------------------------------------------------- create


def test_create_application_writes_files_and_rows(client, config, month_dir):
    r = client.post("/applications", files=multipart(full_payload(), FILES))
    assert r.status_code == 201, r.text
    body = r.json()

    folder = month_dir / "google_swe"
    assert body["folder_path"] == str(folder)
    # Resume and cover letter on disk, "other" only in SQLite.
    assert sorted(p.name for p in folder.iterdir()) == ["Cover Letter.pdf", "Resume.pdf"]
    assert (folder / "Resume.pdf").read_bytes() == RESUME

    app = query(config, "SELECT * FROM applications")[0]
    assert app["company"] == "Google" and app["position"] == "SWE"
    assert app["posting_url_normalized"] == "boards.greenhouse.io/google/jobs/123?gh_jid=123"
    assert app["ats_platform"] == "greenhouse"
    assert app["location"] == "Mountain View, CA"
    assert app["job_id"] == "R12345"
    assert app["employment_type"] == "INTERN"
    assert app["posting_html"] == b"<html><body>posting</body></html>"

    docs = query(config, "SELECT kind, filename, file_path, sha256, content FROM documents ORDER BY id")
    assert [d["kind"] for d in docs] == ["resume", "cover_letter", "other"]
    assert docs[0]["content"] == RESUME
    assert docs[0]["sha256"] == hashlib.sha256(RESUME).hexdigest()
    assert docs[2]["file_path"] is None

    pages = query(config, "SELECT url_normalized FROM application_pages")
    assert pages == [{"url_normalized": "boards.greenhouse.io/google/jobs/123"}]

    answers = query(config, "SELECT field_label, value FROM form_answers")
    assert answers == [{"field_label": "Why Google?", "value": "Search is neat"}]


def test_fts_row_includes_answers(client, config, month_dir):
    client.post("/applications", files=multipart(full_payload(), FILES))
    hits = query(config, "SELECT rowid FROM applications_fts WHERE applications_fts MATCH 'neat'")
    assert len(hits) == 1


def test_month_folder_missing_returns_409(client, config):
    r = client.post("/applications", files=multipart(full_payload(), FILES))
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "month_folder_missing"
    assert query(config, "SELECT count(*) AS n FROM applications")[0]["n"] == 0


def test_custom_save_dir(client, tmp_path):
    custom = tmp_path / "Elsewhere"
    custom.mkdir()
    r = client.post("/applications", files=multipart(full_payload(save_dir=str(custom)), FILES))
    assert r.status_code == 201, r.text
    assert (custom / "google_swe" / "Resume.pdf").exists()


def test_custom_save_dir_must_exist(client, tmp_path):
    r = client.post("/applications",
                    files=multipart(full_payload(save_dir=str(tmp_path / "nope")), FILES))
    assert r.status_code == 400


def test_folder_name_collisions(client, month_dir):
    paths = [
        client.post("/applications", files=multipart(full_payload(), FILES)).json()["folder_path"]
        for _ in range(3)
    ]
    names = [Path(p).name for p in paths]
    today = datetime.now().strftime("%Y-%m-%d")
    assert names[0] == "google_swe"
    assert names[1] == f"google_swe_{today}"
    assert names[2].startswith(f"google_swe_{today}_") and len(names[2]) == len(names[1]) + 5


def test_folder_name_is_sanitized_and_defaulted(client, month_dir):
    r = client.post("/applications", files=multipart(
        full_payload(folder_name="../../etc/Evil Name!"), []), )
    assert r.status_code == 400  # documents/files mismatch
    r = client.post("/applications", files=multipart(
        full_payload(folder_name="../../etc/Evil Name!", documents=[]), []))
    assert Path(r.json()["folder_path"]) == month_dir / "etc_evil_name"

    r = client.post("/applications", files=multipart(
        full_payload(folder_name="", company="", position="", documents=[]), []))
    # Falls back to JSON-LD company + title.
    assert Path(r.json()["folder_path"]).name == "google_software_engineering_intern"


def test_uploaded_filename_cannot_escape_folder(client, month_dir):
    payload = full_payload(documents=[{"kind": "resume", "filename": "../../../evil.pdf"}])
    r = client.post("/applications", files=multipart(payload, [("x.pdf", RESUME, "application/pdf")]))
    assert r.status_code == 201
    folder = Path(r.json()["folder_path"])
    assert [p.name for p in folder.iterdir()] == ["evil.pdf"]
    assert not (month_dir.parent.parent / "evil.pdf").exists()


def test_duplicate_filenames_in_one_application(client, month_dir):
    payload = full_payload(documents=[
        {"kind": "resume", "filename": "doc.pdf"},
        {"kind": "cover_letter", "filename": "doc.pdf"},
    ])
    r = client.post("/applications", files=multipart(
        payload, [("doc.pdf", RESUME, "application/pdf"), ("doc.pdf", COVER, "application/pdf")]))
    folder = Path(r.json()["folder_path"])
    assert sorted(p.name for p in folder.iterdir()) == ["doc (2).pdf", "doc.pdf"]


def test_invalid_payload_is_422(client, month_dir):
    payload = full_payload(documents=[{"kind": "banana", "filename": "x.pdf"}])
    r = client.post("/applications", files=multipart(payload, [("x.pdf", b"x", "application/pdf")]))
    assert r.status_code == 422


def test_db_failure_removes_created_folder(client, config, month_dir):
    conn = db.connect(config.db_path)
    conn.execute("CREATE TRIGGER boom BEFORE INSERT ON form_answers BEGIN SELECT RAISE(ABORT, 'boom'); END;")
    conn.commit()
    conn.close()

    client = TestClient(create_app(config), base_url="http://127.0.0.1:8765",
                        headers={"X-API-Token": TOKEN}, raise_server_exceptions=False)
    r = client.post("/applications", files=multipart(full_payload(), FILES))
    assert r.status_code == 500
    assert list(month_dir.iterdir()) == []
    assert query(config, "SELECT count(*) AS n FROM applications")[0]["n"] == 0
    assert query(config, "SELECT count(*) AS n FROM documents")[0]["n"] == 0


def test_large_posting_html(client, config, month_dir):
    html = "<p>" + "x" * 3_000_000 + "</p>"
    payload = full_payload(posting={"url": "https://jobs.lever.co/acme/1", "html": html})
    r = client.post("/applications", files=multipart(payload, FILES))
    assert r.status_code == 201, r.text
    assert len(query(config, "SELECT posting_html FROM applications")[0]["posting_html"]) == len(html)


def test_pages_default_to_posting(client, config, month_dir):
    payload = full_payload(pages=[])
    client.post("/applications", files=multipart(payload, FILES))
    pages = query(config, "SELECT url FROM application_pages")
    assert pages == [{"url": payload["posting"]["url"]}]


# ---------------------------------------------------------------- read


def test_list_and_detail(client, month_dir):
    app_id = client.post("/applications", files=multipart(full_payload(), FILES)).json()["id"]
    listing = client.get("/applications").json()
    assert [a["id"] for a in listing] == [app_id]

    detail = client.get(f"/applications/{app_id}").json()
    assert detail["company"] == "Google"
    assert [d["kind"] for d in detail["documents"]] == ["resume", "cover_letter", "other"]
    assert detail["documents"][0]["size"] == len(RESUME)
    assert "content" not in detail["documents"][0]
    assert len(detail["form_answers"]) == 1

    assert client.get("/applications/9999").status_code == 404


def test_copy_numbers_are_stripped_from_saved_resume_and_cover_letter(client, config, month_dir):
    payload = full_payload(documents=[
        {"kind": "resume", "filename": "Ada_Lovelace_Resume(75).pdf", "mime": "application/pdf"},
        {"kind": "cover_letter", "filename": "Ada_Lovelace_Cover_Letter (2).pdf", "mime": "application/pdf"},
        {"kind": "other", "filename": "transcript (3).pdf", "mime": "application/pdf"},
    ])
    r = client.post("/applications", files=multipart(payload, [
        ("Ada_Lovelace_Resume(75).pdf", RESUME, "application/pdf"),
        ("Ada_Lovelace_Cover_Letter (2).pdf", COVER, "application/pdf"),
        ("transcript (3).pdf", b"t", "application/pdf"),
    ]))
    assert r.status_code == 201, r.text
    folder = Path(r.json()["folder_path"])
    assert sorted(p.name for p in folder.iterdir()) == ["Ada_Lovelace_Cover_Letter.pdf", "Ada_Lovelace_Resume.pdf"]
    names = [d["filename"] for d in query(config, "SELECT filename FROM documents ORDER BY id")]
    assert names == ["Ada_Lovelace_Resume.pdf", "Ada_Lovelace_Cover_Letter.pdf", "transcript (3).pdf"]
