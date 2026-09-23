// Rule 2 (README §4.2): a page is a job posting if its visible text contains
// at least one phrase from EACH group (case-insensitive, whole word/phrase).

(function (g) {
  const AL = (g.AppLogger = g.AppLogger || {});

  AL.POSTING_KEYWORDS = {
    qualifications: [
      "qualifications", "preferred qualifications", "minimum qualifications", "basic qualifications",
      "nice to have", "bonus points", "who you are", "skills",
    ],
    requirements: [
      "requirements", "required", "what you'll need", "what we're looking for", "must have",
      "you have", "you bring",
    ],
    role: [
      "responsibilities", "what you'll do", "about the role", "the role", "job description",
      "apply now", "apply for this job", "submit application", "equal opportunity employer",
    ],
  };

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

  // Letters/digits on either side mean we're inside a bigger word.
  const groups = Object.values(AL.POSTING_KEYWORDS).map(
    (phrases) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${phrases.map(escape).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu"),
  );

  AL.matchesPostingKeywords = function (text) {
    const normalized = String(text || "").replace(/[‘’ʼ]/g, "'");
    return groups.every((re) => re.test(normalized));
  };
})(globalThis);
