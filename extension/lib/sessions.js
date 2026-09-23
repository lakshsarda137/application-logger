// Capture sessions (README §4.1), stored in IndexedDB.
//
// A session belongs to a tab, plus any tab that tab opens ("Apply" opening
// Workday in a new tab). It holds page snapshots, uploaded files and form
// answers, and expires 24h after its last activity. Nothing here reaches the
// server until the user logs the application.
//
// A session is "strong" once any of its pages matched the job-posting rules
// (ATS domain, keywords, JSON-LD) or the user logged from it. Only strong
// sessions make later, unmatched pages get captured (rule 4), and only on the
// sites (`sites`) of pages that matched, so wandering off to Gmail or LinkedIn
// in the same tab isn't captured. An upload on an unrelated site still gets
// cached (in a weak session) so it's never lost, but it doesn't start
// snapshotting that tab.

import { ANSWERS, PAGES, req, SESSIONS, transact, UPLOADS } from "./idb.js";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_PAGES_PER_SESSION = 200;

const isActive = (s, now) => Boolean(s) && now - s.lastActivity < SESSION_TTL_MS;

async function activeForTab(stores, tabId, now) {
  if (tabId == null) return null;
  const list = await req(stores[SESSIONS].index("tabIds").getAll(tabId));
  return list.filter((s) => isActive(s, now)).sort((a, b) => b.lastActivity - a.lastActivity)[0] || null;
}

async function touch(stores, sessionId, now) {
  const s = await req(stores[SESSIONS].get(sessionId));
  if (!s) throw new Error(`Session ${sessionId} not found`);
  s.lastActivity = now;
  await req(stores[SESSIONS].put(s));
  return s;
}

export function findSessionForTab(tabId, now = Date.now()) {
  return transact(SESSIONS, "readonly", (st) => activeForTab(st, tabId, now));
}

export function getSession(sessionId) {
  return transact(SESSIONS, "readonly", (st) => req(st[SESSIONS].get(sessionId)));
}

/**
 * The tab's active session, else its opener's (the tab joins it), else a new one.
 * `strong: true` upgrades the session; it never downgrades.
 */
export function ensureSession(tabId, { strong = false, openerTabId = null, site = "" } = {}, now = Date.now()) {
  return transact(SESSIONS, "readwrite", async (st) => {
    let s = await activeForTab(st, tabId, now);
    if (!s && openerTabId != null && openerTabId !== tabId) {
      s = await activeForTab(st, openerTabId, now);
      if (s) s.tabIds = [...new Set([...s.tabIds, tabId])];
    }
    if (!s) {
      s = { id: crypto.randomUUID(), tabIds: [tabId], createdAt: now, lastActivity: now, strong: false, sites: [] };
    }
    s.lastActivity = now;
    if (strong) s.strong = true;
    // Sites of pages that matched rules 1–3; rule 4 only extends to these.
    s.sites = s.sites || [];
    if (site && !s.sites.includes(site)) s.sites.push(site);
    await req(st[SESSIONS].put(s));
    return s;
  });
}

/** A tab opened from `openerTabId` joins the opener's session (if it has one). */
export function linkTab(tabId, openerTabId, now = Date.now()) {
  return transact(SESSIONS, "readwrite", async (st) => {
    if (await activeForTab(st, tabId, now)) return null;
    const s = await activeForTab(st, openerTabId, now);
    if (!s) return null;
    s.tabIds = [...new Set([...s.tabIds, tabId])];
    await req(st[SESSIONS].put(s));
    return s;
  });
}

/** Called when a tab closes. The session and its data stay until they expire. */
export function unlinkTab(tabId) {
  return transact(SESSIONS, "readwrite", async (st) => {
    for (const s of await req(st[SESSIONS].index("tabIds").getAll(tabId))) {
      s.tabIds = s.tabIds.filter((t) => t !== tabId);
      await req(st[SESSIONS].put(s));
    }
  });
}

/** Tab IDs restart after a browser restart, so old links must not match new tabs. */
export function clearAllTabLinks() {
  return transact(SESSIONS, "readwrite", async (st) => {
    for (const s of await req(st[SESSIONS].getAll())) {
      if (s.tabIds.length) {
        s.tabIds = [];
        await req(st[SESSIONS].put(s));
      }
    }
  });
}

