// content.js in jsdom, with chrome.runtime.sendMessage stubbed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { attachFile, CAPTURE_FILES, installDataTransfer, loadScripts, makePage, until } from "./helpers.js";

const FAST = { quietMs: 20, maxSettleMs: 300, urlPollMs: 25, answerDebounceMs: 20 };
const HOOK = readFileSync(new URL("../lib/main-world-hook.js", import.meta.url), "utf8");

// content.js polls the URL with setInterval; close each window so the process can exit.
const open = [];
afterEach(() => {
  while (open.length) open.pop().window.close();
});

function start(html, { url, capturing = true, applied = null, hook = false, config = {}, storage = {} } = {}) {
  const dom = makePage(html, { url, config: { ...FAST, ...config } });
  open.push(dom);
  const sent = [];
  dom.window.chrome = {
    runtime: {
      id: "test-extension",
      sendMessage: async (msg) => {
        sent.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === "shouldCapture") return { capturing: msg.matched || capturing };
        if (msg.type === "check") return applied ? { applied: true, application: applied } : { applied: false };
        return { ok: true };
      },
    },
    storage: {
      local: { get: async (defaults) => ({ ...defaults, ...storage }) },
      onChanged: { addListener() {} },
    },
  };
  installDataTransfer(dom.window);
  if (hook) {
    // jsdom leaves event.source null for self-posted messages; Chrome sets it
    // to the window, and content.js checks for that. Mimic Chrome.
    dom.window.postMessage = (data) =>
      setTimeout(() => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data, source: dom.window })));
    dom.window.eval(HOOK);
  }
  loadScripts(dom.window, [...CAPTURE_FILES, "content.js"]);
  const of = (type) => sent.filter((m) => m.type === type);
  return { dom, window: dom.window, doc: dom.window.document, sent, of };
}

const POSTING = `<html><head><title>SWE at Acme</title>
  <script type="application/ld+json">{"@type":"JobPosting","title":"SWE","identifier":{"value":"R9"},"hiringOrganization":{"name":"Acme"}}</script>
  </head><body><h1>SWE</h1><label for="why">Why us?</label><textarea id="why"></textarea>
  <label for="cv">Resume</label><input type="file" id="cv" name="resume"></body></html>`;

test("posting page: asks to capture, sends a snapshot, checks 'applied here'", async () => {
  const t = start(POSTING, { url: "https://careers.acme.com/jobs/9" });
  await until(() => t.of("check").length, "check");
  assert.deepEqual(t.of("shouldCapture")[0], {
    type: "shouldCapture",
    matched: true,
    url: "https://careers.acme.com/jobs/9",
    hasForm: true,
    posting: {
      url: "https://careers.acme.com/jobs/9",
      title: "SWE at Acme",
      jsonld: { title: "SWE", identifier: { value: "R9" }, hiringOrganization: { name: "Acme" } },
    },
  });
  const page = t.of("page")[0];
  assert.equal(page.snapshot.url, "https://careers.acme.com/jobs/9");
  assert.equal(page.isPosting, true);
  assert.deepEqual(page.snapshot.files, [], "files aren't read during passive capture");
  assert.deepEqual(t.of("check")[0], { type: "check", url: "https://careers.acme.com/jobs/9", jobId: "R9", company: "Acme" });
});

test("unrelated page: nothing captured, but the applied check still runs", async () => {
  const t = start("<body><p>Just a blog post about requirements.</p></body>", {
    url: "https://blog.example.com/post",
    capturing: false,
  });
  await until(() => t.of("check").length, "check");
  assert.deepEqual(t.of("shouldCapture")[0], { type: "shouldCapture", matched: false, url: "https://blog.example.com/post", hasForm: false });
  assert.equal(t.of("page").length, 0);
});

test("toast appears when already applied, and goes away on navigation", async () => {
  const t = start(POSTING, {
    url: "https://careers.acme.com/jobs/9",
    applied: { id: 4, company: "Acme", position: "SWE", applied_at: "2026-10-03T14:32:00-05:00" },
  });
  await until(() => t.doc.querySelector("[data-application-logger=toast]"), "toast");
  t.window.history.pushState({}, "", "/jobs/10");
  await until(() => !t.doc.querySelector("[data-application-logger=toast]"), "toast removed");
});

test("SPA navigation (pushState) triggers a new capture", async () => {
  const t = start(POSTING, { url: "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R9" });
  await until(() => t.of("page").length === 1, "first page");
  t.window.history.pushState({}, "", "/External/job/NYC/SWE_R9/apply");
  await until(() => t.of("page").length === 2, "second page");
  assert.equal(t.of("page")[1].snapshot.url, "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R9/apply");
});

