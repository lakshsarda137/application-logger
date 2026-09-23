import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { test } from "node:test";

import { handleMessage, withTabLock } from "../lib/messages.js";
import { findSessionForTab, getSessionData } from "../lib/sessions.js";

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

test("matched page starts a strong session; later unmatched pages in the tab are captured (rule 4)", async () => {
  const tab = nextTab++;
  const d = deps();
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: true }, from(tab), d), { capturing: true });
  await handleMessage({ type: "page", snapshot: snap("https://jobs.lever.co/acme/1"), isPosting: true }, from(tab), d);
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: false }, from(tab), d), { capturing: true });
  await handleMessage({ type: "page", snapshot: snap("https://acme.com/apply/step2") }, from(tab), d);
  const { pages } = await getSessionData((await findSessionForTab(tab)).id);
  assert.deepEqual(pages.map((p) => [p.url, p.isPosting]).sort(), [
    ["https://acme.com/apply/step2", false],
    ["https://jobs.lever.co/acme/1", true],
  ]);
});

test("a tab opened from a posting tab joins its session", async () => {
  const opener = nextTab++;
  const child = nextTab++;
  const d = deps({ openers: { [child]: opener } });
  await handleMessage({ type: "shouldCapture", matched: true }, from(opener), d);
  assert.deepEqual(await handleMessage({ type: "shouldCapture", matched: false }, from(child), d), { capturing: true });
  assert.equal((await findSessionForTab(child)).id, (await findSessionForTab(opener)).id);
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
