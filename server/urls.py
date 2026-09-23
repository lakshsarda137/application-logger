"""URL normalization and ATS platform detection.

Normalized URLs drop the scheme, `www.`, default ports, fragments, trailing
slashes and tracking parameters, so the same posting reached via different
links compares equal. Identity parameters (e.g. `gh_jid`, `currentJobId`) are
kept, since some sites use the query string to pick the job.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit

TRACKING_PARAMS = {
    "gh_src", "source", "src", "ref", "referrer", "referer", "ref_src",
    "gclid", "fbclid", "msclkid", "dclid", "yclid", "twclid", "li_fat_id",
    "mc_cid", "mc_eid", "_hsenc", "_hsmi", "mkt_tok", "hsa_cam",
    "lever-source", "lever-origin", "lever-source[]",
    "trk", "trackingid", "refid", "tracking_id",
    "iis", "iisn", "sourcetype",
}
TRACKING_PREFIXES = ("utm_", "hsa_", "pk_", "mtm_")

_WORKDAY_LOCALE = re.compile(r"^/[a-z]{2}-[A-Z]{2}(?=/)")

# (hostname suffix, platform name). Order matters: first match wins.
ATS_PLATFORMS: list[tuple[str, str]] = [
    ("myworkdayjobs.com", "workday"),
    ("myworkdaysite.com", "workday"),
    ("workday.com", "workday"),
    ("greenhouse.io", "greenhouse"),
    ("lever.co", "lever"),
    ("ashbyhq.com", "ashby"),
    ("smartrecruiters.com", "smartrecruiters"),
    ("icims.com", "icims"),
    ("jobvite.com", "jobvite"),
    ("workable.com", "workable"),
    ("bamboohr.com", "bamboohr"),
    ("taleo.net", "taleo"),
    ("successfactors.com", "successfactors"),
    ("oraclecloud.com", "oracle"),
    ("eightfold.ai", "eightfold"),
    ("rippling.com", "rippling"),
    ("breezy.hr", "breezy"),
    ("recruitee.com", "recruitee"),
    ("jazzhr.com", "jazzhr"),
    ("applytojob.com", "jazzhr"),
    ("teamtailor.com", "teamtailor"),
    ("personio.com", "personio"),
    ("personio.de", "personio"),
    ("dover.com", "dover"),
    ("wellfound.com", "wellfound"),
    ("joinhandshake.com", "handshake"),
    ("handshake.com", "handshake"),
    ("linkedin.com", "linkedin"),
    ("indeed.com", "indeed"),
]


def _is_tracking(key: str) -> bool:
    k = key.lower()
    return k in TRACKING_PARAMS or k.startswith(TRACKING_PREFIXES)


def normalize_url(url: str | None) -> str:
    """Return a comparison key like `boards.greenhouse.io/acme/jobs/123`.

    Returns "" for empty or non-http(s) input.
    """
    if not url:
        return ""
    url = url.strip()
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    if parts.scheme.lower() not in ("http", "https"):
        return ""

    host = (parts.hostname or "").lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    try:
        port = parts.port
    except ValueError:
        port = None
    if port and port not in (80, 443):
        host = f"{host}:{port}"

    path = re.sub(r"/{2,}", "/", parts.path or "")
    if host.endswith(("myworkdayjobs.com", "myworkdaysite.com")):
        path = _WORKDAY_LOCALE.sub("", path)
    path = path.rstrip("/")

    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if not _is_tracking(k)]
    query.sort()
    qs = urlencode(query)

    return f"{host}{path}" + (f"?{qs}" if qs else "")


def detect_ats(url: str | None) -> str | None:
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    for suffix, name in ATS_PLATFORMS:
        if host == suffix or host.endswith("." + suffix):
            return name
    return None


# Personal/productivity sites; mirrors AppLogger.NEVER_CAPTURE in extension/lib/ats-domains.js.
NEVER_CAPTURE = (
    "mail.google.com", "docs.google.com", "drive.google.com", "calendar.google.com",
    "meet.google.com", "chat.google.com", "contacts.google.com", "accounts.google.com",
    "keep.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
    "slack.com", "web.whatsapp.com", "instagram.com", "facebook.com", "messenger.com",
    "x.com", "twitter.com", "reddit.com", "youtube.com", "claude.ai", "chatgpt.com", "notion.so",
)

_MULTI_PART_SUFFIX = re.compile(r"\.(co|com|ac|org|net|gov|edu)\.[a-z]{2}$")


def _hostname(url: str | None) -> str:
    try:
        return (urlsplit((url or "").strip()).hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def site_of(url: str | None) -> str:
    """Registrable domain, roughly: careers.acme.com -> acme.com, x.co.uk -> x.co.uk."""
    host = _hostname(url)
    if not host or re.fullmatch(r"[\d.]+", host) or ":" in host:
        return host
    parts = host.split(".")
    return ".".join(parts[-3:] if _MULTI_PART_SUFFIX.search(host) else parts[-2:])


def is_never_capture(url: str | None) -> bool:
    host = _hostname(url)
    return any(host == d or host.endswith("." + d) for d in NEVER_CAPTURE)


# Candidate-facing job hosts (and path prefixes); mirrors AppLogger.ATS_DOMAINS in
# extension/lib/ats-domains.js. Narrower than ATS_PLATFORMS, which only labels
# the platform: e.g. app.rippling.com is Rippling's HR app, not a job page.
ATS_PAGES = (
    "myworkdayjobs.com", "myworkdaysite.com", "greenhouse.io", "lever.co", "ashbyhq.com",
    "jobs.smartrecruiters.com", "careers.smartrecruiters.com", "icims.com", "jobvite.com",
    "apply.workable.com", "bamboohr.com/careers", "bamboohr.com/jobs", "taleo.net",
    "successfactors.com/career", "successfactors.eu/career",
    "oraclecloud.com/hcmUI/CandidateExperience", "eightfold.ai", "ats.rippling.com",
    "breezy.hr", "recruitee.com", "applytojob.com", "jazzhr.com", "teamtailor.com",
    "jobs.personio.com", "jobs.personio.de", "app.dover.com", "wellfound.com/jobs",
    "joinhandshake.com/jobs", "joinhandshake.com/stu/jobs", "linkedin.com/jobs",
    "indeed.com/viewjob", "indeed.com/jobs", "indeed.com/applystart", "smartapply.indeed.com",
)


def is_ats_page(url: str | None) -> bool:
    """A page on a job-application platform (not LinkedIn profiles, Workday's HR app, …)."""
    host = _hostname(url)
    try:
        path = urlsplit(url or "").path or "/"
    except ValueError:
        return False
    for entry in ATS_PAGES:
        domain, _, prefix = entry.partition("/")
        prefix = f"/{prefix}" if prefix else ""
        if (host == domain or host.endswith("." + domain)) and (
            not prefix or path == prefix or path.startswith(prefix + "/")
        ):
            return True
    return False
