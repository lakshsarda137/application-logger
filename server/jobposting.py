"""Pulls fields out of schema.org JobPosting JSON-LD.

The extension sends the raw JobPosting object; the server owns the mapping to
DB columns so there's one source of truth.
"""

from __future__ import annotations

import json
from typing import Any


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        return _text(value.get("name") or value.get("value") or value.get("@value"))
    if isinstance(value, list):
        items = [t for t in (_text(v) for v in value) if t]
        return ", ".join(dict.fromkeys(items)) or None
    return None


def _location(value: Any) -> str | None:
    if isinstance(value, list):
        items = [t for t in (_location(v) for v in value) if t]
        return "; ".join(dict.fromkeys(items)) or None
    if isinstance(value, dict):
        address = value.get("address", value)
        if isinstance(address, str):
            return address.strip() or None
        if isinstance(address, dict):
            parts = [
                _text(address.get(k))
                for k in ("addressLocality", "addressRegion", "addressCountry")
            ]
            return ", ".join(p for p in parts if p) or _text(value.get("name"))
    return _text(value)


def _salary(value: Any) -> str | None:
    if not isinstance(value, dict):
        return _text(value)
    currency = _text(value.get("currency")) or ""
    inner = value.get("value", value)
    if isinstance(inner, dict):
        lo, hi = inner.get("minValue"), inner.get("maxValue")
        single = inner.get("value")
        unit = _text(inner.get("unitText")) or ""
        if lo is not None and hi is not None:
            amount = f"{lo}–{hi}"
        elif single is not None or lo is not None or hi is not None:
            amount = str(single if single is not None else (lo if lo is not None else hi))
        else:
            return None
        return " ".join(p for p in (currency, amount, f"per {unit.lower()}" if unit else "") if p)
    return " ".join(p for p in (currency, _text(inner) or "") if p) or None


def parse_jobposting(jsonld: Any) -> dict[str, str | None]:
    """Map a JobPosting object (dict or JSON string) to our column names."""
    if isinstance(jsonld, str):
        try:
            jsonld = json.loads(jsonld)
        except ValueError:
            return {}
    if not isinstance(jsonld, dict):
        return {}

    identifier = jsonld.get("identifier")
    job_id = _text(identifier.get("value") if isinstance(identifier, dict) else identifier)

    location = _location(jsonld.get("jobLocation"))
    if not location and _text(jsonld.get("jobLocationType")) == "TELECOMMUTE":
        location = "Remote"

    return {
        "company": _text(jsonld.get("hiringOrganization")),
        "posting_title": _text(jsonld.get("title")),
        "location": location,
        "employment_type": _text(jsonld.get("employmentType")),
        "salary": _salary(jsonld.get("baseSalary")),
        "date_posted": _text(jsonld.get("datePosted")),
        "job_id": job_id,
    }
