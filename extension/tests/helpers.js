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
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  return file;
}

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
