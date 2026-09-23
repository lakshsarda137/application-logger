// Shared helpers for the dashboard pages. Auth is the HttpOnly cookie the
// server set when it served the page; mutating calls add X-Requested-With.
// The page CSP forbids inline scripts/styles, so everything is built with
// el()/icon() and styled through classes in dashboard.css.

export async function api(path, { method = "GET", json } = {}) {
  const headers = { "X-Requested-With": "dashboard" };
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    const message = typeof detail === "string" ? detail : Array.isArray(detail) ? detail.map((d) => d.msg).join("; ") : "";
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return data;
}

/** el("a", { href: "/", className: "x" }, "text", childNode) — never parses HTML. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ------------------------------------------------------------------ icons

// 24x24 stroke icons (Feather-style). One path per icon; subpaths allowed.
const ICONS = {
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4.2-4.2",
  settings:
    "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  resume: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8",
  letter: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14L21 3",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  more: "M5 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z M12 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z M19 10.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8z",
  back: "M15 18l-6-6 6-6",
  close: "M18 6L6 18 M6 6l12 12",
  clock: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2",
  pin: "M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z M12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  money: "M12 1v22 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  briefcase: "M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2 M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
  check: "M20 6L9 17l-5-5",
};

/** Inline SVG icon (el() can't create SVG: it needs createElementNS). */
export function icon(name, size = "") {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon ${size}`.trim());
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.append(path);
  return svg;
}

// ------------------------------------------------------------------ small components

/** Initials badge with a stable tint per company (classes mono-0..7). */
export function monogram(company, size = "") {
  const words = (company || "?").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?")[0]).toUpperCase();
  let hash = 0;
  for (const ch of (company || "").toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return el("span", { className: `mono mono-${hash % 8} ${size}`.trim(), "aria-hidden": "true" }, initials);
}

export function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "Today", "Yesterday", "3d ago", "Sep 12", "Sep 12, 2025" (calendar days, local time). */
export function relativeLabel(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days}d ago`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

export function relativeDate(iso, className = "") {
  return el("time", { dateTime: iso || "", title: formatDateTime(iso), className }, relativeLabel(iso));
}

export function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "/Users/me/Desktop/Professional/Sophomore/October/x" -> "~/…/October/x" */
export function shortPath(p, max = 40) {
  if (!p) return "";
  const home = p.replace(/^\/(Users|home)\/[^/]+/, "~");
  if (home.length <= max) return home;
  const parts = home.split("/");
  return `${parts[0] || ""}/…/${parts.slice(-2).join("/")}`;
}

/** "https://ats.rippling.com/rippling/jobs/abc/apply?x" -> "ats.rippling.com › jobs › abc › apply" */
export function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.length > 3 ? ["…", ...parts.slice(-2)] : parts;
    return [u.hostname.replace(/^www\./, ""), ...tail].join(" › ");
  } catch {
    return url || "";
  }
}

const PLATFORM_NAMES = {
  icims: "iCIMS",
  bamboohr: "BambooHR",
  smartrecruiters: "SmartRecruiters",
  successfactors: "SuccessFactors",
  jazzhr: "JazzHR",
  linkedin: "LinkedIn",
};
export function platformName(p) {
  if (!p) return "";
  return PLATFORM_NAMES[p] || p.charAt(0).toUpperCase() + p.slice(1);
}

/** "USD 45–55 per hour" -> "$45–55/hr"; anything unusual is returned as-is. */
export function shortSalary(s) {
  const m = (s || "").match(/^USD\s+([\d.,]+(?:–[\d.,]+)?)(?:\s+per\s+(hour|year|month|week|day))?$/i);
  if (!m) return s || "";
  const unit = { hour: "/hr", year: "/yr", month: "/mo", week: "/wk", day: "/day" }[(m[2] || "").toLowerCase()] || "";
  return `$${m[1]}${unit}`;
}

/** Search snippets mark matches with \x02…\x03; turn them into <mark> safely. */
export function markedText(snippet) {
  const frag = document.createDocumentFragment();
  for (const part of (snippet || "").split(/(\x02[^\x03]*\x03)/)) {
    if (part.startsWith("\x02")) frag.append(el("mark", {}, part.slice(1, -1)));
    else if (part) frag.append(part);
  }
  return frag;
}

export function emptyState(iconName, title, text, action) {
  return el(
    "div",
    { className: "empty" },
    icon(iconName, "lg"),
    el("div", { className: "title" }, title),
    text ? el("p", {}, text) : null,
    action || null,
  );
}

// ------------------------------------------------------------------ feedback

export function banner(container, message, kind = "error") {
  container.replaceChildren(el("div", { className: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, message));
}

let toastHost = null;
export function toast(message, kind = "") {
  if (!toastHost) {
    toastHost = el("div", { className: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = el("div", { className: `toast ${kind}`.trim() }, kind === "error" ? null : icon("check", "sm"), message);
  toastHost.append(t);
  setTimeout(() => t.remove(), 3500);
}

/** A message to show on the next page (e.g. after delete redirects home). */
export function flash(message) {
  try {
    sessionStorage.setItem("al-flash", message);
  } catch {}
}
export function showFlash() {
  try {
    const message = sessionStorage.getItem("al-flash");
    if (message) {
      sessionStorage.removeItem("al-flash");
      toast(message);
    }
  } catch {}
}

export async function copyText(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast("Couldn't copy", "error");
  }
}

// ------------------------------------------------------------------ keyboard

const isTyping = (t) =>
  t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** "/" focuses the page's search field (unless you're typing somewhere). */
export function slashToSearch(input) {
  if (!input) return;
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target)) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

/** Fill the shared top-bar icons (gear, search glyph) declared in the HTML. */
export function initTopbar() {
  for (const slot of document.querySelectorAll("[data-icon]")) {
    slot.prepend(icon(slot.dataset.icon, slot.dataset.iconSize || ""));
  }
  slashToSearch(document.querySelector("[data-search]"));
}
