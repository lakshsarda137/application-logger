"""FastAPI app. Run with: uvicorn --factory server.main:create_app"""

from __future__ import annotations

import hashlib
import hmac
import html as html_lib
import json
import logging
import mimetypes
import re
import secrets
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib.parse import quote, urlsplit

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import db, storage
from .classify import classify
from .config import Config, load_config
from .extract import extract_text
from .jobposting import parse_jobposting
from .search import search
from .urls import detect_ats, normalize_url

log = logging.getLogger("application_logger")

STATIC_DIR = Path(__file__).resolve().parent / "static"
LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"]
WRITTEN_KINDS = {"resume", "cover_letter"}  # "other" files live in SQLite only
COOKIE_NAME = "al_session"
DASHBOARD_PAGES = {"/": "index.html", "/app.html": "app.html", "/settings.html": "settings.html"}

# Served inline; anything else downloads as application/octet-stream so an
# uploaded .html or .svg can never run script on the dashboard's origin.
INLINE_MIMES = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"}

DASHBOARD_CSP = (
    "default-src 'self'; img-src 'self' data:; frame-src 'self'; object-src 'none';"
    " base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
)
# Archived postings: no scripts, no forms, no same-origin access (sandbox),
# but let them load their own images/CSS so they look like the original.
SNAPSHOT_CSP = (
    "sandbox; default-src 'none'; img-src * data: blob:; style-src * 'unsafe-inline';"
    " font-src * data:; frame-ancestors 'self'"
)
DOCUMENT_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'"


# ---------------------------------------------------------------- models


class PostingIn(BaseModel):
    url: str = ""
    title: str = ""
    text: str = ""
    html: str = ""
    jsonld: Any = None


class PageIn(BaseModel):
    url: str = ""
    title: str = ""
    text: str = ""
    captured_at: str | None = None


class DocumentIn(BaseModel):
    kind: Literal["resume", "cover_letter", "other"]
    filename: str
    mime: str | None = None


class AnswerIn(BaseModel):
    page_url: str = ""
    field_label: str = ""
    field_name: str = ""
    value: str = ""


class ApplicationIn(BaseModel):
    company: str = Field("", max_length=300)
    position: str = Field("", max_length=300)
    folder_name: str = Field("", max_length=300)
    # Absolute folder to save into. Empty means this month's folder.
    save_dir: str = ""
    posting: PostingIn = PostingIn()
    pages: list[PageIn] = []
    # documents[i] describes the i-th uploaded file part.
    documents: list[DocumentIn] = []
    form_answers: list[AnswerIn] = []


class SettingsIn(BaseModel):
    base_path: str


# ---------------------------------------------------------------- helpers


def _host(url: str | None) -> str:
    try:
        host = (urlsplit(url or "").hostname or "").lower()
    except ValueError:
        return ""
    return host[4:] if host.startswith("www.") else host


def _with_base_tag(html: str, url: str | None) -> str:
    """Make relative links/images in an archived page resolve against its original URL."""
    if not url:
        return html
    tag = f'<base href="{html_lib.escape(url, quote=True)}">'
    new, n = re.subn(r"(<head\b[^>]*>)", lambda m: m.group(1) + tag, html, count=1, flags=re.IGNORECASE)
    return new if n else tag + html


# ---------------------------------------------------------------- app


