"""Phases 2–4 on the server: classify, search, check, delete, documents,
snapshots and dashboard auth."""

from __future__ import annotations

import io
import json
from pathlib import Path

import docx
import pytest
from fastapi.testclient import TestClient

from server.classify import classify
from server.main import COOKIE_NAME, create_app

from .conftest import TOKEN, multipart


def make_docx(text: str) -> bytes:
    document = docx.Document()
    document.add_paragraph(text)
    buf = io.BytesIO()
    document.save(buf)
    return buf.getvalue()


RESUME_TEXT = "Education Stanford. Experience Google intern kubernetes. Projects compiler. " + "word " * 300
COVER_TEXT = "Dear hiring manager, I am excited to apply."


def log_app(client, company="Google", position="Software Engineer", url="https://boards.greenhouse.io/google/jobs/1",
            pages=(), job_id=None, answers=(), files=None, folder_name=None, html="<html><head></head><body>posting</body></html>",
            text="Minimum qualifications: Python. Responsibilities: build things."):
    jsonld = {"title": position, "hiringOrganization": {"name": company}}
    if job_id:
        jsonld["identifier"] = {"value": job_id}
    files = files if files is not None else [("Resume.docx", make_docx(RESUME_TEXT), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")]
    payload = {
        "company": company, "position": position,
        "folder_name": folder_name or f"{company}_{position}",
        "posting": {"url": url, "title": f"{position} at {company}", "text": text, "html": html, "jsonld": jsonld},
        "pages": [{"url": u, "title": "p", "text": "t"} for u in pages] or [{"url": url, "title": "p", "text": text}],
        "documents": [{"kind": "resume" if i == 0 else "cover_letter", "filename": f[0], "mime": f[2]} for i, f in enumerate(files)],
        "form_answers": [{"page_url": url, "field_label": l, "field_name": "", "value": v} for l, v in answers],
    }
    r = client.post("/applications", files=multipart(payload, files))
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------- classify


def test_classify_rules():
    assert [r["kind"] for r in classify([("Ada_CV.pdf", ""), ("CoverLetter.pdf", "")])] == ["resume", "cover_letter"]
    # Rule 3: sections + more words than the other file.
    assert [r["kind"] for r in classify([("a.pdf", COVER_TEXT), ("b.pdf", RESUME_TEXT)])] == ["cover_letter", "resume"]
    # Sections but fewer words than the other file -> not a resume.
    short = "Education Experience Projects"
    assert [r["kind"] for r in classify([("a.pdf", short), ("b.pdf", COVER_TEXT * 5)])] == ["cover_letter", "other"]
    # One file: word-count comparison is skipped.
    assert classify([("a.pdf", short)])[0] == {"kind": "resume", "reason": "sections"}
    assert classify([("a.pdf", COVER_TEXT)])[0] == {"kind": "cover_letter", "reason": "fallback"}
    # Third unknown file doesn't become a second cover letter.
    kinds = [r["kind"] for r in classify([("resume.pdf", ""), ("cover.pdf", ""), ("transcript.pdf", "grades")])]
    assert kinds == ["resume", "cover_letter", "other"]


def test_classify_endpoint(client):
    r = client.post("/files/classify", files=[
        ("files", ("ada.docx", make_docx(COVER_TEXT), "application/octet-stream")),
        ("files", ("ada2.docx", make_docx(RESUME_TEXT), "application/octet-stream")),
    ])
    assert r.status_code == 200
    assert [(x["filename"], x["kind"]) for x in r.json()] == [("ada.docx", "cover_letter"), ("ada2.docx", "resume")]


# ---------------------------------------------------------------- search


@pytest.fixture
def seeded(client, month_dir):
    ids = {
        "google_swe": log_app(client, "Google", "Software Engineer", answers=[("Why?", "I love search")])["id"],
        "google_pm": log_app(client, "Google", "Product Manager", url="https://boards.greenhouse.io/google/jobs/2",
                             files=[("Resume.pdf", b"%PDF-bytes", "application/pdf")])["id"],
        "stripe": log_app(client, "Stripe", "Backend Engineer", url="https://jobs.lever.co/stripe/1",
                          text="Payments infrastructure. Requirements: Go.")["id"],
    }
    return ids


def ids_of(results):
    return [r["id"] for r in results]


def test_empty_query_lists_recent_with_resume(client, seeded):
    results = client.get("/applications").json()
    assert ids_of(results) == [seeded["stripe"], seeded["google_pm"], seeded["google_swe"]]
    assert results[0]["resume"]["filename"] == "Resume.docx"
    assert results[0]["cover_letter"] is None


def test_search_by_company_prefix_and_typo(client, seeded):
    assert set(ids_of(client.get("/applications", params={"q": "google"}).json())) >= {seeded["google_swe"], seeded["google_pm"]}
    assert set(ids_of(client.get("/applications", params={"q": "goo"}).json())) >= {seeded["google_swe"], seeded["google_pm"]}
    typo = client.get("/applications", params={"q": "gogle"}).json()
    assert set(ids_of(typo)[:2]) == {seeded["google_swe"], seeded["google_pm"]}
    assert seeded["stripe"] not in ids_of(typo)


def test_search_two_roles_same_company_are_separate_cards(client, seeded):
    results = client.get("/applications", params={"q": "google"}).json()
    google = [r for r in results if r["company"] == "Google"]
    assert sorted(r["position"] for r in google) == ["Product Manager", "Software Engineer"]


def test_search_posting_resume_and_answer_text(client, seeded):
    assert ids_of(client.get("/applications", params={"q": "payments"}).json()) == [seeded["stripe"]]
    # Resume text (extracted from the DOCX).
    assert seeded["google_swe"] in ids_of(client.get("/applications", params={"q": "kubernetes"}).json())
    # Portal answers.
    assert ids_of(client.get("/applications", params={"q": "love search"}).json())[0] == seeded["google_swe"]


def test_search_company_outranks_body_mentions(client, seeded, month_dir):
    other = log_app(client, "Acme", "Engineer", url="https://acme.com/1", text="We compete with Stripe daily.")["id"]
    results = ids_of(client.get("/applications", params={"q": "stripe"}).json())
    assert results[0] == seeded["stripe"] and other in results


def test_search_snippet_marks_match(client, seeded):
    result = client.get("/applications", params={"q": "payments"}).json()[0]
    assert "\x02" in result["snippet"] and "\x03" in result["snippet"]


def test_search_is_safe_with_fts_syntax(client, seeded):
    for q in ['"', "AND OR NOT", "col:*", "(((", "NEAR(a b)", "'; DROP TABLE applications; --"]:
        assert client.get("/applications", params={"q": q}).status_code == 200
    assert len(client.get("/applications").json()) == 3


def test_search_no_results(client, seeded):
    assert client.get("/applications", params={"q": "zzzqqq"}).json() == []


# ---------------------------------------------------------------- check


def test_check_by_posting_and_captured_page_url(client, month_dir):
    app = log_app(client, url="https://acme.wd5.myworkdayjobs.com/en-US/External/job/NYC/SWE_R1",
                  pages=["https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1/apply/applyManually"])
    for url in [
        "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1?source=LinkedIn",
        "https://acme.wd5.myworkdayjobs.com/en-US/External/job/NYC/SWE_R1/",
        "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1/apply/applyManually",
    ]:
        body = client.get("/applications/check", params={"url": url}).json()
        assert body["applied"] is True, url
        assert body["application"]["id"] == app["id"]
        assert body["match"] == "url"

    other = client.get("/applications/check", params={"url": "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R2"})
    assert other.json() == {"applied": False, "application": None, "match": None}


def test_check_by_job_id_requires_same_host_or_company(client, month_dir):
    log_app(client, company="Acme", url="https://jobs.lever.co/acme/1", job_id="R123")
    hit = client.get("/applications/check", params={"url": "https://acme.com/careers/x", "job_id": "R123", "company": "ACME"})
    assert hit.json()["applied"] is True and hit.json()["match"] == "job_id"
    hit2 = client.get("/applications/check", params={"url": "https://jobs.lever.co/acme/other", "job_id": "R123"})
    assert hit2.json()["applied"] is True
    miss = client.get("/applications/check", params={"url": "https://globex.com/jobs/1", "job_id": "R123", "company": "Globex"})
    assert miss.json()["applied"] is False


def test_check_returns_most_recent(client, month_dir):
    first = log_app(client, folder_name="a")
    second = log_app(client, folder_name="b")
    body = client.get("/applications/check", params={"url": "https://boards.greenhouse.io/google/jobs/1"}).json()
    assert body["application"]["id"] == second["id"] != first["id"]


def test_check_ignores_empty_input(client, month_dir):
    log_app(client)
    assert client.get("/applications/check").json()["applied"] is False
    assert client.get("/applications/check", params={"url": "chrome://newtab"}).json()["applied"] is False


# ---------------------------------------------------------------- delete


def test_delete_removes_rows_fts_and_folder(client, config, month_dir):
    app = log_app(client, answers=[("Why?", "uniqueanswerword")])
    folder = Path(app["folder_path"])
    assert folder.is_dir()
    r = client.delete(f"/applications/{app['id']}")
    assert r.json() == {"deleted": True, "folder_path": str(folder), "folder_status": "deleted"}
    assert not folder.exists() and month_dir.exists()
    assert client.get(f"/applications/{app['id']}").status_code == 404
    assert client.get("/applications", params={"q": "uniqueanswerword"}).json() == []
    assert client.delete(f"/applications/{app['id']}").status_code == 404


def test_delete_never_touches_folders_outside_base(client, tmp_path):
    outside = tmp_path / "Elsewhere"
    outside.mkdir()
    payload = {"company": "X", "folder_name": "x", "save_dir": str(outside), "documents": []}
    app = client.post("/applications", files=multipart(payload, [])).json()
    r = client.delete(f"/applications/{app['id']}").json()
    assert r["folder_status"] == "outside_base"
    assert Path(app["folder_path"]).is_dir()


def test_delete_when_folder_already_gone(client, month_dir):
    app = log_app(client)
    for p in Path(app["folder_path"]).iterdir():
        p.unlink()
    Path(app["folder_path"]).rmdir()
    assert client.delete(f"/applications/{app['id']}").json()["folder_status"] == "missing"


# ---------------------------------------------------------------- documents / snapshot


def test_document_download_and_inline_rules(client, month_dir):
    files = [("Resume.pdf", b"%PDF-1.4 x", "application/pdf"), ("evil.html", b"<script>alert(1)</script>", "text/html")]
    app = log_app(client, files=files)
    docs = client.get(f"/applications/{app['id']}").json()["documents"]

    pdf = client.get(f"/documents/{docs[0]['id']}")
    assert pdf.content == b"%PDF-1.4 x"
    assert pdf.headers["content-type"] == "application/pdf"
    assert pdf.headers["content-disposition"].startswith("inline;")
    assert pdf.headers["x-frame-options"] == "SAMEORIGIN"

    dl = client.get(f"/documents/{docs[0]['id']}", params={"download": 1})
    assert dl.headers["content-disposition"] == "attachment; filename*=UTF-8''Resume.pdf"

    html = client.get(f"/documents/{docs[1]['id']}")
    assert html.headers["content-type"] == "application/octet-stream"
    assert html.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in html.headers["content-security-policy"]

    assert client.get("/documents/9999").status_code == 404


def test_detail_includes_text_preview(client, month_dir):
    app = log_app(client)
    doc = client.get(f"/applications/{app['id']}").json()["documents"][0]
    assert "kubernetes" in doc["text_preview"]


def test_snapshot_is_sandboxed_with_base_tag(client, month_dir):
    app = log_app(client, html='<html><head><title>x</title></head><body><img src="/logo.png"><script>alert(1)</script></body></html>')
    r = client.get(f"/applications/{app['id']}/snapshot")
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert csp.startswith("sandbox;") and "script-src" not in csp and "default-src 'none'" in csp
    assert r.headers["x-frame-options"] == "SAMEORIGIN"
    assert '<head><base href="https://boards.greenhouse.io/google/jobs/1">' in r.text
    assert client.get(f"/applications/{app['id']}").json()["has_snapshot"] is True


def test_snapshot_missing(client, month_dir):
    app = log_app(client, html="")
    assert client.get(f"/applications/{app['id']}/snapshot").status_code == 404


# ---------------------------------------------------------------- dashboard + cookie auth


def test_dashboard_pages_set_cookie_and_csp(config):
    anon = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    for path in ("/", "/app.html", "/settings.html"):
        r = anon.get(path)
        assert r.status_code == 200, path
        assert "text/html" in r.headers["content-type"]
        assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
        cookie = r.headers["set-cookie"]
        assert f"{COOKIE_NAME}=" in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert anon.get("/static/dashboard.css").status_code == 200


def test_cookie_auth_allows_reads_and_header_guarded_writes(config, month_dir):
    browser = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    assert browser.get("/applications").status_code == 401
    browser.get("/")  # picks up the session cookie
    assert browser.get("/applications").status_code == 200
    assert browser.put("/settings", json={"base_path": str(config.base_path)}).status_code == 403
    r = browser.put("/settings", json={"base_path": str(config.base_path)}, headers={"X-Requested-With": "dashboard"})
    assert r.status_code == 200


def test_cookie_is_not_the_api_token(config):
    browser = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    cookie = browser.get("/").cookies[COOKIE_NAME]
    assert cookie != TOKEN
    fresh = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    assert fresh.get("/settings", headers={"X-API-Token": cookie}).status_code == 401


def test_wrong_header_token_is_rejected_even_with_cookie(config):
    browser = TestClient(create_app(config), base_url="http://127.0.0.1:8765")
    browser.get("/")
    assert browser.get("/settings", headers={"X-API-Token": "wrong"}).status_code == 401


def test_every_response_has_security_headers(client):
    r = client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["x-frame-options"] == "DENY"
