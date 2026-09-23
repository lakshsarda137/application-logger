import "fake-indexeddb/auto";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clearAllTabLinks,
  deleteSession,
  ensureSession,
  findSessionForTab,
  getSessionData,
  linkTab,
  MAX_PAGES_PER_SESSION,
  pruneExpired,
  putAnswers,
  putPage,
  putUploads,
  recentUploads,
  SESSION_TTL_MS,
  unlinkTab,
} from "../lib/sessions.js";

let nextTab = 1000;
const newTab = () => nextTab++;
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const file = (name, content = name) => ({
  filename: name,
  mime: "application/pdf",
  size: content.length,
  lastModified: 1,
  blob: new Blob([content]),
});

test("a tab gets one session; strong only ever upgrades", async () => {
  const tab = newTab();
  assert.equal(await findSessionForTab(tab, T0), null);
  const a = await ensureSession(tab, {}, T0);
  assert.equal(a.strong, false);
  const b = await ensureSession(tab, { strong: true }, T0 + 1);
  assert.equal(b.id, a.id);
  assert.equal(b.strong, true);
  const c = await ensureSession(tab, { strong: false }, T0 + 2);
  assert.equal(c.strong, true);
  assert.equal((await findSessionForTab(tab, T0 + 3)).lastActivity, T0 + 2);
});

test("a tab opened from a session tab joins that session", async () => {
  const opener = newTab();
  const child = newTab();
  const s = await ensureSession(opener, { strong: true }, T0);
  assert.equal((await linkTab(child, opener, T0 + 1)).id, s.id);
  assert.equal((await findSessionForTab(child, T0 + 2)).id, s.id);

  // Via ensureSession's openerTabId fallback, too.
  const other = newTab();
  const joined = await ensureSession(other, { openerTabId: opener }, T0 + 3);
  assert.equal(joined.id, s.id);
  assert.deepEqual(joined.tabIds.sort(), [opener, child, other].sort());
});

test("linkTab does nothing when the opener has no session or the tab has one", async () => {
  const lone = newTab();
  assert.equal(await linkTab(newTab(), lone, T0), null);
  const a = newTab();
  const b = newTab();
  const sa = await ensureSession(a, {}, T0);
  const sb = await ensureSession(b, {}, T0);
  assert.equal(await linkTab(b, a, T0), null);
  assert.equal((await findSessionForTab(b, T0)).id, sb.id);
  assert.notEqual(sa.id, sb.id);
});

test("sessions expire 24h after last activity", async () => {
  const tab = newTab();
  const s = await ensureSession(tab, { strong: true }, T0);
  await putPage(s.id, { url: "https://x.com/1", text: "t" }, T0 + 10 * HOUR); // activity extends it
  assert.ok(await findSessionForTab(tab, T0 + 10 * HOUR + SESSION_TTL_MS - 1));
  assert.equal(await findSessionForTab(tab, T0 + 10 * HOUR + SESSION_TTL_MS), null);
  // An expired session is replaced by a fresh one.
  const fresh = await ensureSession(tab, {}, T0 + 40 * HOUR);
  assert.notEqual(fresh.id, s.id);
  assert.equal(fresh.strong, false);
});

test("pages upsert by URL and keep the richest HTML/JSON-LD", async () => {
  const s = await ensureSession(newTab(), { strong: true }, T0);
  await putPage(s.id, { url: "https://x.com/job", title: "v1", html: "<html>1</html>", jsonld: { title: "SWE" }, isTop: true, isPosting: true }, T0);
  await putPage(s.id, { url: "https://x.com/job", title: "v2", html: "", jsonld: null, isTop: true }, T0 + 1);
  await putPage(s.id, { url: "https://x.com/apply", title: "apply", isTop: true }, T0 + 2);
  const { pages } = await getSessionData(s.id);
  assert.equal(pages.length, 2);
  const job = pages.find((p) => p.url === "https://x.com/job");
  assert.equal(job.title, "v2");
  assert.equal(job.html, "<html>1</html>");
  assert.deepEqual(job.jsonld, { title: "SWE" });
  assert.equal(job.isPosting, true);
});

test("page count per session is capped", async () => {
  const s = await ensureSession(newTab(), { strong: true }, T0);
  for (let i = 0; i < MAX_PAGES_PER_SESSION + 5; i++) await putPage(s.id, { url: `https://x.com/${i}` }, T0);
  assert.equal((await getSessionData(s.id)).pages.length, MAX_PAGES_PER_SESSION);
});

