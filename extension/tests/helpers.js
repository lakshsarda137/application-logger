// Test helpers: build jsdom pages and load the extension's classic
// content-script files into them the way Chrome does (plain script eval).

import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

export const CAPTURE_FILES = ["lib/ats-domains.js", "lib/posting-keywords.js", "lib/capture.js"];

export function makePage(html, { url = "https://boards.greenhouse.io/acme/jobs/1", config } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  if (config) dom.window.eval(`globalThis.AppLogger = { config: ${JSON.stringify(config)} };`);
  return dom;
}

export function loadScripts(window, files) {
  for (const file of files) window.eval(read(file));
  return window.AppLogger;
}

export function attachFile(window, input, name, content, type = "application/pdf") {
  const file = new window.File([content], name, { type, lastModified: 1700000000000 });
  // Writable so code under test can swap in renamed files (input.files = ...).
  Object.defineProperty(input, "files", { value: [file], configurable: true, writable: true });
  return file;
}

/** jsdom has no DataTransfer; enough of one for `new DataTransfer(); items.add(); .files`. */
export function installDataTransfer(window) {
  window.DataTransfer = class {
    constructor() {
      this._files = [];
      this.items = { add: (f) => this._files.push(f) };
    }
    get files() {
      return this._files;
    }
  };
}

// Same table as tests/test_units.py::test_strip_copy_suffix (names are placeholders).
export const COPY_CASES = [
  ["Ada_Lovelace_Resume(75).pdf", "Ada_Lovelace_Resume.pdf"],
  ["Ada_Lovelace_Resume (2).pdf", "Ada_Lovelace_Resume.pdf"],
  ["Resume copy.docx", "Resume.docx"],
  ["Resume copy 3.docx", "Resume.docx"],
  ["Resume (2) copy.pdf", "Resume.pdf"],
  ["Cover_Letter(1)(2).pdf", "Cover_Letter.pdf"],
  ["Ada_Lovelace_Resume.pdf", "Ada_Lovelace_Resume.pdf"],
  ["Ada_Lovelace_Resume_Quant.pdf", "Ada_Lovelace_Resume_Quant.pdf"],
  ["Resume 2026.pdf", "Resume 2026.pdf"],
  ["Resume-1.pdf", "Resume-1.pdf"],
  ["Copywriter Resume.pdf", "Copywriter Resume.pdf"],
  ["(75).pdf", "(75).pdf"],
  ["Resume(3)", "Resume"],
  ["Ada_Lovelace_Resume_tex__18_ (6).pdf", "Ada_Lovelace_Resume.pdf"],
  ["Ada_Lovelace_Resume_General_tex_18_ (49).pdf", "Ada_Lovelace_Resume_General.pdf"],
  ["Ada_Lovelace_Resume.tex (18).pdf", "Ada_Lovelace_Resume.pdf"],
  ["Ada_Lovelace_Resume_v2.pdf", "Ada_Lovelace_Resume_v2.pdf"],
  ["Ada_Lovelace_Resume_2026.pdf", "Ada_Lovelace_Resume_2026.pdf"],
  ["Ada_Lovelace_Resume_LaTeX.pdf", "Ada_Lovelace_Resume_LaTeX.pdf"],
];

export async function until(fn, what = "condition", timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Arrays created inside jsdom have a different Array.prototype; copy them out. */
export const plain = (value) => JSON.parse(JSON.stringify(value));