def create_app(config: Config | None = None) -> FastAPI:
    config = config or load_config()
    db.init_db(config.db_path)

    app = FastAPI(title="Application Logger", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.config = config

    # Blocks DNS-rebinding: a malicious site that points its hostname at
    # 127.0.0.1 still sends its own Host header.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=LOOPBACK_HOSTS)
    ext_id = config.extension_id or "[a-p]{32}"
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=rf"^chrome-extension://{ext_id}$",
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["X-API-Token", "Content-Type"],
    )

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        return response

    # The dashboard can't hold the API token, so pages it serves set an
    # HttpOnly, SameSite=Strict cookie derived from it. Cross-site pages never
    # send that cookie, and mutating requests also need a custom header, which
    # forces a CORS preflight that only the extension's origin passes.
    session_cookie = hmac.new(config.api_token.encode(), b"dashboard-session", hashlib.sha256).hexdigest()

    def get_conn() -> Iterator[sqlite3.Connection]:
        conn = db.connect(config.db_path)
        try:
            yield conn
        finally:
            conn.close()

    def require_token(request: Request, x_api_token: str = Header(default="")) -> None:
        if x_api_token:
            if secrets.compare_digest(x_api_token.encode(), config.api_token.encode()):
                return
            raise HTTPException(401, "Missing or invalid X-API-Token")
        cookie = request.cookies.get(COOKIE_NAME, "")
        if cookie and secrets.compare_digest(cookie.encode(), session_cookie.encode()):
            if request.method in ("GET", "HEAD") or request.headers.get("x-requested-with") == "dashboard":
                return
            raise HTTPException(403, "Missing X-Requested-With header")
        raise HTTPException(401, "Missing or invalid X-API-Token")

    def base_path(conn: sqlite3.Connection) -> Path:
        stored = db.get_setting(conn, "base_path")
        return storage.expand_path(stored) if stored else config.base_path

    def month_info(conn: sqlite3.Connection) -> dict:
        now = datetime.now()
        folder = storage.month_folder(base_path(conn), now)
        return {"month": storage.month_name(now), "path": str(folder), "exists": folder.is_dir()}

    auth = [Depends(require_token)]

    # ------------------------------------------------------------ dashboard pages

    def dashboard_page(filename: str):
        def handler() -> FileResponse:
            response = FileResponse(STATIC_DIR / filename, media_type="text/html")
            response.headers["Content-Security-Policy"] = DASHBOARD_CSP
            response.headers["Cache-Control"] = "no-store"
            response.set_cookie(COOKIE_NAME, session_cookie, httponly=True, samesite="strict", path="/")
            return response

        return handler

    for route, filename in DASHBOARD_PAGES.items():
        app.add_api_route(route, dashboard_page(filename), methods=["GET"], include_in_schema=False)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    # ------------------------------------------------------------ health

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    # ------------------------------------------------------------ settings

    @app.get("/settings", dependencies=auth)
    def get_settings(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        return {"base_path": str(base_path(conn)), "month_folder": month_info(conn)}

    @app.put("/settings", dependencies=auth)
    def put_settings(body: SettingsIn, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        path = storage.expand_path(body.base_path.strip())
        if not path.is_absolute():
            raise HTTPException(400, "Base path must be absolute (or start with ~)")
        if not path.is_dir():
            raise HTTPException(400, f"Folder does not exist: {path}")
        with conn:
            db.set_setting(conn, "base_path", str(path))
        return get_settings(conn)

    @app.get("/settings/month-folder", dependencies=auth)
    def get_month_folder(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        return month_info(conn)

    @app.post("/settings/month-folder", dependencies=auth)
    def create_month_folder(conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        info = month_info(conn)
        path = Path(info["path"])
        created = not path.is_dir()
        path.mkdir(parents=True, exist_ok=True)
        return {**info, "exists": True, "created": created}

    # ------------------------------------------------------------ create

    @app.post("/applications", dependencies=auth, status_code=201)
    async def create_application(
        payload: UploadFile = File(..., description="JSON matching ApplicationIn"),
        files: list[UploadFile] = File(default=[]),
        conn: sqlite3.Connection = Depends(get_conn),
    ) -> dict:
        # The payload is sent as a file part because posting HTML can exceed
        # the 1 MB limit Starlette puts on plain form fields.
        try:
            body = ApplicationIn.model_validate_json(await payload.read())
        except ValidationError as e:
            raise HTTPException(422, json.loads(e.json(include_url=False)))
        if len(body.documents) != len(files):
            raise HTTPException(
                400, f"{len(body.documents)} document descriptions but {len(files)} files"
            )

        if body.save_dir.strip():
            parent = storage.expand_path(body.save_dir.strip())
            if not parent.is_absolute() or not parent.is_dir():
                raise HTTPException(400, f"Save folder does not exist: {parent}")
        else:
            info = month_info(conn)
            if not info["exists"]:
                raise HTTPException(
                    409, {"code": "month_folder_missing", "month": info["month"], "path": info["path"]}
                )
            parent = Path(info["path"])

        uploads = [(doc, await f.read()) for doc, f in zip(body.documents, files)]
        # Disk writes and PDF parsing are blocking; keep them off the event loop.
        return await run_in_threadpool(save_application, conn, body, uploads, parent)

    def save_application(
        conn: sqlite3.Connection,
        body: ApplicationIn,
        uploads: list[tuple[DocumentIn, bytes]],
        parent: Path,
    ) -> dict:
        now = datetime.now().astimezone()
        fields = parse_jobposting(body.posting.jsonld)
        company = body.company.strip() or fields.get("company") or ""
        position = body.position.strip() or fields.get("posting_title") or ""
        folder_name = storage.sanitize_folder_name(
            body.folder_name or "_".join(p for p in (company, position) if p)
        )

        folder = storage.create_unique_folder(parent, folder_name, now)
        try:
            with conn:
                app_id = insert_application(conn, body, uploads, folder, company, position, fields, now)
        except BaseException:
            # Roll back the disk side too so a failed save leaves nothing behind.
            storage.remove_folder_safely(folder, parent)
            raise

        return {
            "id": app_id,
            "folder_path": str(folder),
            "folder_name": folder.name,
            "applied_at": now.isoformat(timespec="seconds"),
            "documents": [
                dict(r)
                for r in conn.execute(
                    "SELECT id, kind, filename, file_path FROM documents WHERE application_id = ?",
                    (app_id,),
                )
            ],
        }

    def insert_application(conn, body, uploads, folder, company, position, fields, now) -> int:
        posting = body.posting
        jsonld = posting.jsonld
        if jsonld is not None and not isinstance(jsonld, str):
            jsonld = json.dumps(jsonld, ensure_ascii=False)

        cur = conn.execute(
            """INSERT INTO applications (
                 company, position, folder_name, folder_path, applied_at,
                 posting_url, posting_url_normalized, posting_title, posting_text, posting_html,
                 location, employment_type, salary, date_posted, job_id, ats_platform, jsonld)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                company, position, folder.name, str(folder), now.isoformat(timespec="seconds"),
                posting.url, normalize_url(posting.url),
                posting.title or fields.get("posting_title"), posting.text,
                posting.html.encode("utf-8") if posting.html else None,
                fields.get("location"), fields.get("employment_type"), fields.get("salary"),
                fields.get("date_posted"), fields.get("job_id"), detect_ats(posting.url), jsonld,
            ),
        )
        app_id = cur.lastrowid

        pages = body.pages or (
            [PageIn(url=posting.url, title=posting.title, text=posting.text)] if posting.url else []
        )
        conn.executemany(
            "INSERT INTO application_pages (application_id, url, url_normalized, title, text, captured_at)"
            " VALUES (?,?,?,?,?,?)",
            [
                (app_id, p.url, normalize_url(p.url), p.title, p.text,
                 p.captured_at or now.isoformat(timespec="seconds"))
                for p in pages
            ],
        )

        for doc, content in uploads:
            filename = storage.sanitize_filename(doc.filename)
            file_path = None
            if doc.kind in WRITTEN_KINDS:
                # The copy on disk stays "Resume(75).pdf"; the saved one is "Resume.pdf".
                filename = storage.strip_copy_suffix(filename)
                file_path = str(storage.write_file(folder, filename, content))
            conn.execute(
                "INSERT INTO documents (application_id, kind, filename, file_path, mime, sha256,"
                " content, text_content) VALUES (?,?,?,?,?,?,?,?)",
                (
                    app_id, doc.kind, filename, file_path, doc.mime,
                    hashlib.sha256(content).hexdigest(), content,
                    extract_text(content, doc.filename, doc.mime),
                ),
            )

        conn.executemany(
            "INSERT INTO form_answers (application_id, page_url, field_label, field_name, value)"
            " VALUES (?,?,?,?,?)",
            [(app_id, a.page_url, a.field_label, a.field_name, a.value) for a in body.form_answers],
        )
        return app_id

    # ------------------------------------------------------------ search / read

    @app.get("/applications", dependencies=auth)
    def list_applications(
        q: str = "",
        limit: int = Query(50, ge=1, le=500),
        conn: sqlite3.Connection = Depends(get_conn),
    ) -> list[dict]:
        return search(conn, q, limit=limit)

    # Declared before /applications/{app_id} so "check" isn't parsed as an id.
    @app.get("/applications/check", dependencies=auth)
    def check_applied(
        url: str = "",
        job_id: str = "",
        company: str = "",
        conn: sqlite3.Connection = Depends(get_conn),
    ) -> dict:
        cols = "a.id, a.company, a.position, a.applied_at, a.posting_url"
        matches: list[tuple[str, sqlite3.Row]] = []

        norm = normalize_url(url)
        if norm:
            for r in conn.execute(
                f"SELECT {cols} FROM applications a WHERE a.posting_url_normalized = ?"
                f" UNION SELECT {cols} FROM applications a"
                f" JOIN application_pages p ON p.application_id = a.id WHERE p.url_normalized = ?",
                (norm, norm),
            ):
                matches.append(("url", r))

        # Job IDs like "R12345" repeat across companies, so require the same
        # host or the same company name too.
        job_id = job_id.strip()
        if job_id:
            for r in conn.execute(f"SELECT {cols} FROM applications a WHERE a.job_id = ?", (job_id,)):
                same_host = _host(r["posting_url"]) and _host(r["posting_url"]) == _host(url)
                same_company = company.strip() and (r["company"] or "").casefold() == company.strip().casefold()
                if same_host or same_company:
                    matches.append(("job_id", r))

        if not matches:
            return {"applied": False, "application": None, "match": None}
        how, best = max(matches, key=lambda m: (m[1]["applied_at"] or "", m[1]["id"]))
        application = {k: best[k] for k in ("id", "company", "position", "applied_at")}
        return {"applied": True, "application": application, "match": how}

    @app.get("/applications/{app_id}", dependencies=auth)
    def get_application(app_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        row = conn.execute(
            "SELECT id, company, position, folder_name, folder_path, applied_at, posting_url,"
            " posting_title, posting_text, location,"
            " employment_type, salary, date_posted, job_id, ats_platform, jsonld,"
            " posting_html IS NOT NULL AS has_snapshot FROM applications WHERE id = ?",
            (app_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Application not found")

        def rows(sql: str) -> list[dict]:
            return [dict(r) for r in conn.execute(sql, (app_id,))]

        result = dict(row)
        result["has_snapshot"] = bool(result["has_snapshot"])
        return {
            **result,
            "pages": rows(
                "SELECT id, url, title, captured_at FROM application_pages"
                " WHERE application_id = ? ORDER BY id"
            ),
            "documents": rows(
                "SELECT id, kind, filename, file_path, mime, sha256, length(content) AS size,"
                " substr(text_content, 1, 20000) AS text_preview"
                " FROM documents WHERE application_id = ? ORDER BY id"
            ),
            "form_answers": rows(
                "SELECT page_url, field_label, field_name, value FROM form_answers"
                " WHERE application_id = ? ORDER BY id"
            ),
        }

    @app.delete("/applications/{app_id}", dependencies=auth)
    def delete_application(app_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> dict:
        row = conn.execute("SELECT folder_path FROM applications WHERE id = ?", (app_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Application not found")
        with conn:
            # Cascades to pages, documents and answers; triggers clear the FTS row.
            conn.execute("DELETE FROM applications WHERE id = ?", (app_id,))

        folder = Path(row["folder_path"]) if row["folder_path"] else None
        base = base_path(conn)
        if folder is None or not folder.exists():
            folder_status = "missing"
        elif not storage.is_within(folder, base):
            folder_status = "outside_base"  # never delete outside the configured base path
        elif storage.remove_folder_safely(folder, base):
            folder_status = "deleted"
        else:
            folder_status = "not_deleted"
        return {"deleted": True, "folder_path": row["folder_path"], "folder_status": folder_status}

    @app.get("/applications/{app_id}/snapshot", dependencies=auth)
    def get_snapshot(app_id: int, conn: sqlite3.Connection = Depends(get_conn)) -> Response:
        row = conn.execute(
            "SELECT posting_html, posting_url FROM applications WHERE id = ?", (app_id,)
        ).fetchone()
        if not row or not row["posting_html"]:
            raise HTTPException(404, "No snapshot for this application")
        page = _with_base_tag(bytes(row["posting_html"]).decode("utf-8", "replace"), row["posting_url"])
        return Response(
            page,
            media_type="text/html; charset=utf-8",
            headers={"Content-Security-Policy": SNAPSHOT_CSP, "X-Frame-Options": "SAMEORIGIN"},
        )

    # ------------------------------------------------------------ documents

    @app.get("/documents/{doc_id}", dependencies=auth)
    def get_document(
        doc_id: int, download: bool = False, conn: sqlite3.Connection = Depends(get_conn)
    ) -> Response:
        row = conn.execute(
            "SELECT filename, mime, content FROM documents WHERE id = ?", (doc_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Document not found")
        filename = row["filename"] or "file"
        mime = (row["mime"] or mimetypes.guess_type(filename)[0] or "").lower().split(";")[0].strip()
        safe = mime in INLINE_MIMES
        inline = safe and not download
        media_type = (mime + ("; charset=utf-8" if mime == "text/plain" else "")) if safe else "application/octet-stream"
        headers = {
            "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{quote(filename)}",
            "X-Frame-Options": "SAMEORIGIN",
            # Chrome's PDF viewer doesn't render under a CSP sandbox; PDFs can't
            # script this origin anyway. Everything else gets the sandbox.
            "Content-Security-Policy": "frame-ancestors 'self'" if mime == "application/pdf" else DOCUMENT_CSP,
        }
        return Response(bytes(row["content"] or b""), media_type=media_type, headers=headers)

    @app.post("/files/classify", dependencies=auth)
    async def classify_files(files: list[UploadFile] = File(...)) -> list[dict]:
        contents = [(f.filename or "", f.content_type, await f.read()) for f in files]

        def run() -> list[dict]:
            texts = [(name, extract_text(data, name, mime)) for name, mime, data in contents]
            return [{"filename": name, **label} for (name, _), label in zip(texts, classify(texts))]

        return await run_in_threadpool(run)

    return app