test("a new upload into the same field replaces the old one; other fields are kept", async () => {
  const s = await ensureSession(newTab(), {}, T0);
  await putUploads(s.id, { fieldKey: "p#resume", fieldLabel: "Resume" }, [file("old.pdf")], T0);
  await putUploads(s.id, { fieldKey: "p#cover" }, [file("cover.pdf")], T0 + 1);
  await putUploads(s.id, { fieldKey: "p#resume", fieldLabel: "Resume", pageUrl: "https://x" }, [file("new.pdf", "newer")], T0 + 2);
  const { uploads } = await getSessionData(s.id);
  assert.deepEqual(uploads.map((u) => u.filename).sort(), ["cover.pdf", "new.pdf"]);
  const resume = uploads.find((u) => u.filename === "new.pdf");
  assert.equal(await resume.blob.text(), "newer");
  assert.equal(resume.fieldLabel, "Resume");
  assert.equal(resume.pageUrl, "https://x");
  assert.equal(resume.capturedAt, T0 + 2);
});

test("answers upsert per page+field and clearing a field deletes it", async () => {
  const s = await ensureSession(newTab(), { strong: true }, T0);
  const a = { page_url: "https://x/1", field_key: "k1", field_label: "Why?", field_name: "why", value: "v1" };
  await putAnswers(s.id, [a, { ...a, field_key: "k2", field_label: "City", value: "NYC" }], T0);
  await putAnswers(s.id, [{ ...a, value: "v2" }], T0 + 1);
  await putAnswers(s.id, [{ ...a, field_key: "k2", value: "  " }], T0 + 2);
  await putAnswers(s.id, [{ ...a, page_url: "https://x/2" }], T0 + 3);
  const { answers } = await getSessionData(s.id);
  assert.deepEqual(
    answers.map((x) => [x.page_url, x.field_key, x.value]).sort(),
    [["https://x/1", "k1", "v2"], ["https://x/2", "k1", "v1"]],
  );
});

test("deleteSession removes everything the session holds", async () => {
  const s = await ensureSession(newTab(), { strong: true }, T0);
  const keep = await ensureSession(newTab(), { strong: true }, T0);
  for (const id of [s.id, keep.id]) {
    await putPage(id, { url: "https://x/1" }, T0);
    await putUploads(id, { fieldKey: "f" }, [file("a.pdf")], T0);
    await putAnswers(id, [{ page_url: "u", field_key: "k", value: "v" }], T0);
  }
  await deleteSession(s.id);
  assert.equal(await getSessionData(s.id), null);
  const kept = await getSessionData(keep.id);
  assert.equal(kept.pages.length + kept.uploads.length + kept.answers.length, 3);
});

test("pruneExpired deletes idle sessions and their data only", async () => {
  const old = await ensureSession(newTab(), {}, T0);
  await putUploads(old.id, { fieldKey: "f" }, [file("old.pdf")], T0);
  const live = await ensureSession(newTab(), {}, T0 + 20 * HOUR);
  const removed = await pruneExpired(T0 + SESSION_TTL_MS + 1);
  assert.ok(removed >= 1);
  assert.equal(await getSessionData(old.id), null);
  assert.ok(await getSessionData(live.id));
});

test("recentUploads lists other live sessions' files, newest first", async () => {
  const now = T0 + 100 * HOUR;
  const mine = await ensureSession(newTab(), {}, now);
  const other = await ensureSession(newTab(), {}, now);
  await putUploads(mine.id, { fieldKey: "f" }, [file("mine.pdf")], now);
  await putUploads(other.id, { fieldKey: "a" }, [file("first.pdf")], now + 1);
  await putUploads(other.id, { fieldKey: "b" }, [file("second.pdf")], now + 2);
  const recent = await recentUploads({ excludeSessionId: mine.id, now: now + 3 });
  const names = recent.map((u) => u.filename);
  assert.deepEqual(names.slice(0, 2), ["second.pdf", "first.pdf"]);
  assert.ok(!names.includes("mine.pdf"));
  assert.equal(await recent[0].blob.text(), "second.pdf");
});

test("unlinkTab and clearAllTabLinks detach tabs but keep data", async () => {
  const tab = newTab();
  const s = await ensureSession(tab, { strong: true }, T0);
  await putUploads(s.id, { fieldKey: "f" }, [file("a.pdf")], T0);
  await unlinkTab(tab);
  assert.equal(await findSessionForTab(tab, T0), null);
  assert.equal((await getSessionData(s.id)).uploads.length, 1);

  const tab2 = newTab();
  await ensureSession(tab2, {}, T0);
  await clearAllTabLinks();
  assert.equal(await findSessionForTab(tab2, T0), null);
});

test("writing to a missing session fails without partial writes", async () => {
  await assert.rejects(putPage("nope", { url: "https://x" }, T0), /not found/);
  await assert.rejects(putUploads("nope", { fieldKey: "f" }, [file("a.pdf")], T0), /not found/);
});
