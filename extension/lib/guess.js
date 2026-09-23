// Guesses company, position and folder name for the log dialog, and a default
// label for each file. Pure functions so they can be unit-tested in Node.

const text = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") return text(v.name ?? v.value);
  return String(v);
};

/** "acme-corp" -> "Acme Corp" */
export function prettifySlug(slug) {
  return decodeURIComponent(slug || "")
    .replace(/[-_+.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// [hostname regex, path regex] -> company slug capture group.
const URL_PATTERNS = [
  [/(^|\.)greenhouse\.io$/, /^\/(?:embed\/job_app\?for=)?([^/?#]+)\/jobs?\//],
  [/^jobs\.lever\.co$/, /^\/([^/?#]+)/],
  [/^jobs\.ashbyhq\.com$/, /^\/([^/?#]+)/],
  [/^apply\.workable\.com$/, /^\/([^/?#]+)/],
  [/^(jobs|careers)\.smartrecruiters\.com$/, /^\/([^/?#]+)/],
  [/^wellfound\.com$/, /^\/company\/([^/?#]+)/],
  [/^(www\.)?linkedin\.com$/, /^\/company\/([^/?#]+)/],
];

// Companies that live in the subdomain: acme.wd5.myworkdayjobs.com, acme.bamboohr.com, ...
const SUBDOMAIN_HOSTS =
  /^(?:careers-)?([a-z0-9-]+)\.(?:wd\d+\.)?(?:myworkdayjobs\.com|bamboohr\.com|breezy\.hr|recruitee\.com|teamtailor\.com|applytojob\.com|jobs\.personio\.(?:de|com)|icims\.com|jobvite\.com|rippling-ats\.com)$/;
const GENERIC_SUBDOMAINS = new Set(["www", "jobs", "careers", "apply", "app", "boards", "job-boards"]);

export function companyFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase();
  const pathAndQuery = u.pathname + u.search;

  // Greenhouse embeds: boards.greenhouse.io/embed/job_app?for=acme&token=123
  const embedFor = host.endsWith("greenhouse.io") && u.searchParams.get("for");
  if (embedFor) return prettifySlug(embedFor);

  for (const [hostRe, pathRe] of URL_PATTERNS) {
    if (!hostRe.test(host)) continue;
    const m = pathAndQuery.match(pathRe);
    if (m && m[1] && !GENERIC_SUBDOMAINS.has(m[1].toLowerCase())) return prettifySlug(m[1]);
  }
  const m = host.match(SUBDOMAIN_HOSTS);
  if (m && !GENERIC_SUBDOMAINS.has(m[1])) return prettifySlug(m[1]);
  return "";
}

// Title shapes seen on ATS pages, most specific first. Each returns
// { position, company } or null.
const TITLE_PATTERNS = [
  // Greenhouse: "Job Application for Software Engineer at Acme"
  (t) => {
    const m = t.match(/^job application for (.+?) at (.+)$/i);
    return m && { position: m[1], company: m[2] };
  },
  // "Software Engineer at Acme" / "Software Engineer @ Acme"
  (t) => {
    const m = t.match(/^(.+?)\s+(?:at|@)\s+(.+?)(?:\s+[|–—-]\s+.*)?$/i);
    return m && { position: m[1], company: m[2] };
  },
];

const SITE_SUFFIX =
  /\s*[|–—-]\s*(careers?|jobs?|job board|greenhouse|lever|workday|ashby|linkedin|indeed|smartrecruiters|workable)\b.*$/i;

export function parseTitle(title, { host = "" } = {}) {
  const t = text(title).replace(SITE_SUFFIX, "").trim();
  if (!t) return {};
  for (const pattern of TITLE_PATTERNS) {
    const r = pattern(t);
    if (r) return { position: r.position.trim(), company: r.company.trim() };
  }
  // Lever: "Acme - Software Engineer"
  if (/lever\.co$/.test(host)) {
    const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) return { company: m[1].trim(), position: m[2].trim() };
  }
  // Generic "Position - Company" / "Position | Company"
  const m = t.match(/^(.+?)\s+[|–—-]\s+(.+)$/);
  if (m) return { position: m[1].trim(), company: m[2].trim() };
  return { position: t };
}

/**
 * posting: { url, title, jsonld } -> { company, position }
 * Order per README: JSON-LD, then page title, then ATS URL patterns.
 */
export function guessCompanyAndPosition(posting = {}) {
  const jsonld = posting.jsonld || {};
  let company = text(jsonld.hiringOrganization);
  let position = text(jsonld.title);

  let host = "";
  try {
    host = new URL(posting.url).hostname;
  } catch {}

  const fromUrl = companyFromUrl(posting.url);
  const fromTitle = parseTitle(posting.title, { host });

  // A company slug in the URL is more reliable than splitting a title on "-".
  company = company || fromUrl || fromTitle.company || "";
  if (!position) {
    position = fromTitle.position || "";
    // If the title was "Acme - SWE" and we guessed wrong way round, fix it.
    if (fromUrl && position.toLowerCase() === fromUrl.toLowerCase() && fromTitle.company) {
      position = fromTitle.company;
    }
  }
  return { company, position };
}

const ABBREVIATIONS = [
  [/\bsoftware development engineer(ing)?\b/g, "sde"],
  [/\bsoftware engineer(ing)?\b/g, "swe"],
  [/\bmachine learning\b/g, "ml"],
  [/\bartificial intelligence\b/g, "ai"],
  [/\bproduct manag(er|ement)\b/g, "pm"],
  [/\bdata scien(tist|ce)\b/g, "ds"],
  [/\bquantitative\b/g, "quant"],
  [/\binternship\b/g, "intern"],
];

export function snake(s) {
  return (s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function shortPosition(position) {
  let p = (position || "").toLowerCase();
  p = p.replace(/\([^)]*\)/g, " "); // "(Remote)", "(Summer 2027)"
  for (const [re, abbr] of ABBREVIATIONS) p = p.replace(re, abbr);
  return snake(p);
}

/** "Google", "Software Engineer" -> "google_swe" (max 60 chars, snake_case) */
export function folderName(company, position) {
  const companySlug = snake(company.replace(/,?\s+(inc|llc|ltd|corp|corporation|co)\.?$/i, ""));
  const name = [companySlug, shortPosition(position)].filter(Boolean).join("_");
  return name.slice(0, 60).replace(/_+$/, "") || "application";
}

/**
 * Default label for a file, given the labels already assigned.
 * README §5.1 rules 1–2 (filename); the text-based rule 3 comes with the
 * server classifier in phase 2. Falls back to filling resume, then cover letter.
 */
export function defaultKind(filename, fieldLabel = "", taken = []) {
  // Filename wins over the upload field's label.
  for (const s of [filename, fieldLabel]) {
    const lower = (s || "").toLowerCase();
    if (/r[eé]sum[eé]|(^|[^a-z])cv([^a-z]|$)/.test(lower)) return "resume";
    if (/cover/.test(lower)) return "cover_letter";
  }
  if (!taken.includes("resume")) return "resume";
  if (!taken.includes("cover_letter")) return "cover_letter";
  return "other";
}
