// Runs in the page's own JS world (manifest "world": "MAIN"), at document_start.
//
// Some upload widgets create an <input type=file> that is never attached to
// the document, click() it, and read the file in its change handler. That
// change event never reaches document, so the content script's listener
// can't see it. This wraps click()/showPicker() to watch such detached
// inputs and hand their files to the content script via postMessage.
//
// On job pages (content.js sets data-app-logger-job-page on <html>) it also
// strips copy numbers from resume/cover letter names ("Resume(75).pdf" ->
// "Resume.pdf") before the page reads the file, like content.js does for
// ordinary inputs. The rename rules repeat lib/capture.js's: this file runs in
// the page's world and can't share code with it.

(() => {
  // Injected again into open tabs when the extension reloads; wrap only once.
  if (window.__appLoggerHooked) return;
  Object.defineProperty(window, "__appLoggerHooked", { value: true });
  const TYPE = "app-logger:detached-files";
  const proto = HTMLInputElement.prototype;
  const watched = new WeakSet();

  const COPY_SUFFIX = /(?:\s*\(\d+\)|\s+copy(?:\s+\d+)?|_+\d+_+|[._\s]tex)$/i;
  const RESUME_OR_COVER = /r[eé]sum[eé]|(^|[^a-z])cv([^a-z]|$)|cover/i;

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

  function cleanNames(input) {
    if (document.documentElement.getAttribute("data-app-logger-job-page") !== "1") return;
    if (!input.files || !input.files.length) return;
    const label = input.getAttribute("aria-label") || input.name || "";
    const dt = new DataTransfer();
    let changed = false;
    for (const f of input.files) {
      const clean = cleanFilename(f.name);
      if (clean !== f.name && (RESUME_OR_COVER.test(f.name) || RESUME_OR_COVER.test(label))) {
        dt.items.add(new File([f], clean, { type: f.type, lastModified: f.lastModified }));
        changed = true;
      } else {
        dt.items.add(f);
      }
    }
    if (changed) {
      try {
        input.files = dt.files;
      } catch (e) {}
    }
  }

  function watch(input) {
    if (input.type !== "file" || input.isConnected || watched.has(input)) return;
    watched.add(input);
    // Capture listeners on the target run before the page's own (bubble) ones.
    input.addEventListener("input", () => cleanNames(input), true);
    input.addEventListener("change", () => cleanNames(input), true);
    input.addEventListener("change", () => {
      if (!input.files || !input.files.length) return;
      window.postMessage(
        { type: TYPE, files: Array.from(input.files), label: input.getAttribute("aria-label") || input.name || "" },
        "*",
      );
    });
  }

  for (const name of ["click", "showPicker"]) {
    const original = proto[name];
    if (typeof original !== "function") continue;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (...args) {
        try {
          watch(this);
        } catch (e) {}
        return original.apply(this, args);
      },
    });
  }
})();
