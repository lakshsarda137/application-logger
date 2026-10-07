// Service worker.
//
// - Receives page snapshots, uploads and answers from content.js and keeps
//   them in 24h capture sessions (lib/sessions.js, lib/messages.js).
// - Links tabs opened from a session tab into the same session.
// - "Log entire application": snapshots the tab one last time, merges it into
//   the session and opens the log dialog on it.
// - Answers the "applied here?" check for the toast.

import { api, getConnection } from "./lib/api.js";
import { handleMessage, toStoredFiles, withTabLock } from "./lib/messages.js";
import { postingIdentity } from "./lib/postings.js";
import { siteOf } from "./lib/sites.js";
import {
  clearAllTabLinks,
  ensureSession,
  linkTab,
  pruneExpired,
  putAnswers,
  putPage,
  putUploads,
  unlinkTab,
} from "./lib/sessions.js";

const MENU_ID = "log-application";

// Mirrors AppLogger.NEVER_CAPTURE in lib/ats-domains.js (a classic script the worker can't import).
const NEVER_CAPTURE = /(^|\.)(mail|docs|drive|calendar|meet|chat|contacts|accounts|keep)\.google\.com$|(^|\.)(outlook\.live\.com|outlook\.office(365)?\.com|slack\.com|web\.whatsapp\.com|instagram\.com|facebook\.com|messenger\.com|x\.com|twitter\.com|reddit\.com|youtube\.com|claude\.ai|chatgpt\.com|notion\.so)$/;
function isNeverCapture(url) {
  try {
    return NEVER_CAPTURE.test(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}
const CAPTURE_FILES = ["lib/ats-domains.js", "lib/posting-keywords.js", "lib/capture.js"];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Log entire application",
      contexts: ["page", "frame", "selection", "link", "editable", "image"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
  chrome.alarms.create("prune", { periodInMinutes: 30 });
  prune();
  refreshResumeName();
  injectIntoOpenTabs();
});

// Chrome only runs manifest content scripts on pages loaded *after* install or
// reload, so tabs that were already open would capture nothing. Inject now.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(tab.url || "")) continue;
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, files: ["lib/main-world-hook.js"], world: "MAIN" })
      .catch(() => {});
    chrome.scripting.executeScript({ target, files: [...CAPTURE_FILES, "content.js"] }).catch(() => {});
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await clearAllTabLinks().catch((e) => console.warn("[app-logger] clear links failed", e));
  prune();
  refreshResumeName();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "prune") {
    prune();
    refreshResumeName();
  }
});

// config.local.json resume_name, cached for content scripts and the log dialog
// (they rename every resume to it). Keeps the last value while the server is down.
async function refreshResumeName() {
  try {
    const settings = await api("/settings");
    await chrome.storage.local.set({ resumeName: settings.resume_name || "" });
  } catch (e) {
    // Server not running or no token yet; try again on the next alarm.
  }
}

function prune() {
  pruneExpired().catch((e) => console.warn("[app-logger] prune failed", e));
}

// ---------------------------------------------------------------- tab linking

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null) linkTab(tab.id, tab.openerTabId).catch(() => {});
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  linkTab(d.tabId, d.sourceTabId).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  unlinkTab(tabId).catch(() => {});
});

async function openerOf(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).openerTabId ?? null;
  } catch {
    return null;
  }
}

async function openApplication(id) {
  const { serverUrl } = await getConnection();
  await chrome.tabs.create({ url: `${serverUrl}/app.html?id=${id}` });
}

// ---------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender, { openerOf, api, openApplication }).then(sendResponse, (e) => {
    console.warn("[app-logger]", msg?.type, e);
    sendResponse(null);
  });
  return true; // async response
});

// ---------------------------------------------------------------- action + menu

chrome.action.onClicked.addListener(async () => {
  const { serverUrl } = await getConnection();
  chrome.tabs.create({ url: `${serverUrl}/` });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id != null) {
    logApplication(tab).catch((e) => console.error("[app-logger] log failed", e));
  }
});

async function snapshotTab(tabId) {
  // Pages opened before the extension was installed/reloaded have no content
  // script, so (re)inject the capture library first. It's idempotent.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: CAPTURE_FILES });
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => globalThis.AppLogger.capture.snapshot({ files: true }),
  });
  return results.filter((r) => r.result).map((r) => r.result);
}

async function logApplication(tab) {
  const errors = [];
  let frames = [];
  try {
    frames = await snapshotTab(tab.id);
  } catch (e) {
    errors.push(`Could not read the page: ${e.message}`);
  }

  // If the page being logged is a job posting, the session must be that job's
  // (not an earlier job browsed in this tab or the tab that opened it).
  const top = frames.find((f) => f.isTop);
  const loggedUrl = top?.url || tab.url || "";
  const posting =
    top && (top.signals.jsonld || top.signals.keywords)
      ? postingIdentity({ url: top.url, title: top.title, jsonld: top.jsonld })
      : null;

  const session = await withTabLock(tab.id, async () => {
    const s = await ensureSession(tab.id, {
      strong: true,
      openerTabId: tab.openerTabId ?? null,
      site: siteOf(tab.url),
      posting,
    });
    for (const f of frames) {
      if (/^https?:/i.test(f.url) && !isNeverCapture(f.url)) {
        const isPosting = f.signals.jsonld || f.signals.keywords;
        if (f.isTop || f.text.trim().length >= 20) await putPage(s.id, { ...f, isPosting });
      }
      if (f.answers.length) await putAnswers(s.id, f.answers);
      for (const group of f.files) {
        await putUploads(s.id, group, toStoredFiles(group.files));
      }
    }
    if (!frames.length && /^https?:/i.test(tab.url || "")) {
      await putPage(s.id, { url: tab.url, title: tab.title || "", text: "", isTop: true });
    }
    return s;
  });

  // A tab right next to the job page (same window); it closes itself after saving
  // and switches back to `tab`.
  const params = new URLSearchParams({ session: session.id, tab: String(tab.id), url: loggedUrl });
  if (errors.length) params.set("warn", errors.join(" "));
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`log-dialog.html?${params}`),
    windowId: tab.windowId,
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}
