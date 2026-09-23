"""Search: SQLite FTS5 (BM25) blended with rapidfuzz on company/position.

FTS finds matches anywhere (posting text, resume text, answers) and handles
prefixes (`goo` -> Google). rapidfuzz adds typo tolerance on the names that
matter most (`gogle` -> Google), which FTS can't do.
"""

from __future__ import annotations

import re
import sqlite3

from rapidfuzz import fuzz, utils

# bm25 column weights, in applications_fts column order:
# company, position, posting_title, posting_text, posting_url, document_text, form_text
BM25_WEIGHTS = (10.0, 10.0, 5.0, 1.0, 2.0, 1.0, 1.0)
FUZZY_MIN = 75  # 0-100; below this a name match is noise
FTS_WEIGHT = 0.45
FUZZY_WEIGHT = 0.55
MARK_START, MARK_END = "\x02", "\x03"  # snippet() markers; the UI turns them into <mark>

_TOKEN = re.compile(r"\w+", re.UNICODE)

RESULT_COLUMNS = (
    "a.id, a.company, a.position, a.applied_at, a.location, a.posting_url,"
    " a.posting_title, a.folder_path"
)


def _fts_query(tokens: list[str], op: str) -> str:
    # Quote each token so FTS syntax characters in user input are inert.
    return f" {op} ".join(f'"{t}"*' for t in tokens)


def _fts_scores(conn: sqlite3.Connection, tokens: list[str]) -> dict[int, tuple[float, str]]:
    """{app_id: (normalized score 0-1, snippet)}. Tries AND first, then OR."""
    weights = ", ".join(str(w) for w in BM25_WEIGHTS)
    for op in ("AND", "OR"):
        try:
            rows = conn.execute(
                f"""SELECT rowid, bm25(applications_fts, {weights}) AS rank,
                           snippet(applications_fts, -1, ?, ?, '…', 16) AS snip
                    FROM applications_fts WHERE applications_fts MATCH ?
                    ORDER BY rank LIMIT 500""",
                (MARK_START, MARK_END, _fts_query(tokens, op)),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if rows:
            best = max(-r["rank"] for r in rows) or 1.0
            # OR matches are weaker evidence than AND matches.
            factor = 1.0 if op == "AND" else 0.6
            return {r["rowid"]: (factor * max(-r["rank"], 0) / best, r["snip"]) for r in rows}
    return {}


def _fuzzy_scores(conn: sqlite3.Connection, q: str) -> dict[int, float]:
    scores = {}
    for r in conn.execute("SELECT id, company, position FROM applications"):
        company = fuzz.WRatio(q, r["company"] or "", processor=utils.default_process)
        position = fuzz.WRatio(q, r["position"] or "", processor=utils.default_process)
        both = fuzz.token_set_ratio(
            q, f"{r['company'] or ''} {r['position'] or ''}", processor=utils.default_process
        )
        best = max(company, 0.9 * position, 0.95 * both)
        if best >= FUZZY_MIN:
            scores[r["id"]] = best / 100
    return scores


def _attach_documents(conn: sqlite3.Connection, results: list[dict]) -> list[dict]:
    if not results:
        return results
    ids = [r["id"] for r in results]
    marks = ",".join("?" * len(ids))
    docs: dict[int, dict] = {}
    for d in conn.execute(
        f"SELECT id, application_id, kind, filename FROM documents"
        f" WHERE application_id IN ({marks}) AND kind IN ('resume', 'cover_letter') ORDER BY id",
        ids,
    ):
        slot = docs.setdefault(d["application_id"], {})
        slot.setdefault(d["kind"], {"id": d["id"], "filename": d["filename"]})
    for r in results:
        r["resume"] = docs.get(r["id"], {}).get("resume")
        r["cover_letter"] = docs.get(r["id"], {}).get("cover_letter")
    return results


def _excerpt(text: str | None, n: int = 240) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text[:n] + ("…" if len(text) > n else "")


def recent(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    rows = conn.execute(
        f"SELECT {RESULT_COLUMNS}, a.posting_text FROM applications a"
        " ORDER BY a.applied_at DESC, a.id DESC LIMIT ?",
        (limit,),
    )
    results = []
    for r in rows:
        d = dict(r)
        d["snippet"] = _excerpt(d.pop("posting_text"))
        d["score"] = None
        results.append(d)
    return _attach_documents(conn, results)


def search(conn: sqlite3.Connection, q: str, limit: int = 50) -> list[dict]:
    q = (q or "").strip()
    tokens = _TOKEN.findall(q.lower())
    if not tokens:
        return recent(conn, limit)

    fts = _fts_scores(conn, tokens)
    fuzzy = _fuzzy_scores(conn, q)
    ids = set(fts) | set(fuzzy)
    if not ids:
        return []

    scored = {
        i: FTS_WEIGHT * fts.get(i, (0.0, ""))[0] + FUZZY_WEIGHT * fuzzy.get(i, 0.0) for i in ids
    }
    marks = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT {RESULT_COLUMNS}, a.posting_text FROM applications a WHERE a.id IN ({marks})",
        tuple(ids),
    ).fetchall()

    results = []
    for r in rows:
        d = dict(r)
        text = d.pop("posting_text")
        snip = fts.get(d["id"], (0, ""))[1]
        d["snippet"] = snip if snip and MARK_START in snip else _excerpt(text)
        d["score"] = round(scored[d["id"]], 4)
        results.append(d)
    # Best score first; ties go to the most recent application.
    results.sort(key=lambda d: d["applied_at"] or "", reverse=True)
    results.sort(key=lambda d: d["score"], reverse=True)
    return _attach_documents(conn, results[:limit])
