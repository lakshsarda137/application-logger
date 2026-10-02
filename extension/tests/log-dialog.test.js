// The log dialog in jsdom: a fake IndexedDB holding a capture session, a
// stubbed chrome.* API and a stubbed server behind fetch().

import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";

import { ensureSession, getSessionData, putAnswers, putPage, putUploads } from "../lib/sessions.js";
import { until } from "./helpers.js";

const HTML = readFileSync(new URL("../log-dialog.html", import.meta.url), "utf8");
const MONTH = { month: "October", path: "/Users/me/Professional/Sophomore/October", exists: true };
const NOW = Date.now();
let loadCount = 0;
let nextTab = 9000;

const file = (name, content) => ({ filename: name, mime: "application/pdf", size: content.length, lastModified: 7, blob: new Blob([content]) });

/** A session like a Workday flow: posting page, two form pages, two uploads, answers. */
async function seedSession() {
  const s = await ensureSession(nextTab++, { strong: true }, NOW);
  await putPage(s.id, {
    url: "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1",
    title: "Software Engineer Intern",
    text: "Responsibilities…",
    html: "<html>posting</html>",
    jsonld: { title: "Software Engineer Intern", hiringOrganization: { name: "Acme" } },
    isTop: true,
    isPosting: true,
    capturedAt: new Date(NOW - 60_000).toISOString(),
  }, NOW);
  await putPage(s.id, { url: "https://acme.wd5.myworkdayjobs.com/External/apply/1", title: "My Information", text: "form", isTop: true, capturedAt: new Date(NOW - 30_000).toISOString() }, NOW);
  await putPage(s.id, { url: "https://acme.wd5.myworkdayjobs.com/External/apply/2", title: "My Experience", text: "form", isTop: true, capturedAt: new Date(NOW - 10_000).toISOString() }, NOW);
  await putUploads(s.id, { fieldKey: "p2#resume", fieldLabel: "Resume/CV" }, [file("ada.pdf", "resume-bytes")], NOW);
  await putUploads(s.id, { fieldKey: "p2#other" }, [file("letter.pdf", "letter-bytes")], NOW + 1);
  await putAnswers(s.id, [
    { page_url: "https://acme.wd5.myworkdayjobs.com/External/apply/1", field_key: "k1", field_label: "Phone", value: "555" },
    { page_url: "https://acme.wd5.myworkdayjobs.com/External/apply/2", field_key: "k2", field_label: "Why Acme?", value: "Rockets" },
  ], NOW);
  return s;
}

const okServer = (onPost, { labels } = {}) => async (method, path, init) => {
  if (path === "/settings/month-folder") return { body: MONTH };
  if (path === "/files/classify") {
    const names = init.body.getAll("files").map((f) => f.name);
    return { body: names.map((n, i) => ({ filename: n, kind: labels?.[i] ?? "other", reason: "test" })) };
  }
  if (path === "/applications" && method === "POST") return onPost(init);
  return { status: 404, body: { detail: "nope" } };
};

async function openDialog(sessionId, server, { token = "tok", warn, url } = {}) {
  const q = new URLSearchParams({ session: sessionId, tab: "77" });
  if (warn) q.set("warn", warn);
  if (url) q.set("url", url);
  const dom = new JSDOM(HTML, { url: `chrome-extension://abc/log-dialog.html?${q}` });
  const { window } = dom;
  const requests = [];
  let closed = false;
  const tabCalls = [];
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    Option: window.Option,
    chrome: {
      storage: { local: { get: async (defaults) => ({ ...defaults, apiToken: token }) } },
      runtime: { openOptionsPage() {} },
      tabs: {
        update: async (id, props) => tabCalls.push(["update", id, props]),
        getCurrent: async () => ({ id: 78 }),
        remove: async (id) => {
          tabCalls.push(["remove", id]);
          closed = true;
        },
      },
    },
    fetch: async (url, init = {}) => {
      const path = new URL(url).pathname;
      const method = init.method || "GET";
      requests.push({ method, path, init });
      const { status = 200, body = {} } = await server(method, path, init);
      return new Response(JSON.stringify(body), { status });
    },
  });
  window.close = () => {
    closed = true;
  };
  await import(`../log-dialog.js?load=${++loadCount}`);
  const $ = (id) => window.document.getElementById(id);
  return { window, $, requests, tabCalls, isClosed: () => closed, all: (sel) => [...window.document.querySelectorAll(sel)] };
}

