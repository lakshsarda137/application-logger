"""Resume vs cover letter (README §5.1).

Rules, in order:
1. Filename contains "resume" or "cv" -> resume.
2. Filename contains "cover" -> cover letter.
3. Text contains all of Education, Experience, Projects and has more words
   than every other uploaded file (skipped when there's only one) -> resume.
4. Otherwise -> cover letter. If a cover letter was already found, the file
   becomes "other" instead, so three uploads don't produce two cover letters.
"""

from __future__ import annotations

import re

RESUME_NAME = re.compile(r"r[eé]sum[eé]|(?<![a-z])cv(?![a-z])", re.IGNORECASE)
COVER_NAME = re.compile(r"cover", re.IGNORECASE)
SECTIONS = ("education", "experience", "projects")
_WORD = re.compile(r"\w+")


def _has_sections(text: str) -> bool:
    return all(re.search(rf"\b{s}\b", text, re.IGNORECASE) for s in SECTIONS)


def classify(files: list[tuple[str, str]]) -> list[dict]:
    """files: [(filename, extracted_text)] -> [{"kind", "reason"}] in the same order."""
    counts = [len(_WORD.findall(text or "")) for _, text in files]
    results: list[dict | None] = []

    for i, (filename, text) in enumerate(files):
        if RESUME_NAME.search(filename or ""):
            results.append({"kind": "resume", "reason": "filename"})
        elif COVER_NAME.search(filename or ""):
            results.append({"kind": "cover_letter", "reason": "filename"})
        else:
            others = counts[:i] + counts[i + 1 :]
            if _has_sections(text or "") and (not others or counts[i] > max(others)):
                results.append({"kind": "resume", "reason": "sections"})
            else:
                results.append(None)

    have_cover = any(r and r["kind"] == "cover_letter" for r in results)
    out = []
    for r in results:
        if r is None:
            r = {"kind": "other" if have_cover else "cover_letter", "reason": "fallback"}
            have_cover = True
        out.append(r)
    return out
