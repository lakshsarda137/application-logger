import { api, banner, el, emptyState, icon, initTopbar, markedText, monogram, relativeDate, showFlash } from "./common.js";

const $ = (id) => document.getElementById(id);
const input = $("q");

initTopbar();
showFlash();
input.value = new URLSearchParams(location.search).get("q") || "";

let latest = 0;
let timer = null;
let active = -1; // keyboard-highlighted row

// ------------------------------------------------------------------ rows

function docIcon(name, doc, label) {
  if (!doc) {
    return el("span", { className: "icon-link missing", title: `No ${label.toLowerCase()}`, "aria-label": `No ${label.toLowerCase()}` }, icon(name));
  }
  return el(
    "a",
    { className: "icon-link", href: `/documents/${doc.id}`, target: "_blank", rel: "noopener", title: `${label}: ${doc.filename}`, "aria-label": `${label}: ${doc.filename}` },
    icon(name),
  );
}

function row(r, q) {
  const href = `/app.html?id=${r.id}`;
  return el(
    "li",
    { className: "row", "data-href": href },
    monogram(r.company),
    el(
      "div",
      { className: "row-main" },
      el("a", { className: "row-title", href }, r.company || "Unknown company"),
      el("div", { className: "row-sub" }, [r.position, r.location].filter(Boolean).join(" · ")),
      q && r.snippet ? el("p", { className: "row-snippet" }, markedText(r.snippet)) : null,
    ),
    el(
      "div",
      { className: "row-actions" },
      docIcon("resume", r.resume, "Resume"),
      docIcon("letter", r.cover_letter, "Cover letter"),
      r.posting_url
        ? el("a", { className: "icon-link", href: r.posting_url, target: "_blank", rel: "noopener noreferrer", title: "Open posting", "aria-label": "Open posting" }, icon("external"))
        : null,
    ),
    relativeDate(r.applied_at, "row-date"),
  );
}

function monthKey(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Undated" : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function render(results, q) {
  active = -1;
  $("count").textContent = results.length ? String(results.length) : "";
  $("count").title = q ? "matches" : "applications";

  if (!results.length) {
    if (q) {
      const clear = el("button", { type: "button", className: "btn outline" }, "Clear search");
      clear.addEventListener("click", clearSearch);
      $("results").replaceChildren(emptyState("search", `No matches for “${q}”`, "Try a company, a role, or a word from your resume.", clear));
    } else {
      $("results").replaceChildren(
        emptyState("inbox", "Nothing logged yet", "On a job posting, right-click and choose “Log entire application”."),
      );
    }
    return;
  }

  if (q) {
    // Search results are ranked, so no month grouping.
    $("results").replaceChildren(el("ul", { className: "rows" }, results.map((r) => row(r, q))));
    return;
  }
  const groups = new Map();
  for (const r of results) {
    const key = monthKey(r.applied_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  $("results").replaceChildren(
    ...[...groups].map(([month, list]) =>
      el(
        "section",
        { className: "group" },
        el("div", { className: "group-head" }, el("span", { className: "label" }, month), el("span", { className: "count num" }, String(list.length))),
        el("ul", { className: "rows" }, list.map((r) => row(r))),
      ),
    ),
  );
}

function skeleton() {
  const bar = () =>
    el("li", { className: "row" }, el("span", { className: "mono skel" }), el("div", { className: "row-main" }, el("div", { className: "skel line w60" }), el("div", { className: "skel line w35" })));
  return el("ul", { className: "rows skeleton", "aria-hidden": "true" }, [bar(), bar(), bar(), bar()]);
}

// ------------------------------------------------------------------ search

async function run() {
  const q = input.value.trim();
  $("clear").hidden = !q;
  history.replaceState(null, "", q ? `?${new URLSearchParams({ q })}` : location.pathname);

  const id = ++latest;
  // Only show a skeleton if the search is slow, to avoid a flash.
  const slow = setTimeout(() => id === latest && $("results").replaceChildren(skeleton()), 150);
  try {
    const results = await api(`/applications?${new URLSearchParams({ q, limit: 200 })}`);
    if (id !== latest) return; // a newer search already finished
    $("messages").replaceChildren();
    render(results, q);
  } catch (e) {
    if (id === latest) {
      $("results").replaceChildren();
      banner($("messages"), `Search failed: ${e.message}`);
    }
  } finally {
    clearTimeout(slow);
  }
}

function clearSearch() {
  input.value = "";
  run();
  input.focus();
}

input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 160);
});
$("clear").addEventListener("click", clearSearch);
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(timer);
  if (active >= 0) open();
  else run();
});

// ------------------------------------------------------------------ keyboard: ↑ ↓ Enter Esc

const rows = () => [...document.querySelectorAll("#results .row[data-href]")];

function highlight(i) {
  const list = rows();
  if (!list.length) return;
  active = Math.max(0, Math.min(i, list.length - 1));
  list.forEach((r, n) => r.classList.toggle("active", n === active));
  list[active].scrollIntoView({ block: "nearest" });
}

function open() {
  const r = rows()[active];
  if (r) location.assign(r.dataset.href);
}

document.addEventListener("keydown", (e) => {
  const inSearch = e.target === input;
  const typingElsewhere = !inSearch && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
  if (typingElsewhere || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    highlight(active + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (active <= 0) {
      rows().forEach((r) => r.classList.remove("active"));
      active = -1;
      input.focus();
    } else highlight(active - 1);
  } else if (e.key === "Enter" && active >= 0 && !inSearch) {
    e.preventDefault();
    open();
  } else if (e.key === "Escape" && inSearch && input.value) {
    e.preventDefault();
    clearSearch();
  }
});

run();
