// Rule 1 (README §4.2): known application sites. Classic script (content
// scripts can't be ES modules), so it attaches to globalThis.AppLogger.
// Entries are hostname suffixes, optionally with a path prefix.

(function (g) {
  const AL = (g.AppLogger = g.AppLogger || {});

  AL.ATS_DOMAINS = [
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "workday.com",
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "smartrecruiters.com",
    "icims.com",
    "jobvite.com",
    "workable.com",
    "bamboohr.com",
    "taleo.net",
    "successfactors.com",
    "oraclecloud.com",
    "eightfold.ai",
    "rippling.com",
    "breezy.hr",
    "recruitee.com",
    "jazzhr.com",
    "applytojob.com",
    "teamtailor.com",
    "personio.com",
    "dover.com",
    "wellfound.com",
    "handshake.com",
    "joinhandshake.com",
    "linkedin.com/jobs",
    "indeed.com",
  ];

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
