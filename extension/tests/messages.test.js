import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMessage, withTabLock } from "../lib/messages.js";
import { findSessionForTab, getSession, getSessionData, linkTab } from "../lib/sessions.js";

let nextTab = 5000;
const b64 = (s) => Buffer.from(s).toString("base64");

function deps({ openers = {}, api, opened = [] } = {}) {
  return {
    openerOf: async (tabId) => openers[tabId] ?? null,
    api: api || (async () => ({ applied: false })),
    openApplication: async (id) => opened.push(id),
  };
}
const from = (tabId) => ({ tab: { id: tabId } });
const snap = (url, extra = {}) => ({ url, title: "t", text: "text", html: "<html>", isTop: true, answers: [], ...extra });

test("an unmatched page in a tab without a session is not captured", async () => {
  const tab = nextTab++;
  const d = deps();
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: false }, from(tab), d), { capturing: false });
  assert.equal(await findSessionForTab(tab), null);
  assert.deepEqual(await handleMessage({ type: "page", snapshot: snap("https://blog.com") }, from(tab), d), { ok: false });
});

test("rule 4: after a matched page, unmatched pages on the same site are captured", async () => {
  const tab = nextTab++;
  const d = deps();
  const ask = (url, matched = false, hasForm = true) => handleMessage({ type: "shouldCapture", matched, url, hasForm }, from(tab), d);
  assert.deepEqual(await ask("https://careers.acme.com/jobs/1", true), { capturing: true });
  await handleMessage({ type: "page", snapshot: snap("https://careers.acme.com/jobs/1"), isPosting: true }, from(tab), d);
  // Multi-page application on the company's own site (subdomains count as the same site).
  assert.deepEqual(await ask("https://apply.acme.com/step2"), { capturing: true });
  await handleMessage({ type: "page", snapshot: snap("https://apply.acme.com/step2") }, from(tab), d);
  const { pages } = await getSessionData((await findSessionForTab(tab)).id);
  assert.deepEqual(pages.map((p) => [p.url, p.isPosting]).sort(), [
    ["https://apply.acme.com/step2", false],
    ["https://careers.acme.com/jobs/1", true],
  ]);
  // Same site but nothing to fill in (e.g. the company's About page): not captured.
  assert.deepEqual(await ask("https://acme.com/about", false, false), { capturing: false });
});

test("rule 4 does not follow you to other sites in the same tab", async () => {
  const tab = nextTab++;
  const d = deps();
  const ask = (url, matched = false, hasForm = true) => handleMessage({ type: "shouldCapture", matched, url, hasForm }, from(tab), d);
  await ask("https://job-boards.greenhouse.io/embed/job_app?for=seatgeek", true);
  await ask("https://seatgeek.com/jobs/8227553", true);
  for (const url of [
    "https://www.linkedin.com/in/someone/",
    "https://mail.google.com/mail/u/0/#inbox",
    "https://www.instagram.com/stories/x/",
    "https://li.protechts.net/index.html",
  ]) {
    assert.deepEqual(await ask(url), { capturing: false }, url);
  }
  assert.deepEqual(await ask("https://seatgeek.com/jobs/apply"), { capturing: true });
});

test("a matched page on a broad site (LinkedIn jobs) doesn't make the rest of that site capturable", async () => {
  const tab = nextTab++;
  const d = deps();
  const ask = (url, matched = false, hasForm = true) => handleMessage({ type: "shouldCapture", matched, url, hasForm }, from(tab), d);
  assert.deepEqual(await ask("https://www.linkedin.com/jobs/view/123", true), { capturing: true });
  assert.deepEqual(await ask("https://www.linkedin.com/in/me/?isSelfProfile=true"), { capturing: false });
  assert.deepEqual(await ask("https://www.linkedin.com/feed/"), { capturing: false });
});