/** Insert or update a page snapshot (one row per session + URL). */
export function putPage(sessionId, page, now = Date.now()) {
  return transact([SESSIONS, PAGES], "readwrite", async (st) => {
    await touch(st, sessionId, now);
    const existing = await req(st[PAGES].index("sessionUrl").get([sessionId, page.url]));
    if (!existing) {
      const count = await req(st[PAGES].index("sessionId").count(sessionId));
      if (count >= MAX_PAGES_PER_SESSION) return null;
    }
    const row = {
      ...(existing || {}),
      sessionId,
      url: page.url,
      title: page.title || "",
      text: page.text || "",
      // Keep the richest HTML/JSON-LD seen for this URL.
      html: page.html || existing?.html || "",
      jsonld: page.jsonld || existing?.jsonld || null,
      isTop: Boolean(page.isTop),
      isPosting: Boolean(page.isPosting || existing?.isPosting),
      capturedAt: page.capturedAt || new Date(now).toISOString(),
      updatedAt: now,
    };
    return req(st[PAGES].put(row));
  });
}

/**
 * Store files from one upload field. A new upload into the same field replaces
 * the old one (README §4.2). files: [{ filename, mime, size, lastModified, blob }]
 */
export function putUploads(sessionId, { fieldKey, fieldLabel = "", pageUrl = "" }, files, now = Date.now()) {
  return transact([SESSIONS, UPLOADS], "readwrite", async (st) => {
    await touch(st, sessionId, now);
    const oldKeys = await req(st[UPLOADS].index("sessionField").getAllKeys([sessionId, fieldKey]));
    for (const key of oldKeys) await req(st[UPLOADS].delete(key));
    const ids = [];
    for (const f of files) {
      ids.push(
        await req(
          st[UPLOADS].add({
            sessionId,
            fieldKey,
            fieldLabel,
            pageUrl,
            filename: f.filename,
            mime: f.mime || "",
            size: f.size ?? f.blob?.size ?? 0,
            lastModified: f.lastModified ?? null,
            blob: f.blob,
            capturedAt: now,
          }),
        ),
      );
    }
    return ids;
  });
}

/** Upsert answers keyed by page + field. An emptied field deletes its answer. */
export function putAnswers(sessionId, answers, now = Date.now()) {
  return transact([SESSIONS, ANSWERS], "readwrite", async (st) => {
    await touch(st, sessionId, now);
    for (const a of answers) {
      const key = `${sessionId}|${a.page_url}|${a.field_key || a.field_name || a.field_label}`;
      if (!String(a.value ?? "").trim()) {
        await req(st[ANSWERS].delete(key));
        continue;
      }
      await req(
        st[ANSWERS].put({
          key,
          sessionId,
          page_url: a.page_url || "",
          field_key: a.field_key || "",
          field_label: a.field_label || "",
          field_name: a.field_name || "",
          value: String(a.value),
          updatedAt: now,
        }),
      );
    }
  });
}

export function getSessionData(sessionId) {
  return transact([SESSIONS, PAGES, UPLOADS, ANSWERS], "readonly", async (st) => {
    const session = await req(st[SESSIONS].get(sessionId));
    if (!session) return null;
    return {
      session,
      pages: await req(st[PAGES].index("sessionId").getAll(sessionId)),
      uploads: await req(st[UPLOADS].index("sessionId").getAll(sessionId)),
      answers: await req(st[ANSWERS].index("sessionId").getAll(sessionId)),
    };
  });
}

async function deleteIn(st, sessionId) {
  for (const name of [PAGES, UPLOADS, ANSWERS]) {
    for (const key of await req(st[name].index("sessionId").getAllKeys(sessionId))) {
      await req(st[name].delete(key));
    }
  }
  await req(st[SESSIONS].delete(sessionId));
}

export function deleteSession(sessionId) {
  return transact([SESSIONS, PAGES, UPLOADS, ANSWERS], "readwrite", (st) => deleteIn(st, sessionId));
}

/** Delete sessions idle for 24h, with everything they hold. Returns how many. */
export function pruneExpired(now = Date.now()) {
  return transact([SESSIONS, PAGES, UPLOADS, ANSWERS], "readwrite", async (st) => {
    const stale = await req(
      st[SESSIONS].index("lastActivity").getAll(IDBKeyRange.upperBound(now - SESSION_TTL_MS)),
    );
    for (const s of stale) await deleteIn(st, s.id);
    return stale.length;
  });
}

/** Uploads from other live sessions, newest first (the dialog's "other recent uploads"). */
export function recentUploads({ excludeSessionId = null, now = Date.now() } = {}) {
  return transact([SESSIONS, UPLOADS], "readonly", async (st) => {
    const uploads = await req(
      st[UPLOADS].index("capturedAt").getAll(IDBKeyRange.lowerBound(now - SESSION_TTL_MS)),
    );
    const out = [];
    for (const u of uploads) {
      if (u.sessionId === excludeSessionId) continue;
      if (isActive(await req(st[SESSIONS].get(u.sessionId)), now)) out.push(u);
    }
    return out.sort((a, b) => b.capturedAt - a.capturedAt);
  });
}