test("picking a file sends it immediately, with its field", async () => {
  const t = start(POSTING, { url: "https://careers.acme.com/jobs/9" });
  const input = t.doc.getElementById("cv");
  attachFile(t.window, input, "Ada_Resume.pdf", "%PDF resume");
  input.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await until(() => t.of("upload").length, "upload");
  const up = t.of("upload")[0];
  assert.equal(up.fieldKey, "careers.acme.com/jobs/9#resume");
  assert.equal(up.fieldLabel, "Resume");
  assert.equal(up.pageUrl, "https://careers.acme.com/jobs/9");
  assert.equal(up.files[0].filename, "Ada_Resume.pdf");
  assert.equal(Buffer.from(up.files[0].base64, "base64").toString(), "%PDF resume");
});

test("uploads are sent even on pages that aren't being captured", async () => {
  const t = start(`<body><input type="file" id="f" aria-label="Attach"></body>`, {
    url: "https://mail.example.com/",
    capturing: false,
  });
  const input = t.doc.getElementById("f");
  attachFile(t.window, input, "doc.pdf", "x");
  input.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await until(() => t.of("upload").length, "upload");
});

test("drag-and-drop files are captured", async () => {
  const t = start(`<body><div aria-label="Drop your resume"><span id="zone">Drop here</span></div></body>`, {
    url: "https://acme.com/apply",
  });
  const file = new t.window.File(["dropped"], "cv.pdf", { type: "application/pdf" });
  const drop = new t.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
  t.doc.getElementById("zone").dispatchEvent(drop);
  await until(() => t.of("upload").length, "upload");
  assert.equal(t.of("upload")[0].fieldKey, "acme.com/apply#drop:Drop your resume");
  assert.equal(t.of("upload")[0].files[0].filename, "cv.pdf");
});

test("files from a detached <input type=file> are captured via the main-world hook", async () => {
  const t = start(`<body><button id="b">Upload</button></body>`, { url: "https://acme.com/apply", hook: true });
  // What some upload widgets do: an input that is never added to the page.
  const input = t.doc.createElement("input");
  input.type = "file";
  input.setAttribute("aria-label", "Resume");
  input.click();
  attachFile(t.window, input, "detached.pdf", "d");
  input.dispatchEvent(new t.window.Event("change"));
  await until(() => t.of("upload").length, "upload");
  assert.equal(t.of("upload")[0].fieldKey, "acme.com/apply#detached:Resume");
  assert.equal(t.of("upload")[0].files[0].filename, "detached.pdf");
});

test("answers are sent on change/blur (debounced) while capturing", async () => {
  const t = start(POSTING, { url: "https://careers.acme.com/jobs/9" });
  await until(() => t.of("page").length, "page");
  const why = t.doc.getElementById("why");
  why.value = "Rock";
  why.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  why.value = "Rockets";
  why.dispatchEvent(new t.window.FocusEvent("focusout", { bubbles: true }));
  await until(() => t.of("answers").length, "answers");
  const answers = t.of("answers").flatMap((m) => m.answers);
  assert.equal(answers.at(-1).value, "Rockets");
  assert.equal(answers.at(-1).field_label, "Why us?");
});

test("answers on an uncaptured page re-ask, and are dropped if still not capturing", async () => {
  const t = start(`<body><label for="q">Name</label><input id="q"></body>`, {
    url: "https://blog.example.com/",
    capturing: false,
  });
  await until(() => t.of("check").length, "evaluated");
  const q = t.doc.getElementById("q");
  q.value = "Ada";
  q.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await until(() => t.of("shouldCapture").length === 2, "re-ask");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.of("answers").length, 0);
});

test("sensitive fields never produce answer messages", async () => {
  const t = start(`<body><label for="d">Date of birth</label><input id="d">
    <label for="ok">City</label><input id="ok"></body>`, { url: "https://jobs.lever.co/acme/1" });
  await until(() => t.of("page").length, "page");
  for (const [id, v] of [["d", "2007-01-01"], ["ok", "NYC"]]) {
    const el = t.doc.getElementById(id);
    el.value = v;
    el.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  }
  await until(() => t.of("answers").length, "answers");
  const labels = t.of("answers").flatMap((m) => m.answers.map((a) => a.field_label));
  assert.deepEqual(labels, ["City"]);
});

