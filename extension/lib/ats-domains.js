// Rule 1 (README §4.2): known application sites. Classic script (content
// scripts can't be ES modules), so it attaches to globalThis.AppLogger.
// Entries are hostname suffixes, optionally with a path prefix.

(function (g) {
  const AL = (g.AppLogger = g.AppLogger || {});

  // Hosts (and path prefixes) that only serve job postings and applications.
  // Multi-purpose sites are narrowed to their candidate-facing parts, e.g. not
  // all of workday.com or rippling.com (their employee apps live there too).
  AL.ATS_DOMAINS = [
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "jobs.smartrecruiters.com",
    "careers.smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "apply.workable.com",
    "bamboohr.com/careers",
    "bamboohr.com/jobs",
    "taleo.net",
    "successfactors.com/career",
    "successfactors.eu/career",
    "oraclecloud.com/hcmUI/CandidateExperience",
    "eightfold.ai",
    "ats.rippling.com",
    "breezy.hr",
    "recruitee.com",
    "applytojob.com",
    "jazzhr.com",
    "teamtailor.com",
    "jobs.personio.com",
    "jobs.personio.de",
    "app.dover.com",
    "wellfound.com/jobs",
    "joinhandshake.com/jobs",
    "joinhandshake.com/stu/jobs",
    "linkedin.com/jobs",
    "indeed.com/viewjob",
    "indeed.com/jobs",
    "indeed.com/applystart",
    "smartapply.indeed.com",
  ];

  // Personal/productivity sites whose pages are never snapshotted, even when
  // their text looks like a job posting (an inbox full of job alerts) or the tab
  // belongs to a capture session. Uploads there are still cached. Keep in sync
  // with NEVER_CAPTURE in server/urls.py.
  AL.NEVER_CAPTURE = [
    "mail.google.com",
    "docs.google.com",
    "drive.google.com",
    "calendar.google.com",
    "meet.google.com",
    "chat.google.com",
    "contacts.google.com",
    "accounts.google.com",
    "keep.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "slack.com",
    "web.whatsapp.com",
    "instagram.com",
    "facebook.com",
    "messenger.com",
    "x.com",
    "twitter.com",
    "reddit.com",
    "youtube.com",
    "claude.ai",
    "chatgpt.com",
    "notion.so",
  ];

  AL.isNeverCapture = function (hostname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    return AL.NEVER_CAPTURE.some((d) => host === d || host.endsWith("." + d));
  };

  AL.isAtsPage = function (hostname, pathname) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    const path = String(pathname || "/");
    return AL.ATS_DOMAINS.some((entry) => {
      const slash = entry.indexOf("/");
      const domain = slash === -1 ? entry : entry.slice(0, slash);
      const prefix = slash === -1 ? "" : entry.slice(slash);
      const hostOk = host === domain || host.endsWith("." + domain);
      return hostOk && (!prefix || path === prefix || path.startsWith(prefix + "/"));
    });
  };
})(globalThis);
