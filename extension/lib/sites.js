// "Site" = registrable domain, roughly: jobs.acme.com and careers.acme.com are
// both "acme.com". Used to keep a capture session on the application's own
// site (README §4.2 rule 4). Same rule as server/urls.py site_of().

const MULTI_PART_SUFFIX = /\.(co|com|ac|org|net|gov|edu)\.[a-z]{2}$/;

// Multi-purpose sites: their job pages are captured on their own (rule 1), but
// they never make the *rest* of the site capturable (your LinkedIn profile, feed).
export const BROAD_SITES = new Set([
  "linkedin.com",
  "indeed.com",
  "google.com",
  "joinhandshake.com",
  "handshake.com",
  "wellfound.com",
  "github.com",
  "glassdoor.com",
  "ziprecruiter.com",
]);

export function siteOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  return parts.slice(MULTI_PART_SUFFIX.test(host) ? -3 : -2).join(".");
}
