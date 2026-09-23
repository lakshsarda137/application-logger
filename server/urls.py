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