const submit = (d) => d.$("form").dispatchEvent(new d.window.Event("submit", { cancelable: true }));
const kinds = (d) => d.all("#files select").map((s) => s.value);

test("prefills from the posting page, not the later form pages", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer(null, { labels: ["resume", "cover_letter"] }));
  await until(() => d.$("save-path").textContent === MONTH.path, "month folder");

  assert.equal(d.$("company").value, "Acme");
  assert.equal(d.$("position").value, "Software Engineer Intern");
  assert.equal(d.$("folder-name").value, "acme_swe_intern");
  assert.equal(d.$("source").textContent, "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1");
  assert.equal(d.$("pages-summary").textContent, "3 of 3 page(s)");
  assert.equal(d.$("answers-summary").textContent, "2 answer(s)");
  assert.deepEqual(d.all("#files li .grow").map((x) => x.textContent), ["ada.pdf", "letter.pdf"]);
  await until(() => kinds(d).join() === "resume,cover_letter", "server labels");
});

test("server classifier labels files the user hasn't touched", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer(null, { labels: ["cover_letter", "resume"] }));
  await until(() => kinds(d).join() === "cover_letter,resume", "server labels");
});

test("save: payload uses the chosen posting page and included pages; session is cleared", async () => {
  const s = await seedSession();
  let posted;
  const d = await openDialog(s.id, okServer(async (init) => {
    posted = init;
    return { status: 201, body: { id: 1, folder_path: `${MONTH.path}/acme_swe_intern` } };
  }, { labels: ["resume", "cover_letter"] }));
  await until(() => kinds(d).join() === "resume,cover_letter", "labels");

  // Leave out the last form page and one answer.
  const boxes = d.all("#pages input[type=checkbox]");
  assert.equal(boxes[0].disabled, true, "the posting page can't be excluded");
  boxes[2].checked = false;
  boxes[2].dispatchEvent(new d.window.Event("change"));
  d.all("#answers button")[0].click();

  submit(d);
  await until(() => d.isClosed(), "tab closed after saving");
  assert.deepEqual(d.tabCalls, [["update", 77, { active: true }], ["remove", 78]], "back to the job tab, dialog tab closed");

  const payload = JSON.parse(await posted.body.get("payload").text());
  assert.equal(payload.posting.url, "https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_R1");
  assert.equal(payload.posting.html, "<html>posting</html>");
  assert.equal(payload.posting.jsonld.hiringOrganization.name, "Acme");
  assert.deepEqual(payload.pages.map((p) => p.title), ["Software Engineer Intern", "My Information"]);
  assert.deepEqual(payload.documents, [
    { kind: "resume", filename: "ada.pdf", mime: "application/pdf" },
    { kind: "cover_letter", filename: "letter.pdf", mime: "application/pdf" },
  ]);
  assert.deepEqual(payload.form_answers.map((a) => a.field_label), ["Why Acme?"]);
  assert.deepEqual(await Promise.all(posted.body.getAll("files").map((f) => f.text())), ["resume-bytes", "letter-bytes"]);
  assert.equal(await getSessionData(s.id), null, "session deleted after saving");
});