test("loading content.js twice doesn't double-register listeners", async () => {
  const t = start(POSTING, { url: "https://careers.acme.com/jobs/9" });
  loadScripts(t.window, ["content.js"]);
  const input = t.doc.getElementById("cv");
  attachFile(t.window, input, "a.pdf", "x");
  input.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await until(() => t.of("upload").length, "upload");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(t.of("upload").length, 1);
});

test("re-injection is a no-op while alive, but replaces an orphaned copy", async () => {
  const t = start(POSTING, { url: "https://careers.acme.com/jobs/9" });
  await until(() => t.of("page").length, "page");
  const before = t.of("page").length;

  loadScripts(t.window, ["content.js"]);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(t.of("page").length, before, "live copy: second injection does nothing");

  // Extension reloaded: the old copy's runtime loses its id.
  t.window.chrome.runtime = { sendMessage: t.window.chrome.runtime.sendMessage };
  assert.equal(t.window.AppLogger.contentAlive(), false);
  loadScripts(t.window, ["content.js"]);
  await until(() => t.of("page").length > before, "fresh copy captures the page");
});

// ---------------------------------------------------------------- copy numbers in upload names

// Picks a file and waits until the upload is cached (so nothing runs after the test).
async function pick(t, id, name) {
  const input = t.doc.getElementById(id);
  const before = t.of("upload").length;
  attachFile(t.window, input, name, "%PDF bytes");
  input.dispatchEvent(new t.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await until(() => t.of("upload").length > before, "upload cached");
  return input;
}

test("on a job site, 'Resume(75).pdf' reaches the site as 'Resume.pdf'", async () => {
  const t = start(POSTING, { url: "https://jobs.lever.co/acme/1/apply" });
  // What the site's own handler sees (it runs after the content script's capture listener).
  let seenBySite = null;
  t.doc.getElementById("cv").addEventListener("change", (e) => (seenBySite = e.target.files[0].name));
  const input = await pick(t, "cv", "Ada_Lovelace_Resume(75).pdf");
  assert.equal(input.files[0].name, "Ada_Lovelace_Resume.pdf");
  assert.equal(seenBySite, "Ada_Lovelace_Resume.pdf");
  assert.equal(input.files[0].type, "application/pdf");
  assert.equal(input.files[0].lastModified, 1700000000000);
  await until(() => t.of("upload").length, "upload");
  const cached = t.of("upload")[0].files[0];
  assert.equal(cached.filename, "Ada_Lovelace_Resume.pdf");
  assert.equal(Buffer.from(cached.base64, "base64").toString(), "%PDF bytes", "same bytes, new name");
});

test("a copy-numbered file in a field labelled Resume is renamed too", async () => {
  const t = start(POSTING, { url: "https://jobs.lever.co/acme/1/apply" });
  assert.equal((await pick(t, "cv", "Ada (3).pdf")).files[0].name, "Ada.pdf");
});

test("non-resume files and names without copy numbers are left alone", async () => {
  const t = start(
    `<body><label for="p">Profile photo</label><input type="file" id="p">
     <label for="cv">Resume</label><input type="file" id="cv"></body>`,
    { url: "https://jobs.lever.co/acme/1/apply" },
  );
  assert.equal((await pick(t, "p", "photo (2).png")).files[0].name, "photo (2).png");
  assert.equal((await pick(t, "cv", "Ada_Lovelace_Resume_Quant.pdf")).files[0].name, "Ada_Lovelace_Resume_Quant.pdf");
});

test("not renamed on sites that aren't job pages", async () => {
  const t = start(`<body><label for="cv">Resume</label><input type="file" id="cv"></body>`, {
    url: "https://drive.example.com/upload",
    capturing: false,
  });
  await until(() => t.of("check").length, "evaluated");
  assert.equal((await pick(t, "cv", "Ada_Lovelace_Resume(75).pdf")).files[0].name, "Ada_Lovelace_Resume(75).pdf");
  assert.equal(t.doc.documentElement.hasAttribute("data-app-logger-job-page"), false);
});

test("a custom-domain page becomes a job page once the session says so", async () => {
  const t = start(`<body><label for="cv">Resume</label><input type="file" id="cv"></body>`, {
    url: "https://careers.acme.com/apply/2",
    capturing: true,
  });
  await until(() => t.doc.documentElement.getAttribute("data-app-logger-job-page") === "1", "flag");
  assert.equal((await pick(t, "cv", "Resume (2).pdf")).files[0].name, "Resume.pdf");
});

test("detached inputs on job pages are renamed by the page-world hook", async () => {
  const t = start(`<body></body>`, { url: "https://jobs.lever.co/acme/1/apply", hook: true });
  const input = t.doc.createElement("input");
  input.type = "file";
  input.setAttribute("aria-label", "Resume");
  // The site's own handler, registered before the picker opens.
  let seenBySite = null;
  input.addEventListener("change", () => (seenBySite = input.files[0].name));
  input.click();
  attachFile(t.window, input, "Ada_Lovelace_Resume(75).pdf", "d");
  input.dispatchEvent(new t.window.Event("input"));
  input.dispatchEvent(new t.window.Event("change"));
  assert.equal(seenBySite, "Ada_Lovelace_Resume.pdf");
  await until(() => t.of("upload").length, "upload");
  assert.equal(t.of("upload")[0].files[0].filename, "Ada_Lovelace_Resume.pdf");
});

// ---------------------------------------------------------------- fixed resume name

const RESUME_NAME = { resumeName: "Ada_Lovelace_Resume" };
const APPLY_FORM = `<body><label for="cv">Resume/CV</label><input type="file" id="cv">
  <label for="cl">Cover Letter</label><input type="file" id="cl"></body>`;

test("with a resume name set, any resume reaches the site under that name", async () => {
  const t = start(APPLY_FORM, { url: "https://jobs.lever.co/acme/1/apply", storage: RESUME_NAME });
  await until(() => t.doc.documentElement.getAttribute("data-app-logger-resume-name"), "name published");
  assert.equal((await pick(t, "cv", "Ada_Lovelace_Resume_General_tex_18_ (49).pdf")).files[0].name, "Ada_Lovelace_Resume.pdf");
  assert.equal((await pick(t, "cv", "final draft.pdf")).files[0].name, "Ada_Lovelace_Resume.pdf", "by field label");
  assert.equal((await pick(t, "cl", "Ada_Cover_Letter (2).pdf")).files[0].name, "Ada_Cover_Letter.pdf");
  assert.equal((await pick(t, "cv", "Ada_Cover_Letter.pdf")).files[0].name, "Ada_Cover_Letter.pdf", "a cover letter stays one");
});

test("detached resume inputs get the resume name too", async () => {
  const t = start(`<body></body>`, { url: "https://jobs.lever.co/acme/1/apply", hook: true, storage: RESUME_NAME });
  await until(() => t.doc.documentElement.getAttribute("data-app-logger-resume-name"), "name published");
  const input = t.doc.createElement("input");
  input.type = "file";
  input.setAttribute("aria-label", "Resume");
  let seenBySite = null;
  input.addEventListener("change", () => (seenBySite = input.files[0].name));
  input.click();
  attachFile(t.window, input, "Ada_Lovelace_Resume_tex__18_ (6).pdf", "d");
  input.dispatchEvent(new t.window.Event("input"));
  input.dispatchEvent(new t.window.Event("change"));
  assert.equal(seenBySite, "Ada_Lovelace_Resume.pdf");
  await until(() => t.of("upload").length, "upload");
});

test("the resume name isn't published off job pages", async () => {
  const t = start(APPLY_FORM, { url: "https://drive.example.com/upload", capturing: false, storage: RESUME_NAME });
  await until(() => t.of("check").length, "evaluated");
  assert.equal(t.doc.documentElement.hasAttribute("data-app-logger-resume-name"), false);
  assert.equal((await pick(t, "cv", "Ada (2).pdf")).files[0].name, "Ada (2).pdf");
});

test("never-capture sites (Gmail, Docs, …) send no pages or answers, but uploads are still cached", async () => {
  const t = start(`<body><p>Qualifications Requirements Responsibilities</p>
    <label for="q">Subject</label><input id="q"><label for="cv">Attach</label><input type="file" id="cv"></body>`, {
    url: "https://mail.google.com/mail/u/0/#inbox",
    capturing: true,
  });
  await until(() => t.of("check").length, "evaluated");
  assert.equal(t.of("shouldCapture").length, 0);
  assert.equal(t.of("page").length, 0);
  const q = t.doc.getElementById("q");
  q.value = "Hello";
  q.dispatchEvent(new t.window.Event("change", { bubbles: true }));
  await pick(t, "cv", "resume.pdf");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(t.of("answers").length, 0);
  assert.equal(t.of("upload").length, 1);
});

test("empty embedded frames (ads, captchas) aren't sent as pages", async () => {
  // jsdom windows are always top-level, so tell content.js this is an iframe.
  const t = start(`<body><div></div></body>`, {
    url: "https://www.google.com/recaptcha/anchor",
    capturing: true,
    config: { isTop: false },
  });
  await until(() => t.of("shouldCapture").length, "asked");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(t.of("page").length, 0);
});
