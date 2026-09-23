// Runs in the page's own JS world (manifest "world": "MAIN"), at document_start.
//
// Some upload widgets create an <input type=file> that is never attached to
// the document, click() it, and read the file in its change handler. That
// change event never reaches document, so the content script's listener
// can't see it. This wraps click()/showPicker() to watch such detached
// inputs and hand their files to the content script via postMessage.

(() => {
  // Injected again into open tabs when the extension reloads; wrap only once.
  if (window.__appLoggerHooked) return;
  Object.defineProperty(window, "__appLoggerHooked", { value: true });
  const TYPE = "app-logger:detached-files";
  const proto = HTMLInputElement.prototype;
  const watched = new WeakSet();

  function watch(input) {
    if (input.type !== "file" || input.isConnected || watched.has(input)) return;
    watched.add(input);
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