test("a tab opened from a posting tab joins its session (same site only)", async () => {
  const opener = nextTab++;
  const child = nextTab++;
  const d = deps({ openers: { [child]: opener } });
  await handleMessage({ type: "shouldCapture", matched: true, url: "https://careers.acme.com/jobs/1" }, from(opener), d);
  assert.deepEqual(
    await handleMessage({ type: "shouldCapture", matched: false, url: "https://careers.acme.com/apply", hasForm: true }, from(child), d),
    { capturing: true },
  );
  assert.equal((await findSessionForTab(child)).id, (await findSessionForTab(opener)).id);
  assert.deepEqual(
    await handleMessage({ type: "shouldCapture", matched: false, url: "https://news.example.com/", hasForm: true }, from(child), d),
    { capturing: false },
  );
});

test("uploads are cached on any page, but don't make the tab capture pages", async () => {
  const tab = nextTab++;
  const d = deps();
  const res = await handleMessage(
    {
      type: "upload",
      fieldKey: "drive.google.com/#upload",
      fieldLabel: "Upload",
      pageUrl: "https://drive.google.com/",
      files: [{ filename: "resume.pdf", mime: "application/pdf", size: 5, lastModified: 1, base64: b64("hello") }],
    },
    from(tab),
    d,
  );
  assert.deepEqual(res, { ok: true });
  const session = await findSessionForTab(tab);
  assert.equal(session.strong, false);
  const { uploads } = await getSessionData(session.id);
  assert.equal(uploads.length, 1);
  assert.equal(await uploads[0].blob.text(), "hello");
  assert.equal(uploads[0].blob.type, "application/pdf");
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: false }, from(tab), d), { capturing: false });
  assert.deepEqual(await handleMessage({ type: "answers", answers: [{ page_url: "u", field_key: "k", value: "v" }] }, from(tab), d), { ok: false });
});

test("answers are stored for strong sessions", async () => {
  const tab = nextTab++;
  const d = deps();
  await handleMessage({ type: "shouldCapture", matched: true }, from(tab), d);
  await handleMessage({ type: "answers", answers: [{ page_url: "u", field_key: "k", field_label: "Why", value: "v" }] }, from(tab), d);
  const { answers } = await getSessionData((await findSessionForTab(tab)).id);
  assert.equal(answers[0].value, "v");
});

test("malformed messages are ignored", async () => {
  const d = deps();
  assert.equal(await handleMessage(null, from(1), d), null);
  assert.equal(await handleMessage({ type: "nope" }, from(1), d), null);
  assert.deepEqual(await handleMessage({ type: "upload", fieldKey: "k", files: [] }, from(nextTab++), d), { ok: false });
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: true }, {}, d), { capturing: false });
  assert.deepEqual(await handleMessage({ type: "page", snapshot: snap("chrome://newtab") }, from(nextTab++), d), { ok: false });
});

test("check proxies to the server and swallows failures", async () => {
  const calls = [];
  const ok = deps({ api: async (path) => (calls.push(path), { applied: true, application: { id: 3 } }) });
  const res = await handleMessage({ type: "check", url: "https://x.com/j?a=1", jobId: "R1", company: "Acme" }, from(1), ok);
  assert.equal(res.applied, true);
  assert.equal(calls[0], "/applications/check?url=https%3A%2F%2Fx.com%2Fj%3Fa%3D1&job_id=R1&company=Acme");

  const down = deps({ api: async () => { throw new Error("down"); } });
  assert.equal(await handleMessage({ type: "check", url: "https://x.com" }, from(1), down), null);
  assert.equal(await handleMessage({ type: "check", url: "file:///x" }, from(1), ok), null);
});

test("openApplication only accepts integer ids", async () => {
  const opened = [];
  const d = deps({ opened });
  await handleMessage({ type: "openApplication", id: 4 }, from(1), d);
  await handleMessage({ type: "openApplication", id: "4; evil" }, from(1), d);
  assert.deepEqual(opened, [4]);
});

