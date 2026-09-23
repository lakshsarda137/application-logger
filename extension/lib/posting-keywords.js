// Rule 2 (README §4.2): a page is a job posting if its visible text has a
// phrase from BOTH the qualifications and requirements groups, AND the page
// offers a way to apply (an "Apply" button/link, or an apply phrase in the
// text). Text-only matching used to fire on blog posts, docs and inboxes.

(function (g) {
  const AL = (g.AppLogger = g.AppLogger || {});

  AL.POSTING_KEYWORDS = {
    qualifications: [
      "qualifications", "preferred qualifications", "minimum qualifications", "basic qualifications",
      "nice to have", "bonus points", "who you are", "skills", "responsibilities", "what you'll do",
      "about the role", "job description",
    ],
    requirements: [
      "requirements", "required", "what you'll need", "what we're looking for", "must have",
      "you have", "you bring",
    ],
  };
  AL.APPLY_PHRASES = [
    "apply now", "apply for this job", "apply for this position", "apply for this role",
    "submit application", "submit your application", "start application", "start your application",
    "easy apply", "apply today",
  ];

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Letters/digits on either side mean we're inside a bigger word.
  const phraseRe = (phrases) =>
    new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${phrases.map(escape).join("|")})(?=$|[^\\p{L}\\p{N}])`, "iu");

  const groups = Object.values(AL.POSTING_KEYWORDS).map(phraseRe);
  const applyRe = phraseRe(AL.APPLY_PHRASES);

  const normalize = (text) => String(text || "").replace(/[‘’ʼ]/g, "'");

  /** Qualifications + requirements wording, and a way to apply. */
  AL.matchesPostingKeywords = function (text, { hasApplyControl = false } = {}) {
    const t = normalize(text);
    return groups.every((re) => re.test(t)) && (hasApplyControl || applyRe.test(t));
  };
})(globalThis);
