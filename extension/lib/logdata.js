// Turns a capture session's rows into what the log dialog shows: the posting
// page, the pages, the files and the answers. Pure, so it's unit-tested.

const byTime = (key) => (a, b) => (a[key] ?? 0) - (b[key] ?? 0);
const capturedMs = (p) => Date.parse(p.capturedAt) || p.updatedAt || 0;

/**
 * The page that is the job posting:
 * the latest page with JobPosting JSON-LD, else the latest page that matched
 * the keyword rule, else the first top-frame page the session captured.
 */
export function choosePosting(pages) {
  const sorted = [...pages].sort((a, b) => capturedMs(a) - capturedMs(b));
  const latest = (pred) => [...sorted].reverse().find(pred);
  return (
    latest((p) => p.jsonld) ||
    latest((p) => p.isPosting) ||
    sorted.find((p) => p.isTop) ||
    sorted[0] ||
    null
  );
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

export function buildLogData({ pages = [], uploads = [], answers = [] }) {
  const sortedPages = [...pages].sort((a, b) => capturedMs(a) - capturedMs(b));
  return {
    posting: choosePosting(sortedPages),
    pages: sortedPages,
    files: dedupeFiles(uploads),
    answers: answers.filter((a) => String(a.value ?? "").trim()).sort(byTime("updatedAt")),
  };
}