test("the page being logged is the posting, even if an older one has JSON-LD", async () => {
  const s = await ensureSession(nextTab++, { strong: true }, NOW);
  const rippling = "https://ats.rippling.com/globex/jobs/2";
  await putPage(s.id, { url: rippling, title: "Data Scientist - Globex", text: "x", isTop: true, isPosting: true, capturedAt: new Date(NOW - 60_000).toISOString() }, NOW);
  await putPage(s.id, { url: "https://boards.greenhouse.io/acme/jobs/1", title: "SWE", text: "x", jsonld: { title: "Software Engineer", hiringOrganization: { name: "Acme" } }, isTop: true, isPosting: true, capturedAt: new Date(NOW - 1_000).toISOString() }, NOW);
  const d = await openDialog(s.id, okServer(), { url: rippling });
  await until(() => d.$("source").textContent, "prefill");
  assert.equal(d.$("source").textContent, rippling);
  assert.notEqual(d.$("company").value, "Acme");
});

test("choosing a different posting page re-guesses the details", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer());
  await until(() => d.$("company").value === "Acme", "prefill");
  const radios = d.all("#pages input[type=radio]");
  radios[2].checked = true;
  radios[2].dispatchEvent(new d.window.Event("change"));
  assert.equal(d.$("position").value, "My Experience");
  assert.equal(d.$("source").textContent, "https://acme.wd5.myworkdayjobs.com/External/apply/2");
});

test("other recent uploads can be added", async () => {
  const s = await seedSession();
  const other = await ensureSession(nextTab++, {}, NOW);
  await putUploads(other.id, { fieldKey: "x", pageUrl: "https://drive.example.com/" }, [file("transcript.pdf", "grades")], NOW);

  let posted;
  const d = await openDialog(s.id, okServer(async (init) => {
    posted = init;
    return { status: 201, body: { id: 2, folder_path: "/x" } };
  }));
  await until(() => !d.$("recent-box").hidden, "recent box");
  assert.match(d.$("recent-summary").textContent, /\(\d+\)/);
  const row = d.all("#recent li").find((li) => li.textContent.includes("transcript.pdf"));
  assert.match(row.textContent, /drive\.example\.com/);
  row.querySelector("button").click();
  assert.ok(d.all("#files li .grow").some((x) => x.textContent === "transcript.pdf"));
  assert.ok(!d.all("#recent li").some((li) => li.textContent.includes("transcript.pdf")), "moved out of recent");

  submit(d);
  await until(() => posted, "save");
  const names = posted.body.getAll("files").map((f) => f.name);
  assert.ok(names.includes("transcript.pdf"));
});

test("server down: banner, and the capture is kept", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, async () => {
    throw new TypeError("Failed to fetch");
  });
  await until(() => !d.$("banner").hidden, "banner");
  assert.match(d.$("banner").textContent, /Server not running/);
  submit(d);
  await until(() => d.$("save").textContent === "Save" && !d.$("save").disabled, "save to finish");
  assert.match(d.$("banner").textContent, /Server not running/);
  assert.ok(await getSessionData(s.id), "session kept");
});

test("missing month folder: asks, Yes creates it; No switches to a custom folder", async () => {
  const s = await seedSession();
  let month = { ...MONTH, exists: false };
  let posted;
  const d = await openDialog(s.id, async (method, path, init) => {
    if (path === "/settings/month-folder" && method === "POST") return { body: (month = { ...MONTH, exists: true }) };
    if (path === "/settings/month-folder") return { body: month };
    if (path === "/files/classify") return { body: [] };
    posted = init;
    return { status: 201, body: { id: 3, folder_path: "/custom/acme" } };
  });
  await until(() => !d.$("month-missing").hidden, "prompt");
  assert.equal(d.$("month-name").textContent, "October");
  submit(d);
  assert.match(d.$("banner").textContent, /Create the October folder first/);
  assert.equal(d.requests.filter((r) => r.path === "/applications").length, 0);

  d.$("month-no").click();
  assert.ok(!d.$("custom-dir").hidden);
  submit(d);
  assert.match(d.$("banner").textContent, /Enter the folder to save into/);
  d.$("use-month").click();
  d.$("month-yes").click();
  await until(() => d.$("month-missing").hidden, "prompt closes");
  assert.equal(d.$("save-path").textContent, MONTH.path);
  submit(d);
  await until(() => posted, "save");
  assert.equal(JSON.parse(await posted.body.get("payload").text()).save_dir, "");
});

