// Turns a capture session's rows into what the log dialog shows: the posting
// page, the pages, the files and the answers. Pure, so it's unit-tested.

import { postingUrlKey, urlContinues } from "./postings.js";

const byTime = (key) => (a, b) => (a[key] ?? 0) - (b[key] ?? 0);
const capturedMs = (p) => Date.parse(p.capturedAt) || p.updatedAt || 0;

// Frames snapshotted together (a careers page and its Greenhouse iframe).
const SAME_SNAPSHOT_MS = 5000;

/**
 * The page that is the job posting:
 * the page being logged (loggedUrl) if it's a posting, else the latest posting
 * page (JSON-LD or keyword match), else the first top-frame page captured.
 * A posting page without JSON-LD gives way to one with it that is the same
 * posting: an earlier step of its URL ("/jobs/1" for "/jobs/1/apply") or a
 * frame snapshotted with it. An older posting never wins over a newer one.
 */
export function choosePosting(pages, loggedUrl = "") {
  const sorted = [...pages].sort((a, b) => capturedMs(a) - capturedMs(b));
  const latest = (pred) => [...sorted].reverse().find(pred);
  const postingLike = (p) => p.jsonld || p.isPosting;

  const anchor = (loggedUrl && latest((p) => p.url === loggedUrl && postingLike(p))) || latest(postingLike);
  if (anchor) {
    if (anchor.jsonld) return anchor;
    const key = postingUrlKey(anchor.url);
    const richer = latest(
      (p) =>
        p.jsonld &&
        (urlContinues(postingUrlKey(p.url), key) || Math.abs(capturedMs(p) - capturedMs(anchor)) <= SAME_SNAPSHOT_MS),
    );
    return richer || anchor;
  }
  return sorted.find((p) => p.isTop) || sorted[0] || null;
}

export function fileKey(f) {
  return `${f.filename}|${f.size}|${f.lastModified ?? ""}`;
}

/** Same file captured twice (input + drop, or two fields): keep the newest copy. */
export function dedupeFiles(files) {
  const seen = new Map();
  for (const f of [...files].sort(byTime("capturedAt"))) seen.set(fileKey(f), f);
  return [...seen.values()].sort(byTime("capturedAt"));
}

export function buildLogData({ pages = [], uploads = [], answers = [] }, { loggedUrl = "" } = {}) {
  const sortedPages = [...pages].sort((a, b) => capturedMs(a) - capturedMs(b));
  return {
    posting: choosePosting(sortedPages, loggedUrl),
    pages: sortedPages,
    files: dedupeFiles(uploads),
    answers: answers.filter((a) => String(a.value ?? "").trim()).sort(byTime("updatedAt")),
  };
}
