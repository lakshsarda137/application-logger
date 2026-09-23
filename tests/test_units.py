from __future__ import annotations

import io
import json
import sqlite3
from datetime import datetime
from pathlib import Path

import pytest

from server import db, storage
from server.config import load_config
from server.extract import extract_text
from server.jobposting import parse_jobposting
from server.urls import detect_ats, is_ats_page, is_never_capture, normalize_url, site_of

NOW = datetime(2026, 10, 3, 14, 32)


# ---------------------------------------------------------------- config


def test_config_created_with_token_on_first_run(tmp_path):
    path = tmp_path / "config.local.json"
    cfg = load_config(path)
    assert len(cfg.api_token) >= 32
    saved = json.loads(path.read_text())
    assert saved["api_token"] == cfg.api_token
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    # Stable across loads.
    assert load_config(path).api_token == cfg.api_token


def test_config_replaces_placeholder_token_and_expands_paths(tmp_path):
    path = tmp_path / "config.local.json"
    path.write_text(json.dumps({"api_token": "generated-on-first-run", "base_path": "~/X"}))
    cfg = load_config(path)
    assert cfg.api_token != "generated-on-first-run"
    assert cfg.base_path == Path.home() / "X"


def test_config_rejects_non_loopback_host(tmp_path):
    path = tmp_path / "config.local.json"
    path.write_text(json.dumps({"api_token": "t", "host": "0.0.0.0"}))
    with pytest.raises(ValueError):
        load_config(path)


# ---------------------------------------------------------------- storage


def test_month_name_is_locale_independent():
    assert storage.month_name(NOW) == "October"
    assert storage.month_folder(Path("/b"), NOW) == Path("/b/October")


@pytest.mark.parametrize("raw, expected", [
    ("google_swe", "google_swe"),
    ("Google / SWE (Intern)", "google_swe_intern"),
    ("Café Déjà", "cafe_deja"),
    ("../../etc", "etc"),
    ("", "application"),
    ("!!!", "application"),
    ("a" * 200, "a" * 80),
])
def test_sanitize_folder_name(raw, expected):
    assert storage.sanitize_folder_name(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ("Resume.pdf", "Resume.pdf"),
    ("../../evil.pdf", "evil.pdf"),
    ("C:\\Users\\me\\cv.docx", "cv.docx"),
    (".hidden", "hidden"),
    ("a:b*c?.pdf", "a_b_c_.pdf"),
    ("", "file"),
])
def test_sanitize_filename(raw, expected):
    assert storage.sanitize_filename(raw) == expected


def test_sanitize_filename_keeps_extension_when_truncating():
    name = storage.sanitize_filename("x" * 300 + ".pdf")
    assert len(name) == storage.MAX_FILENAME and name.endswith(".pdf")


@pytest.mark.parametrize("raw, expected", [
    ("Ada_Lovelace_Resume(75).pdf", "Ada_Lovelace_Resume.pdf"),
    ("Ada_Lovelace_Resume (2).pdf", "Ada_Lovelace_Resume.pdf"),
    ("Resume copy.docx", "Resume.docx"),
    ("Resume copy 3.docx", "Resume.docx"),
    ("Resume (2) copy.pdf", "Resume.pdf"),
    ("Cover_Letter(1)(2).pdf", "Cover_Letter.pdf"),
    ("Ada_Lovelace_Resume.pdf", "Ada_Lovelace_Resume.pdf"),
    ("Ada_Lovelace_Resume_Quant.pdf", "Ada_Lovelace_Resume_Quant.pdf"),
    ("Resume 2026.pdf", "Resume 2026.pdf"),
    ("Resume-1.pdf", "Resume-1.pdf"),
    ("Copywriter Resume.pdf", "Copywriter Resume.pdf"),
    ("(75).pdf", "(75).pdf"),
    ("Resume(3)", "Resume"),
])
def test_strip_copy_suffix(raw, expected):
    assert storage.strip_copy_suffix(raw) == expected


def test_create_unique_folder_collision_sequence(tmp_path):
    names = [storage.create_unique_folder(tmp_path, "google_swe", NOW).name for _ in range(4)]
    assert names == [
        "google_swe",
        "google_swe_2026-10-03",
        "google_swe_2026-10-03_1432",
        "google_swe_2026-10-03_1432_2",
    ]