test("discard deletes the capture after confirming", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer());
  await until(() => d.$("company").value, "prefill");
  d.$("discard").click();
  const buttons = d.all("#discard-area button");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Yes, discard", "Keep it"]);
  buttons[0].click();
  await until(() => d.isClosed(), "closed");
  assert.equal(await getSessionData(s.id), null);
});

test("missing token: points to settings instead of calling the server", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer(), { token: "" });
  await until(() => !d.$("banner").hidden, "banner");
  assert.match(d.$("banner").textContent, /API token/);
  assert.equal(d.requests.length, 0);
});

test("capture warnings are shown when the server is fine", async () => {
  const s = await seedSession();
  const d = await openDialog(s.id, okServer(), { warn: "Could not read the page: blocked" });
  await until(() => !d.$("banner").hidden, "banner");
  assert.match(d.$("banner").textContent, /Could not read the page/);
});

test("expired or saved capture shows a message instead of the form", async () => {
  const d = await openDialog("does-not-exist", okServer());
  await until(() => !d.$("banner").hidden, "banner");
  assert.ok(d.$("form").hidden);
  assert.match(d.$("banner").textContent, /expired or was already saved/);
});

test("resume/cover letter names are shown and saved without copy numbers", async () => {
  const s = await ensureSession(nextTab++, { strong: true }, NOW);
  await putPage(s.id, { url: "https://jobs.lever.co/acme/1", title: "Acme - SWE", isTop: true }, NOW);
  await putUploads(s.id, { fieldKey: "r", fieldLabel: "Resume" }, [file("Ada_Lovelace_Resume(75).pdf", "r")], NOW);
  await putUploads(s.id, { fieldKey: "o" }, [file("transcript (3).pdf", "t")], NOW + 1);
  let posted;
  const d = await openDialog(s.id, okServer(async (init) => {
    posted = init;
    return { status: 201, body: { id: 9, folder_path: "/x" } };
  }, { labels: ["resume", "other"] }));
  await until(() => kinds(d).join() === "resume,other", "labels");
  const names = d.all("#files li .grow");
  assert.deepEqual(names.map((n) => n.textContent), ["Ada_Lovelace_Resume.pdf", "transcript (3).pdf"]);
  assert.match(names[0].title, /Uploaded as Ada_Lovelace_Resume\(75\)\.pdf/);

  submit(d);
  await until(() => posted, "save");
  const payload = JSON.parse(await posted.body.get("payload").text());
  assert.deepEqual(payload.documents.map((x) => x.filename), ["Ada_Lovelace_Resume.pdf", "transcript (3).pdf"]);
  assert.deepEqual(posted.body.getAll("files").map((f) => f.name), ["Ada_Lovelace_Resume.pdf", "transcript (3).pdf"]);
});

test("pages captured well before the posting start unticked", async () => {
  const s = await ensureSession(nextTab++, { strong: true }, NOW);
  const at = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();
  await putPage(s.id, { url: "https://job-boards.greenhouse.io/other/jobs/1", title: "Earlier job", isTop: true, isPosting: true, capturedAt: at(30) }, NOW);
  await putPage(s.id, { url: "https://acme.com/jobs/2", title: "The posting", isTop: true, jsonld: { title: "SWE" }, capturedAt: at(10) }, NOW);
  await putPage(s.id, { url: "https://acme.com/apply/2", title: "Apply", isTop: true, capturedAt: at(5) }, NOW);
  const d = await openDialog(s.id, okServer());
  await until(() => d.$("pages-summary").textContent === "2 of 3 page(s)", "defaults");
  assert.deepEqual(d.all("#pages input[type=checkbox]").map((b) => b.checked), [false, true, true]);
});
