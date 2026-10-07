"""Loads config.local.json (never committed), creating it on first run.

The API token is generated on first run and written back to the file so the
user can paste it into the extension's options page.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
EXAMPLE_PATH = REPO_ROOT / "config.example.json"
DEFAULT_CONFIG_PATH = REPO_ROOT / "config.local.json"

DEFAULTS = {
    "api_token": "",
    "base_path": "~/Desktop/Professional/Sophomore",
    "db_path": "~/Library/Application Support/ApplicationLogger/app.db",
    "host": "127.0.0.1",
    "port": 8765,
    # Optional: pin CORS to one extension ID (chrome://extensions shows it).
    # Empty means any chrome-extension:// origin; the token still applies.
    "extension_id": "",
    # Optional: every resume is uploaded and saved as "<resume_name>.<ext>",
    # whatever the file on disk is called. Empty keeps the original name
    # (minus copy numbers).
    "resume_name": "",
}

# Values in config.example.json that mean "generate one for me".
_PLACEHOLDER_TOKENS = {"", "generated-on-first-run", "change-me"}


@dataclass(frozen=True)
class Config:
    api_token: str
    base_path: Path
    db_path: Path
    host: str
    port: int
    extension_id: str
    path: Path
    resume_name: str = ""


def _expand(p: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(p)))


def load_config(path: Path | None = None) -> Config:
    path = Path(path or os.environ.get("APP_LOGGER_CONFIG") or DEFAULT_CONFIG_PATH)

    data: dict = {}
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
    elif EXAMPLE_PATH.exists():
        data = json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))

    merged = {**DEFAULTS, **data}
    dirty = not path.exists()

    if merged["api_token"] in _PLACEHOLDER_TOKENS:
        merged["api_token"] = secrets.token_urlsafe(32)
        dirty = True

    if dirty:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass

    host = str(merged["host"])
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError(f"host must be a loopback address, got {host!r}")

    return Config(
        api_token=str(merged["api_token"]),
        base_path=_expand(str(merged["base_path"])),
        db_path=_expand(str(merged["db_path"])),
        host=host,
        port=int(merged["port"]),
        extension_id=str(merged.get("extension_id") or ""),
        path=path,
        resume_name=str(merged.get("resume_name") or "").strip(),
    )
