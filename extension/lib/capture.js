// Reads a page: visible text, HTML, JobPosting JSON-LD, form answers and files.
//
// Classic script: loaded as a content script (with ats-domains.js and
// posting-keywords.js before it) and injected by the service worker at log
// time. Attaches to globalThis.AppLogger.capture.

(function (g) {
  const AL = (g.AppLogger = g.AppLogger || {});

  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_TEXT = 1_000_000;
  const MAX_HTML = 8_000_000;
  const MAX_VALUE = 20_000;

  // Never captured: IDs, birth dates, payment details and EEO/demographic questions.
  const SENSITIVE =
    /\b(ssn|social security|social insurance|national insurance|tax id|taxpayer|date of birth|birth ?date|birthday|dob|gender|sex|race|racial|ethnic(ity)?|hispanic|latin[oax]|veteran|disabilit(y|ies)|disabled|sexual orientation|transgender|lgbtq?\+?|eeoc?|self[- ]?identif(y|ication)|demographic|passport|driver'?s? licen[cs]e|credit card|card number|cvv|cvc|bank account|routing number|iban)\b/i;
  const SENSITIVE_CONTAINER = /eeo|demographic|self[-_]?identif|voluntary|diversity|disability|veteran/i;
  const SENSITIVE_AUTOCOMPLETE = /^(bday|cc-|sex|new-password|current-password|one-time-code)/;
  const SKIP_TYPES = new Set(["hidden", "password", "file", "submit", "button", "reset", "image"]);

  const clean = (s) =>
    (s || "")
      .replace(/\s+/g, " ")
      .replace(/\s*\*\s*$/, "")
      .trim()
      .slice(0, 500);

  const textOf = (node) => clean(node ? node.innerText ?? node.textContent : "");

  function byIds(ids) {
    return clean(
      (ids || "")
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(" "),
    );
  }

  // The label of this specific control (for a radio: the option's label).
  function ownLabel(el) {
    if (el.labels && el.labels.length) return clean([...el.labels].map(textOf).join(" "));
    return (
      byIds(el.getAttribute("aria-labelledby")) ||
      clean(el.getAttribute("aria-label")) ||
      textOf(el.closest("label")) ||
      clean(el.getAttribute("placeholder")) ||
      clean(el.getAttribute("title"))
    );
  }

  // The question a radio/checkbox group (or an upload field) answers.
  function groupLabel(el) {
    const group = el.closest("fieldset, [role=radiogroup], [role=group]");
    if (group) {
      const legend = group.querySelector("legend");
      const label =
        (legend && textOf(legend)) ||
        byIds(group.getAttribute("aria-labelledby")) ||
        clean(group.getAttribute("aria-label"));
      if (label) return label;
    }
    // Common ATS markup: <div><label>Question</label> ...options... </div>
    let node = el.parentElement;
    for (let i = 0; node && i < 4; i++, node = node.parentElement) {
      const first = node.querySelector("label, .label, [class*=question], [class*=Label]");
      if (first && !first.contains(el) && !first.querySelector("input")) return textOf(first);
    }
    return "";
  }

  function inSensitiveContainer(el) {
    let node = el.parentElement;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      if (SENSITIVE_CONTAINER.test(`${node.id} ${typeof node.className === "string" ? node.className : ""}`)) {
        return true;
      }
      if (node.tagName === "FIELDSET") {
        const legend = node.querySelector("legend");
        if (legend && SENSITIVE.test(textOf(legend))) return true;
      }
    }
    return false;
  }

  function isSensitive(el, label) {
    const hay = [label, el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("data-automation-id")].join(" ");
    return (
      // "date_of_birth", "date-of-birth" and Workday's "dateOfBirth" all become "date of birth".
      SENSITIVE.test(hay.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ")) ||
      SENSITIVE_AUTOCOMPLETE.test(el.getAttribute("autocomplete") || "") ||
      inSensitiveContainer(el)
    );
  }

  // Copy numbers browsers and macOS add to duplicates: "Resume(75)", "Resume (2)",
  // "Resume copy 3". Not "-1" or " 2026", which can be part of a real name.
  // Same rule as server/storage.py strip_copy_suffix and lib/guess.js.
  const COPY_SUFFIX = /(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?)$/i;
  function cleanFilename(name) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    let stem = dot > 0 ? name.slice(0, dot) : name;
    for (let prev = null; prev !== stem; ) {
      prev = stem;
      stem = stem.replace(COPY_SUFFIX, "").trimEnd();
    }
    return stem ? stem + ext : name;
  }

  const RESUME_OR_COVER = /r[eé]sum[eé]|(^|[^a-z])cv([^a-z]|$)|cover/i;
  function isResumeOrCover(filename, fieldLabel) {
    return RESUME_OR_COVER.test(filename || "") || RESUME_OR_COVER.test(fieldLabel || "");
  }

  function fieldId(el) {
    return el.name || el.id || el.getAttribute("data-automation-id") || "";
  }

  /** Stable key for a field on this page (same field -> same key). */
  function fieldKey(el, label) {
    return `${location.host}${location.pathname}#${fieldId(el) || label || ownLabel(el) || el.tagName.toLowerCase()}`;
  }

  function radioGroup(el) {
    if (!el.name) return [el];
    const root = el.form || el.getRootNode() || document;
    return [...root.querySelectorAll("input")].filter((i) => i.name === el.name && i.type === el.type);
  }

  /**
   * The answer this field currently holds, or null if it isn't captured
   * (wrong type or sensitive). value may be "" (the user cleared it).
   */
  function answerFor(el) {
    const type = (el.type || "").toLowerCase();
    if (!el.matches || !el.matches("input, textarea, select") || SKIP_TYPES.has(type)) return null;

    if (type === "radio" || type === "checkbox") {
      const group = radioGroup(el);
      const options = group.map((i) => ownLabel(i) || i.value);
      const checked = group.filter((i) => i.checked).map((i) => ownLabel(i) || i.value);
      const single = group.length === 1;
      const question = single ? ownLabel(el) || clean(el.name) : groupLabel(el) || clean(el.name);
      if (isSensitive(el, `${question} ${options.join(" ")}`)) return null;
      return {
        page_url: location.href,
        field_key: fieldKey(el, question),
        field_label: question,
        field_name: fieldId(el),
        value: single ? (checked.length ? "Yes" : "") : checked.join(", "),
      };
    }

    let value;
    if (el.tagName === "SELECT") {
      value = [...el.selectedOptions]
        .filter((o) => o.value !== "")
        .map((o) => clean(o.textContent))
        .join(", ");
    } else {
      value = (el.value || "").trim();
    }
    const label = ownLabel(el) || clean(el.name) || clean(el.id);
    if (isSensitive(el, label)) return null;
    return {
      page_url: location.href,
      field_key: fieldKey(el, label),
      field_label: label,
      field_name: fieldId(el),
      value: value.slice(0, MAX_VALUE),
    };
  }

  function collectAnswers() {
    const answers = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("input, textarea, select")) {
      const a = answerFor(el);
      if (!a || !a.value || seen.has(a.field_key)) continue;
      seen.add(a.field_key);
      answers.push(a);
    }
    return answers;
  }

  function fileFieldLabel(input) {
    return ownLabel(input) || groupLabel(input) || clean(input.name) || "";
  }

  /** Key/label for a drag-and-drop: the nearest labelled ancestor of the drop target. */
  function dropTarget(target) {
    let node = target && target.nodeType === 1 ? target : target?.parentElement;
    // Stay close to the drop point: at <body> level every upload field on the page is "nearby".
    for (let i = 0; node && i < 4 && node !== document.body && node !== document.documentElement; i++, node = node.parentElement) {
      const input = node.querySelector && node.querySelector("input[type=file]");
      if (input) return { fieldKey: fieldKey(input, fileFieldLabel(input)), fieldLabel: fileFieldLabel(input) };
      const label = clean(node.getAttribute && (node.getAttribute("aria-label") || node.getAttribute("data-automation-id")));
      if (label) return { fieldKey: `${location.host}${location.pathname}#drop:${label}`, fieldLabel: label };
    }
    return { fieldKey: `${location.host}${location.pathname}#drop`, fieldLabel: "" };
  }

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** File/FileList -> [{ filename, mime, size, lastModified, base64 }] (skips >25 MB). */
  async function readFiles(files) {
    const out = [];
    for (const file of files) {
      if (!file || file.size > MAX_FILE_BYTES) continue;
      try {
        out.push({
          filename: file.name,
          mime: file.type || "",
          size: file.size,
          lastModified: file.lastModified,
          base64: await readAsBase64(file),
        });
      } catch (e) {
        // Unreadable (moved or deleted on disk); the dialog offers "add from disk".
      }
    }
    return out;
  }

  async function collectFiles() {
    const groups = [];
    for (const input of document.querySelectorAll("input[type=file]")) {
      if (!input.files || !input.files.length) continue;
      const fieldLabel = fileFieldLabel(input);
      const files = await readFiles(input.files);
      if (files.length) groups.push({ fieldKey: fieldKey(input, fieldLabel), fieldLabel, pageUrl: location.href, files });
    }
    return groups;
  }

  function findJobPosting() {
    const isJobPosting = (node) => {
      const t = node && node["@type"];
      return t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
    };
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 5) return null;
      if (Array.isArray(node)) {
        for (const n of node) {
          const found = walk(n, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (isJobPosting(node)) return node;
      return walk(node["@graph"], depth + 1);
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const found = walk(JSON.parse(script.textContent), 0);
        if (found) return found;
      } catch (e) {
        // Malformed JSON-LD is common; ignore it.
      }
    }
    return null;
  }

  function pageText() {
    const body = document.body;
    return (body ? (body.innerText ?? body.textContent ?? "") : "").slice(0, MAX_TEXT);
  }

  const APPLY_CONTROL = /^\s*(easy\s+)?apply(\s+(now|today|here|online|for\s+(this|the)\s+(job|position|role)))?\s*[›→>]?\s*$/i;

  /** An "Apply" button or link (short control text, not "apply" inside a sentence). */
  function hasApplyControl() {
    for (const c of document.querySelectorAll("a, button, [role=button], input[type=submit], input[type=button]")) {
      const label = clean(c.tagName === "INPUT" ? c.value : c.getAttribute("aria-label") || c.innerText || c.textContent);
      if (label.length <= 40 && APPLY_CONTROL.test(label)) return true;
    }
    return false;
  }

  const FILLABLE = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=search]), textarea, select";
  const NAME_FIELD = /\b(first|last|full|given|family|legal|preferred)[\s_-]?name\b|^name$/i;
  const EMAIL_FIELD = /e-?mail/i;
  const RESUME_WORD = /\b(r[eé]sum[eé]s?|cv|curriculum vitae)\b/i;
  const UPLOAD_WORD = /\b(upload|attach|drop|choose file|select file)\b/i;

  function fieldHay(el) {
    return [ownLabel(el), el.name, el.id, el.getAttribute("autocomplete"), el.getAttribute("placeholder"), el.getAttribute("data-automation-id")]
      .filter(Boolean)
      .join(" ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ");
  }

  /**
   * A job application form: it mentions a resume/CV, offers an upload, and
   * asks for your name or email. Contact forms (name + email + message) don't
   * mention a resume; plain uploads don't ask for your name.
   */
  function isApplicationForm(text = pageText()) {
    const fields = [...document.querySelectorAll(FILLABLE)];
    if (!fields.length) return false;
    const hasFile = fields.some((f) => f.type === "file");
    const hasResume = RESUME_WORD.test(text) || fields.some((f) => f.type === "file" && RESUME_WORD.test(fieldHay(f)));
    const hasUpload = hasFile || UPLOAD_WORD.test(text);
    const hasEmail = fields.some(
      (f) => f.type === "email" || /^email$/i.test(f.getAttribute("autocomplete") || "") || EMAIL_FIELD.test(fieldHay(f)),
    );
    const hasName = fields.some(
      (f) => /^(name|given-name|family-name)$/i.test(f.getAttribute("autocomplete") || "") || NAME_FIELD.test(fieldHay(f)),
    );
    return hasResume && hasUpload && (hasEmail || hasName);
  }

  /** At least two things to fill in (a search box alone doesn't count). Used for rule 4. */
  function hasFillableForm() {
    let n = 0;
    for (const f of document.querySelectorAll(FILLABLE)) {
      if (f.disabled || f.readOnly) continue;
      if (/search/i.test(`${f.getAttribute("role") || ""} ${f.name} ${f.id} ${f.getAttribute("aria-label") || ""}`)) continue;
      if (++n >= 2) return true;
    }
    return false;
  }

  /**
   * README §4.2: ats (rule 1), keywords (rule 2: posting wording + a way to
   * apply), jsonld (rule 3), form (an application form). `fillable` feeds rule 4.
   */
  function signals(text = pageText(), jsonld = findJobPosting()) {
    return {
      ats: AL.isAtsPage ? AL.isAtsPage(location.hostname, location.pathname) : false,
      jsonld: Boolean(jsonld),
      keywords: AL.matchesPostingKeywords ? AL.matchesPostingKeywords(text, { hasApplyControl: hasApplyControl() }) : false,
      form: isApplicationForm(text),
      fillable: hasFillableForm(),
    };
  }

  /** Everything about this frame right now. files: also read <input type=file> contents. */
  async function snapshot({ files = false } = {}) {
    const isTop = g.top === g.self;
    const text = pageText();
    const jsonld = findJobPosting();
    return {
      url: location.href,
      title: document.title || "",
      isTop,
      text,
      html: isTop ? document.documentElement.outerHTML.slice(0, MAX_HTML) : "",
      jsonld,
      signals: signals(text, jsonld),
      answers: collectAnswers(),
      files: files ? await collectFiles() : [],
      capturedAt: new Date().toISOString(),
    };
  }

  AL.capture = {
    answerFor,
    cleanFilename,
    isResumeOrCover,
    collectAnswers,
    dropTarget,
    fieldKey,
    fileFieldLabel,
    findJobPosting,
    hasApplyControl,
    hasFillableForm,
    isApplicationForm,
    readFiles,
    signals,
    snapshot,
  };
})(globalThis);
