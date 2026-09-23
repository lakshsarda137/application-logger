import { api, banner, el, formatDate, markedText } from "./common.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

$("q").value = params.get("q") || "";

let latest = 0;
let timer = null;

function docLink(label, doc) {
  if (!doc) return null;
  return el(
    "span",
    {},
    `${label}: `,
    el("a", { href: `/documents/${doc.id}`, target: "_blank", rel: "noopener" }, doc.filename),
  );
}

function card(r) {
  const title = [r.company || "Unknown company", r.position].filter(Boolean).join(" — ");
  const meta = [`Applied ${formatDate(r.applied_at)}`, r.location].filter(Boolean).join(" · ");
  return el(
    "li",
    { className: "card" },
    el("a", { className: "card-title", href: `/app.html?id=${r.id}` }, title),
    el("div", { className: "card-meta" }, meta),
    r.snippet ? el("p", { className: "card-snippet" }, markedText(r.snippet)) : null,
    el(
      "div",
      { className: "card-docs" },
      docLink("Resume", r.resume) || el("span", { className: "muted" }, "No resume saved"),
      docLink("Cover letter", r.cover_letter),
      r.posting_url ? el("a", { href: r.posting_url, target: "_blank", rel: "noopener noreferrer" }, "Posting ↗") : null,
    ),
  );
}

async function run() {
  const q = $("q").value.trim();
  const next = new URLSearchParams();
  if (q) next.set("q", q);
  history.replaceState(null, "", next.toString() ? `?${next}` : location.pathname);

  const id = ++latest;
  try {
    const results = await api(`/applications?${new URLSearchParams({ q, limit: 100 })}`);
    if (id !== latest) return; // a newer search already finished
    $("messages").replaceChildren();
    $("results").replaceChildren(...results.map(card));
    $("count").textContent = q
      ? `${results.length} result${results.length === 1 ? "" : "s"} for “${q}”`
      : `${results.length} most recent`;
    if (!results.length) {
      $("results").append(
        el("li", { className: "empty" }, q ? "No matching applications." : "No applications logged yet."),
      );
    }
  } catch (e) {
    if (id === latest) banner($("messages"), `Search failed: ${e.message}`);
  }
}

$("q").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 180);
});
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(timer);
  run();
});

run();
