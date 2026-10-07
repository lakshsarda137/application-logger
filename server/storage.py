"""Folders on disk: month folders, name collisions, file writes, safe deletion."""

from __future__ import annotations

import os
import re
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path

MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]

MAX_FOLDER_NAME = 80
MAX_FILENAME = 150


def month_name(now: datetime) -> str:
    # Not strftime("%B"): that follows the process locale.
    return MONTHS[now.month - 1]


def month_folder(base_path: Path, now: datetime) -> Path:
    return Path(base_path) / month_name(now)


def expand_path(p: str | os.PathLike) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(p))))


def sanitize_folder_name(name: str) -> str:
    """`Google / SWE (Intern)` -> `google_swe_intern`."""
    ascii_name = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_name.lower()).strip("_")
    slug = slug[:MAX_FOLDER_NAME].rstrip("_")
    return slug or "application"


def sanitize_filename(name: str) -> str:
    """Strip directories and characters that are unsafe in a filename."""
    name = (name or "").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFC", name)
    name = re.sub(r"[\x00-\x1f\x7f:*?\"<>|]", "_", name).strip().lstrip(".")
    if not name:
        return "file"
    if len(name) > MAX_FILENAME:
        stem, dot, ext = name.rpartition(".")
        if dot and 0 < len(ext) <= 10:
            name = stem[: MAX_FILENAME - len(ext) - 1] + "." + ext
        else:
            name = name[:MAX_FILENAME]
    return name


# Copy numbers browsers and macOS add to duplicates: "Resume(75)", "Resume (2)",
# "Resume copy", "Resume copy 3", plus the mangled form some sites save them as
# ("Resume.tex (18)" -> "Resume_tex__18_") and a leftover LaTeX ".tex"/"_tex".
# Deliberately not "-1" or " 2026": those can be part of a real name.
_COPY_SUFFIX = re.compile(r"(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?|_+\d+_+|[._\s]tex)$", re.IGNORECASE)


def strip_copy_suffix(filename: str) -> str:
    """Strip copy numbers: "Ada_Lovelace_Resume(75).pdf" -> "Ada_Lovelace_Resume.pdf"."""
    stem, dot, ext = filename.rpartition(".")
    if not dot or not stem:
        stem, dot, ext = filename, "", ""
    cleaned = stem
    while True:
        shorter = _COPY_SUFFIX.sub("", cleaned).rstrip()
        if shorter == cleaned:
            break
        cleaned = shorter
    return f"{cleaned}{dot}{ext}" if cleaned else filename


def folder_candidates(name: str, now: datetime):
    """`name`, then `name_YYYY-MM-DD`, then `name_YYYY-MM-DD_HHMM`, then numbered."""
    date = now.strftime("%Y-%m-%d")
    stamp = f"{date}_{now.strftime('%H%M')}"
    yield name
    yield f"{name}_{date}"
    yield f"{name}_{stamp}"
    n = 2
    while True:
        yield f"{name}_{stamp}_{n}"
        n += 1


def create_unique_folder(parent: Path, name: str, now: datetime) -> Path:
    """Create and return a new folder under `parent`, avoiding collisions.

    Uses mkdir(exist_ok=False) so two concurrent saves can't claim the same name.
    """
    parent = Path(parent)
    if not parent.is_dir():
        raise FileNotFoundError(f"Save folder does not exist: {parent}")
    for candidate in folder_candidates(name, now):
        path = parent / candidate
        try:
            path.mkdir()
            return path
        except FileExistsError:
            continue
    raise AssertionError("unreachable")


def unique_file_path(folder: Path, filename: str) -> Path:
    path = folder / filename
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    n = 2
    while (folder / f"{stem} ({n}){suffix}").exists():
        n += 1
    return folder / f"{stem} ({n}){suffix}"


def write_file(folder: Path, filename: str, content: bytes) -> Path:
    path = unique_file_path(folder, sanitize_filename(filename))
    if not is_within(path, folder):
        raise ValueError(f"Refusing to write outside {folder}: {path}")
    with open(path, "xb") as f:
        f.write(content)
    return path


def is_within(path: Path, base: Path) -> bool:
    """True if `path` resolves to somewhere strictly inside `base`."""
    try:
        path_r = Path(path).resolve()
        base_r = Path(base).resolve()
    except OSError:
        return False
    return path_r != base_r and path_r.is_relative_to(base_r)


def remove_folder_safely(path: Path, base: Path) -> bool:
    """Delete `path` only if it's a directory strictly inside `base`.

    Returns True if something was deleted.
    """
    path = Path(path)
    if path.is_symlink() or not path.is_dir() or not is_within(path, base):
        return False
    shutil.rmtree(path)
    return True
