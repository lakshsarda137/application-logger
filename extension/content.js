// Content script, in every frame of every http(s) page (README §4).
//
// - Page snapshots: once the DOM settles (and after SPA URL changes), asks the
//   service worker whether this page should be cached (rules 1–4) and, if so,
//   sends a snapshot.
// - Uploads: any file picked into an <input type=file>, dropped on the page,
//   or picked through a detached input (see main-world-hook.js) is read and
//   cached, on every site, so it can't be lost.
// - Answers: field label + value on change/blur while the page is cached.
// - "You applied here" toast in the top frame.

(() => {
  const AL = globalThis.AppLogger;
  if (!AL || !AL.capture) return;
  // Skip if a live copy is already running. After an extension reload the old
  // copy is orphaned (chrome.runtime.id is gone), so a fresh one takes over.
  if (AL.contentAlive && AL.contentAlive()) return;
  AL.contentAlive = () => {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  };

  const cfg = Object.assign({ quietMs: 800, maxSettleMs: 6000, urlPollMs: 1000, answerDebounceMs: 400 }, AL.config);
  const isTop = cfg.isTop ?? window.top === window.self; // cfg.isTop: tests only
  // Gmail, Docs, Instagram, …: never snapshotted, no answers kept (uploads still are).
  const neverCapture = AL.isNeverCapture(location.hostname);
  const state = { capturing: false, url: location.href, toast: null };

  function send(message) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => null);
    } catch (e) {
      // The extension was reloaded; this old content script is orphaned.
      return Promise.resolve(null);
    }
  }

  const firstTarget = (e) => (e.composedPath ? e.composedPath()[0] : e.target);

  // ---------------------------------------------------------------- pages

  function settled() {
    return new Promise((resolve) => {
      let quiet;
      const done = () => {
        observer.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quiet);
        quiet = setTimeout(done, cfg.quietMs);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      quiet = setTimeout(done, cfg.quietMs);
      const cap = setTimeout(done, cfg.maxSettleMs);
    });
  }

  let evaluating = null;
  async function evaluate() {
    const url = location.href;
    await settled();
    if (url !== location.href) return; // navigated again; that evaluation will run

    if (neverCapture) {
      if (isTop) checkApplied();
      return;
    }
    const signals = AL.capture.signals();
    const matched = signals.ats || signals.jsonld || signals.keywords || signals.form;
    const isPosting = signals.jsonld || signals.keywords;
    const res = await send({
      type: "shouldCapture",
      matched,
      url: location.href,
      hasForm: signals.fillable,
      // Which job this is, so moving on to another job starts a new session.
      posting: isTop && isPosting ? postingInfo() : undefined,
    });
    state.capturing = Boolean(res && res.capturing);
    publishJobPage();

    if (state.capturing) {
      const snap = await AL.capture.snapshot({ files: false });
      // Embedded frames with no text (ads, trackers, captchas) aren't pages worth keeping.
      const worthKeeping = isTop || snap.text.trim().length >= 20;
      if (worthKeeping) await send({ type: "page", snapshot: snap, isPosting });
      if (snap.answers.length) await send({ type: "answers", answers: snap.answers });
    }
    if (isTop) checkApplied();
  }

  function postingInfo() {
    const job = AL.capture.findJobPosting();
    const jsonld = job ? { title: job.title, identifier: job.identifier, hiringOrganization: job.hiringOrganization } : null;
    return { url: location.href, title: document.title || "", jsonld };
  }

  function scheduleEvaluate() {
    evaluating = (evaluating || Promise.resolve()).then(evaluate, evaluate);
  }

  // SPAs (Workday) change the URL without a page load.
  setInterval(() => {
    if (location.href !== state.url) {
      state.url = location.href;
      removeToast();
      scheduleEvaluate();
    }
  }, cfg.urlPollMs);

  // ---------------------------------------------------------------- clean upload names
  //
  // On job pages, a resume/cover letter picked as "Resume(75).pdf" reaches the
  // site as "Resume.pdf". The file on disk is untouched: this swaps the File in
  // the input for a renamed copy (no re-read) during the "input" event, which
  // fires before "change" and before the site's own handlers read the file.

  const onJobPage = () => state.capturing || AL.isAtsPage(location.hostname, location.pathname);

  // Tell lib/main-world-hook.js (page world) so it can do the same for detached inputs.
  function publishJobPage() {
    if (onJobPage()) document.documentElement.setAttribute("data-app-logger-job-page", "1");
    else document.documentElement.removeAttribute("data-app-logger-job-page");
  }

  function cleanUploadNames(input) {
    if (!onJobPage() || !input.files || !input.files.length || typeof DataTransfer === "undefined") return;
    const label = AL.capture.fileFieldLabel(input);
    const dt = new DataTransfer();
    let changed = false;
    for (const f of input.files) {
      const clean = AL.capture.cleanFilename(f.name);
      if (clean !== f.name && AL.capture.isResumeOrCover(f.name, label)) {
        dt.items.add(new File([f], clean, { type: f.type, lastModified: f.lastModified }));
        changed = true;
      } else {
        dt.items.add(f);
      }
    }
    if (!changed) return;
    try {
      input.files = dt.files;
    } catch (e) {
      // Some exotic inputs refuse; the saved copy is still cleaned by the server.
    }
  }

  for (const type of ["input", "change"]) {
    document.addEventListener(
      type,
      (e) => {
        const t = firstTarget(e);
        if (t && t.tagName === "INPUT" && t.type === "file") cleanUploadNames(t);
      },
      true,
    );
  }

  // ---------------------------------------------------------------- uploads

  async function cacheFiles(fileList, { fieldKey, fieldLabel }) {
    const files = await AL.capture.readFiles(fileList);
    if (!files.length) return;
    await send({ type: "upload", fieldKey, fieldLabel, pageUrl: location.href, files });
  }

  document.addEventListener(
    "change",
    (e) => {
      const t = firstTarget(e);
      if (t && t.tagName === "INPUT" && t.type === "file" && t.files && t.files.length) {
        const fieldLabel = AL.capture.fileFieldLabel(t);
        cacheFiles(t.files, { fieldKey: AL.capture.fieldKey(t, fieldLabel), fieldLabel });
      }
    },
    true,
  );

  document.addEventListener(
    "drop",
    (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) cacheFiles(files, AL.capture.dropTarget(firstTarget(e)));
    },
    true,
  );

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.type !== "app-logger:detached-files") return;
    const files = Array.from(e.data.files || []).filter((f) => f instanceof File);
    const label = String(e.data.label || "");
    if (files.length) {
      cacheFiles(files, { fieldKey: `${location.host}${location.pathname}#detached:${label}`, fieldLabel: label });
    }
  });

  // ---------------------------------------------------------------- answers

  const pendingAnswers = new Map();
  let answerTimer = null;

  async function flushAnswers() {
    const answers = [...pendingAnswers.values()];
    pendingAnswers.clear();
    if (!answers.length || neverCapture) return;
    if (!state.capturing) {
      // Another frame may have started a session since this page was evaluated.
      // The user is typing into this page, so it has a form by definition.
      const res = await send({ type: "shouldCapture", matched: false, url: location.href, hasForm: true });
      state.capturing = Boolean(res && res.capturing);
    }
    if (state.capturing) await send({ type: "answers", answers });
  }

  function onField(e) {
    const t = firstTarget(e);
    if (!t || !t.matches || !t.matches("input, textarea, select") || t.type === "file") return;
    const answer = AL.capture.answerFor(t);
    if (!answer) return;
    pendingAnswers.set(answer.field_key, answer);
    clearTimeout(answerTimer);
    answerTimer = setTimeout(flushAnswers, cfg.answerDebounceMs);
  }

  document.addEventListener("change", onField, true);
  document.addEventListener("focusout", onField, true);
  // Don't lose the last few keystrokes when the tab navigates away.
  window.addEventListener("pagehide", () => {
    clearTimeout(answerTimer);
    flushAnswers();
  });

  // ---------------------------------------------------------------- "applied here" toast

  async function checkApplied() {
    const posting = AL.capture.findJobPosting() || {};
    const identifier = posting.identifier;
    const jobId = identifier && typeof identifier === "object" ? identifier.value : identifier;
    const org = posting.hiringOrganization;
    const company = org && typeof org === "object" ? org.name : org;
    const checkedUrl = location.href;
    const res = await send({
      type: "check",
      url: checkedUrl,
      jobId: jobId == null ? "" : String(jobId),
      company: company == null ? "" : String(company),
    });
    if (res && res.applied && res.application && location.href === checkedUrl) showToast(res.application);
  }

  function removeToast() {
    if (state.toast) state.toast.remove();
    state.toast = null;
  }

  function showToast(application) {
    removeToast();
    const host = document.createElement("div");
    host.setAttribute("data-application-logger", "toast");
    // Closed shadow root: page CSS can't restyle it and page JS can't reach in.
    const root = host.attachShadow({ mode: "closed" });
    const date = new Date(application.applied_at);
    const when = Number.isNaN(date.getTime())
      ? application.applied_at
      : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647; }
      .toast { display: flex; align-items: flex-start; gap: 8px; max-width: 320px; padding: 10px 12px;
        background: #1d1d1f; color: #fff; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25);
        font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      button { all: unset; cursor: pointer; }
      .main { flex: 1; }
      .title { font-weight: 600; }
      .sub { opacity: .75; font-size: 12px; margin-top: 2px; }
      .close { padding: 0 4px; opacity: .7; font-size: 16px; line-height: 1; }
      button:focus-visible { outline: 2px solid #4a9eff; outline-offset: 2px; border-radius: 4px; }
    `;
    const box = document.createElement("div");
    box.className = "toast";
    box.setAttribute("role", "status");

    const main = document.createElement("button");
    main.className = "main";
    main.title = "Open in the Application Logger dashboard";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = `You applied here on ${when}`;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = [application.company, application.position].filter(Boolean).join(" — ");
    main.append(title, sub);
    main.addEventListener("click", () => send({ type: "openApplication", id: application.id }));

    const close = document.createElement("button");
    close.className = "close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", removeToast);

    box.append(main, close);
    root.append(style, box);
    (document.body || document.documentElement).append(host);
    state.toast = host;
  }

  publishJobPage();
  scheduleEvaluate();
})();