def test_create_unique_folder_requires_parent(tmp_path):
    with pytest.raises(FileNotFoundError):
        storage.create_unique_folder(tmp_path / "missing", "x", NOW)


def test_remove_folder_safely(tmp_path):
    base = tmp_path / "base"
    inside = base / "October" / "google_swe"
    inside.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()

    assert storage.remove_folder_safely(outside, base) is False and outside.exists()
    assert storage.remove_folder_safely(base, base) is False and base.exists()
    assert storage.remove_folder_safely(base / "October" / ".." / ".." / "outside", base) is False

    link = base / "link"
    link.symlink_to(outside)
    assert storage.remove_folder_safely(link, base) is False and outside.exists()

    assert storage.remove_folder_safely(inside, base) is True and not inside.exists()


# ---------------------------------------------------------------- urls


@pytest.mark.parametrize("raw, expected", [
    ("https://www.Example.com/jobs/1/", "example.com/jobs/1"),
    ("http://example.com/jobs/1#apply", "example.com/jobs/1"),
    ("https://example.com:443/a", "example.com/a"),
    ("https://example.com:8080/a", "example.com:8080/a"),
    ("https://boards.greenhouse.io/acme/jobs/1?gh_src=abc&utm_source=li", "boards.greenhouse.io/acme/jobs/1"),
    ("https://acme.com/careers?gh_jid=42&utm_medium=x", "acme.com/careers?gh_jid=42"),
    ("https://www.linkedin.com/jobs/view/1?trk=a&refId=b&trackingId=c", "linkedin.com/jobs/view/1"),
    ("https://x.com/a?b=2&a=1", "x.com/a?a=1&b=2"),
    ("https://acme.wd5.myworkdayjobs.com/en-US/External/job/NYC/SWE_R1", "acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1"),
    ("https://example.com", "example.com"),
    ("chrome://extensions", ""),
    ("", ""),
    (None, ""),
])
def test_normalize_url(raw, expected):
    assert normalize_url(raw) == expected


def test_detect_ats():
    assert detect_ats("https://boards.greenhouse.io/acme") == "greenhouse"
    assert detect_ats("https://acme.wd1.myworkdayjobs.com/x") == "workday"
    assert detect_ats("https://jobs.lever.co/acme") == "lever"
    assert detect_ats("https://notlever.co/acme") is None
    assert detect_ats("https://acme.com/careers") is None


def test_site_of():
    assert site_of("https://careers.acme.com/jobs/1") == "acme.com"
    assert site_of("https://www.linkedin.com/in/x") == "linkedin.com"
    assert site_of("https://jobs.acme.co.uk/1") == "acme.co.uk"
    assert site_of("https://127.0.0.1:8765/") == "127.0.0.1"
    assert site_of("") == "" and site_of("not a url") == ""


def test_is_ats_page_is_path_aware_for_linkedin():
    assert is_ats_page("https://www.linkedin.com/jobs/view/1")
    assert not is_ats_page("https://www.linkedin.com/in/me/")
    assert not is_ats_page("https://www.linkedin.com/feed/")
    assert is_ats_page("https://job-boards.greenhouse.io/embed/job_app?for=x")
    assert not is_ats_page("https://seatgeek.com/jobs/1")


def test_is_never_capture():
    assert is_never_capture("https://mail.google.com/mail/u/0/#inbox")
    assert is_never_capture("https://docs.google.com/document/d/1")
    assert is_never_capture("https://www.instagram.com/x")
    assert not is_never_capture("https://careers.google.com/jobs/1")


# ---------------------------------------------------------------- jobposting


def test_parse_jobposting_full():
    fields = parse_jobposting({
        "title": "SWE Intern",
        "hiringOrganization": {"name": "Acme"},
        "jobLocation": [
            {"address": {"addressLocality": "NYC", "addressRegion": "NY", "addressCountry": "US"}},
            {"address": {"addressLocality": "SF", "addressRegion": "CA"}},
        ],
        "employmentType": ["INTERN", "FULL_TIME"],
        "baseSalary": {"currency": "USD", "value": {"minValue": 40, "maxValue": 50, "unitText": "HOUR"}},
        "datePosted": "2026-09-01",
        "identifier": {"@type": "PropertyValue", "value": 123},
    })
    assert fields == {
        "company": "Acme",
        "posting_title": "SWE Intern",
        "location": "NYC, NY, US; SF, CA",
        "employment_type": "INTERN, FULL_TIME",
        "salary": "USD 40–50 per hour",
        "date_posted": "2026-09-01",
        "job_id": "123",
    }


