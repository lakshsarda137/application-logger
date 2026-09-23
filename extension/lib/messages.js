// Service-worker side of the content-script protocol. Kept free of direct
// chrome.* calls (they come in through `deps`) so it can be tested in Node.
//
// Messages (all from content.js, sender.tab.id identifies the tab):
//   shouldCapture {matched, url, hasForm}   -> {capturing}
//   page          {snapshot, isPosting}     -> {ok}
//   answers       {answers}                 -> {ok}
//   upload        {fieldKey, fieldLabel, pageUrl, files: [{..., base64}]} -> {ok}
//   check         {url, jobId, company}     -> server's /applications/check result, or null
//   openApplication {id}                    -> opens the dashboard page

import { BROAD_SITES, siteOf } from "./sites.js";
import {
  ensureSession,
  findSessionForTab,
  putAnswers,
  putPage,
  putUploads,
} from "./sessions.js";

export function base64ToBlob(b64, mime) {
  const bin = atob(b64 || "");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

export function toStoredFiles(files) {
  return (files || []).map((f) => ({
    filename: f.filename,
    mime: f.mime,
    size: f.size,
    lastModified: f.lastModified,
    blob: base64ToBlob(f.base64, f.mime),
  }));
}

const isHttp = (url) => /^https?:/i.test(url || "");

// Messages from one tab are handled one at a time so two frames can't both
// create a session for the same tab.
const tabQueues = new Map();
export function withTabLock(tabId, fn) {
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.then(() => {
    if (tabQueues.get(tabId) === tail) tabQueues.delete(tabId);
  });
  return next;
}

/**
 * deps: {
 *   openerOf(tabId) -> Promise<number|null>,
 *   api(path) -> Promise<json>,
 *   openApplication(id) -> Promise,
 *   now() -> ms (optional)
 * }
 */
export async function handleMessage(msg, sender, deps) {
  const tabId = sender?.tab?.id;
  const now = deps.now ? deps.now() : Date.now();
  if (!msg || typeof msg.type !== "string") return null;

  switch (msg.type) {
    case "shouldCapture":
      return withTabLock(tabId, async () => {
        if (tabId == null) return { capturing: false };
        const site = siteOf(msg.url || sender?.url || "");
        if (msg.matched) {
          const extendTo = BROAD_SITES.has(site) ? "" : site;
          await ensureSession(tabId, { strong: true, openerTabId: await deps.openerOf(tabId), site: extendTo }, now);
          return { capturing: true };
        }
        let session = await findSessionForTab(tabId, now);
        if (!session) {
          // A tab opened from a session tab joins it (rule 4 via openerTabId).
          const opener = await deps.openerOf(tabId);
          const openerSession = opener == null ? null : await findSessionForTab(opener, now);
          if (openerSession) session = await ensureSession(tabId, { openerTabId: opener }, now);
        }
        // Rule 4: an unmatched page is captured only if it's a later step of the
        // application: on a site where a matched page of this session lives
        // (e.g. careers.acme.com/apply/2) AND it has a form to fill in.
        const onSessionSite = Boolean(site) && (session?.sites || []).includes(site);
        return { capturing: Boolean(session && session.strong && onSessionSite && msg.hasForm) };
      });

    case "page":
      return withTabLock(tabId, async () => {
        const snap = msg.snapshot;
        if (tabId == null || !snap || !isHttp(snap.url)) return { ok: false };
        const session = await findSessionForTab(tabId, now);
        if (!session || !session.strong) return { ok: false };
        await putPage(session.id, { ...snap, isPosting: msg.isPosting }, now);
        return { ok: true };
      });

    case "answers":
      return withTabLock(tabId, async () => {
        const session = await findSessionForTab(tabId, now);
        if (!session || !session.strong || !Array.isArray(msg.answers)) return { ok: false };
        await putAnswers(session.id, msg.answers, now);
        return { ok: true };
      });

    case "upload":
      return withTabLock(tabId, async () => {
        if (tabId == null || !msg.fieldKey || !Array.isArray(msg.files) || !msg.files.length) return { ok: false };
        // Uploads are always kept, even on pages that aren't job postings.
        const session = await ensureSession(tabId, { openerTabId: await deps.openerOf(tabId) }, now);
        await putUploads(
          session.id,
          { fieldKey: msg.fieldKey, fieldLabel: msg.fieldLabel || "", pageUrl: msg.pageUrl || "" },
          toStoredFiles(msg.files),
          now,
        );
        return { ok: true };
      });

    case "check": {
      if (!isHttp(msg.url)) return null;
      const params = new URLSearchParams({ url: msg.url });
      if (msg.jobId) params.set("job_id", msg.jobId);
      if (msg.company) params.set("company", msg.company);
      try {
        return await deps.api(`/applications/check?${params}`);
      } catch (e) {
        return null; // server down or no token yet: just no toast
      }
    }

    case "openApplication":
      if (Number.isInteger(msg.id)) await deps.openApplication(msg.id);
      return { ok: true };

    default:
      return null;
  }
}