test("concurrent first messages from two frames create one session", async () => {
  const tab = nextTab++;
  const d = deps();
  await Promise.all([
    handleMessage({ type: "shouldCapture", matched: true }, from(tab), d),
    handleMessage({ type: "upload", fieldKey: "k", files: [{ filename: "a", base64: b64("a") }] }, from(tab), d),
    handleMessage({ type: "shouldCapture", matched: true }, from(tab), d),
  ]);
  const all = await new Promise((resolve) => {
    const r = indexedDB.open("application-logger");
    r.onsuccess = () => {
      const q = r.result.transaction("sessions").objectStore("sessions").index("tabIds").getAll(tab);
      q.onsuccess = () => resolve(q.result);
    };
  });
  assert.equal(all.length, 1);
});

test("withTabLock keeps running after a failure", async () => {
  const order = [];
  const a = withTabLock(1, async () => {
    order.push("a");
    throw new Error("x");
  });
  const b = withTabLock(1, async () => order.push("b"));
  await assert.rejects(a);
  await b;
  assert.deepEqual(order, ["a", "b"]);
});

// ---------------------------------------------------------------- one session per posting

const posting = (url, title, company) => ({ url, title: "", jsonld: { title, hiringOrganization: { name: company } } });
const matchedPosting = (tab, p, d) =>
  handleMessage({ type: "shouldCapture", matched: true, url: p.url, hasForm: true, posting: p }, from(tab), d);

test("moving on to another posting in the same tab starts a new session; going back resumes the old one", async () => {
  const tab = nextTab++;
  const d = deps();
  const x = posting("https://boards.greenhouse.io/acme/jobs/1", "Software Engineer", "Acme");
  const y = posting("https://ats.rippling.com/globex/jobs/2", "Data Scientist", "Globex");

  await matchedPosting(tab, x, d);
  await handleMessage({ type: "page", snapshot: snap(x.url, { jsonld: x.jsonld }), isPosting: true }, from(tab), d);
  const sx = await findSessionForTab(tab);

  await matchedPosting(tab, y, d);
  await handleMessage({ type: "page", snapshot: snap(y.url), isPosting: true }, from(tab), d);
  const sy = await findSessionForTab(tab);
  assert.notEqual(sy.id, sx.id);
  assert.deepEqual((await getSessionData(sy.id)).pages.map((p) => p.url), [y.url], "Y's log doesn't show X");
  assert.deepEqual((await getSessionData(sx.id)).pages.map((p) => p.url), [x.url], "X's capture is kept");

  // An apply step of Y stays in Y's session.
  await handleMessage({ type: "shouldCapture", matched: true, url: `${y.url}/apply`, hasForm: true }, from(tab), d);
  assert.equal((await findSessionForTab(tab)).id, sy.id);

  await matchedPosting(tab, x, d);
  assert.equal((await findSessionForTab(tab)).id, sx.id, "back to X resumes X's session");
});

test("a posting opened from a search tab gets its own session; the same job on its ATS joins", async () => {
  const search = nextTab++;
  const other = nextTab++;
  const same = nextTab++;
  const d = deps({ openers: { [other]: search, [same]: search } });
  const listing = posting("https://www.linkedin.com/jobs/search/?currentJobId=1", "Software Engineer", "Acme");
  await matchedPosting(search, listing, d);
  const s = await findSessionForTab(search);

  await linkTab(other, search); // what tabs.onCreated does
  await matchedPosting(other, posting("https://jobs.lever.co/globex/9", "Data Scientist", "Globex"), d);
  assert.notEqual((await findSessionForTab(other)).id, s.id);
  assert.ok(!(await getSession(s.id)).tabIds.includes(other), "left the search tab's session");

  await linkTab(same, search);
  await matchedPosting(same, posting("https://boards.greenhouse.io/acme/jobs/55", "Software Engineer", "Acme"), d);
  assert.equal((await findSessionForTab(same)).id, s.id);
});