def test_parse_jobposting_tolerates_junk():
    assert parse_jobposting(None) == {}
    assert parse_jobposting("not json") == {}
    assert parse_jobposting([1, 2]) == {}
    fields = parse_jobposting('{"title": "X", "jobLocationType": "TELECOMMUTE"}')
    assert fields["posting_title"] == "X" and fields["location"] == "Remote"


# ---------------------------------------------------------------- extract


def test_extract_text_docx():
    import docx

    document = docx.Document()
    document.add_paragraph("Education Experience Projects")
    buf = io.BytesIO()
    document.save(buf)
    assert "Experience" in extract_text(buf.getvalue(), "resume.docx")


def test_extract_text_bad_input_returns_empty():
    assert extract_text(b"not a pdf", "x.pdf") == ""
    assert extract_text(b"\x00\x01", "x.bin") == ""
    assert extract_text(b"hello", "x.txt") == "hello"


# ---------------------------------------------------------------- db


def _app(conn, company="Acme"):
    return conn.execute("INSERT INTO applications(company, position) VALUES (?, 'SWE')", (company,)).lastrowid


def _fts(conn, q):
    return [r[0] for r in conn.execute("SELECT rowid FROM applications_fts WHERE applications_fts MATCH ?", (q,))]


def test_migrate_is_idempotent(tmp_path):
    db.init_db(tmp_path / "a.db")
    db.init_db(tmp_path / "a.db")
    conn = db.connect(tmp_path / "a.db")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == len(db.MIGRATIONS)


def test_fts_triggers_track_children(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    db.migrate(conn)
    app_id = _app(conn)
    assert _fts(conn, "acme") == [app_id]
    assert _fts(conn, "acm*") == [app_id]

    doc_id = conn.execute(
        "INSERT INTO documents(application_id, kind, text_content) VALUES (?, 'resume', 'kubernetes')",
        (app_id,)).lastrowid
    conn.execute("INSERT INTO form_answers(application_id, field_label, value) VALUES (?, 'Why', 'rockets')",
                 (app_id,))
    assert _fts(conn, "kubernetes") == [app_id]
    assert _fts(conn, "rockets") == [app_id]

    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    assert _fts(conn, "kubernetes") == []

    conn.execute("UPDATE applications SET company = 'Globex' WHERE id = ?", (app_id,))
    assert _fts(conn, "acme") == [] and _fts(conn, "globex") == [app_id]
    assert _fts(conn, "rockets") == [app_id]


def test_delete_cascades_and_clears_fts(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    db.migrate(conn)
    keep, gone = _app(conn, "Keep"), _app(conn, "Gone")
    for app_id in (keep, gone):
        conn.execute("INSERT INTO documents(application_id, kind, text_content) VALUES (?, 'resume', 'python')", (app_id,))
        conn.execute("INSERT INTO form_answers(application_id, value) VALUES (?, 'answer')", (app_id,))
        conn.execute("INSERT INTO application_pages(application_id, url) VALUES (?, 'u')", (app_id,))

    conn.execute("DELETE FROM applications WHERE id = ?", (gone,))
    for table in ("documents", "form_answers", "application_pages"):
        assert [tuple(r) for r in conn.execute(f"SELECT DISTINCT application_id FROM {table}")] == [(keep,)]
    assert _fts(conn, "python") == [keep]
    assert conn.execute("SELECT count(*) FROM applications_fts").fetchone()[0] == 1


def test_document_kind_is_checked(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    db.migrate(conn)
    app_id = _app(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO documents(application_id, kind) VALUES (?, 'banana')", (app_id,))


def test_settings_roundtrip(tmp_path):
    conn = db.connect(tmp_path / "a.db")
    db.migrate(conn)
    assert db.get_setting(conn, "base_path") is None
    db.set_setting(conn, "base_path", "/a")
    db.set_setting(conn, "base_path", "/b")
    assert db.get_setting(conn, "base_path") == "/b"
