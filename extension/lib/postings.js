// Which job posting a page is. A capture session belongs to one posting, so a
// tab that moves on to another job (or a job opened from a search tab) starts
// a new session instead of piling every posting into one, and the log dialog
// can't show an older posting than the one being logged.

import { guessCompanyAndPosition, snake } from "./guess.js";

// Query parameters that name the job: LinkedIn's search pane, Greenhouse
// embeds, Indeed, and generic careers pages.
const JOB_PARAMS = new Set(["currentjobid", "gh_jid", "jk", "vjk", "jobid", "job_id", "jid"]);

/** host + path (+ job-id query parameters), e.g. "jobs.lever.co/acme/123". */
export function postingUrlKey(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  const path = u.pathname.replace(/\/+$/, "").toLowerCase();
  const ids = [...u.searchParams]
    .filter(([k]) => JOB_PARAMS.has(k.toLowerCase()))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort();
  return `${u.host.toLowerCase()}${path}${ids.length ? `?${ids.join("&")}` : ""}`;
}

/** Same page, or one is a later step of the other ("/jobs/1" and "/jobs/1/apply"). */
export function urlContinues(a, b) {
  if (!a || !b) return false;
  const [pathA, queryA = ""] = a.split("?");
  const [pathB, queryB = ""] = b.split("?");
  if (queryA !== queryB) return false;
  const [short, long] = pathA.length <= pathB.length ? [pathA, pathB] : [pathB, pathA];
  if (short === long) return true;
  // A bare host ("acme.com") is not a posting other pages can continue.
  return short.includes("/") && long.startsWith(`${short}/`);
}

const jobIdOf = (jsonld) => {
  const id = jsonld && jsonld.identifier;
  const value = id && typeof id === "object" ? id.value : id;
  return value == null ? "" : String(value).trim();
};

/** page: { url, title, jsonld } -> { key, jobId, company, position } */
export function postingIdentity({ url = "", title = "", jsonld = null } = {}) {
  const { company, position } = guessCompanyAndPosition({ url, title, jsonld: jsonld || undefined });
  return { key: postingUrlKey(url), jobId: jobIdOf(jsonld), company: snake(company), position: snake(position) };
}

/**
 * Whether two posting identities are the same job. Errs toward "different":
 * a wrongly split session only leaves an earlier page out of the log, but a
 * wrongly shared one shows (and deletes) the wrong posting.
 */
export function samePosting(a, b) {
  if (!a || !b) return false;
  if (a.jobId && b.jobId) {
    // IDs like "R12345" repeat across companies.
    return a.jobId === b.jobId && (!a.company || !b.company || a.company === b.company);
  }
  if (urlContinues(a.key, b.key)) return true;
  // The same job on another site (careers page -> its ATS).
  return Boolean(a.company && a.position && a.company === b.company && a.position === b.position);
}
