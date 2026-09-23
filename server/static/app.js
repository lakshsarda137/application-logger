import {
  api,
  banner,
  copyText,
  el,
  emptyState,
  flash,
  formatDateTime,
  formatSize,
  icon,
  initTopbar,
  monogram,
  platformName,
  relativeDate,
  relativeLabel,
  shortPath,
  shortSalary,
  shortUrl,
  toast,
} from "./common.js";

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const KIND_LABEL = { resume: "Resume", cover_letter: "Cover letter", other: "File" };

initTopbar();

// "‹ Applications" returns to the search you came from (query + scroll) when possible.
$("back").addEventListener("click", (e) => {
  try {
    const ref = new URL(document.referrer);
    if (ref.origin === location.origin && ref.pathname === "/") {
      e.preventDefault();
      history.back();
    }
  } catch {}
});

// ------------------------------------------------------------------ small pieces

function chip(iconName, content, title) {
  return el("span", { className: "chip", title: title || null }, icon(iconName, "sm"), content);
}

function extBadge(filename) {
  const ext = (filename.split(".").pop() || "").toUpperCase();
  return el("span", { className: "badge", "aria-hidden": "true" }, ext === "DOCX" ? "DOC" : ext.slice(0, 4) || "FILE");
}

function isPdf(doc) {
  return (doc.mime || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(doc.filename || "");
}

function humanize(value) {
  // "FULL_TIME, INTERN" -> "Full time, Intern"
  return (value || "")
    .split(/,\s*/)
    .map((v) => v.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()))
    .join(", ");
}

function copyButton(text, what) {
  const b = el("button", { type: "button", className: "btn icon-only", title: `Copy ${what}`, "aria-label": `Copy ${what}` }, icon("copy", "sm"));
  b.addEventListener("click", () => copyText(text, `${what[0].toUpperCase()}${what.slice(1)} copied`));
  return b;
}

// ------------------------------------------------------------------ documents

function tile(doc, kindLabel) {
  if (!doc) {
    return el(
      "div",
      { className: "tile missing" },
      el("span", { className: "badge" }),
      el("div", { className: "tile-text" }, el("div", { className: "label" }, kindLabel), el("div", { className: "tile-meta" }, `No ${kindLabel.toLowerCase()} saved`)),
    );
  }
  const preview = el("button", { type: "button", className: "btn icon-only", title: "Preview", "aria-label": `Preview ${doc.filename}` }, icon("eye"));
  preview.addEventListener("click", () => openPreview(doc));
  return el(
    "div",
    { className: "tile" },
    extBadge(doc.filename),
    el(
      "div",
      { className: "tile-text" },
      el("div", { className: "label" }, KIND_LABEL[doc.kind] || kindLabel),
      el("div", { className: "tile-name", title: doc.filename }, doc.filename),
      el("div", { className: "tile-meta num" }, formatSize(doc.size)),
    ),
    preview,
    el("a", { className: "btn icon-only", href: `/documents/${doc.id}?download=1`, title: "Download", "aria-label": `Download ${doc.filename}` }, icon("download")),
  );
}

function openPreview(doc) {
  const dialog = $("preview");
  $("preview-name").textContent = doc.filename;
  $("preview-download").href = `/documents/${doc.id}?download=1`;
  $("preview-open").href = `/documents/${doc.id}`;
  let body;
  if (isPdf(doc)) {
    body = el("iframe", { className: "preview-frame", src: `/documents/${doc.id}`, title: doc.filename });
  } else if ((doc.mime || "").startsWith("image/")) {
    body = el("div", { className: "preview-text" }, el("img", { src: `/documents/${doc.id}`, alt: doc.filename }));
  } else if (doc.text_preview) {
    body = el("pre", { className: "prose preview-text" }, doc.text_preview);
  } else {
    body = el("div", { className: "preview-text" }, emptyState("resume", "No preview for this file type", "Download it to open it."));
  }
  $("preview-body").replaceChildren(body);
  dialog.showModal();
}

$("preview-close").addEventListener("click", () => $("preview").close());
$("preview").addEventListener("close", () => $("preview-body").replaceChildren());
for (const dialog of document.querySelectorAll("dialog")) {
  // Click on the backdrop closes.
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ------------------------------------------------------------------ tabs

const TABS = ["posting", "answers", "archived", "details"];
let current = null;
const shown = new Set();

function visibleTabs() {
  return TABS.filter((t) => !$(`tab-${t}`).hidden);
}

function select(name, { focus = false } = {}) {
  if (!visibleTabs().includes(name)) name = "posting";
  current = name;
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute("aria-selected", String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (focus) $(`tab-${name}`).focus();
  history.replaceState(null, "", `${location.pathname}${location.search}${name === "posting" ? "" : `#${name}`}`);
  if (!shown.has(name)) {
    shown.add(name);
    onFirstShow[name]?.();
  }
}

for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => select(t));
window.addEventListener("hashchange", () => current && select(location.hash.slice(1) || "posting"));
document.querySelector("[role=tablist]").addEventListener("keydown", (e) => {
  const tabs = visibleTabs();
  const i = tabs.indexOf(current);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  select(tabs[(next + tabs.length) % tabs.length], { focus: true });
});

const onFirstShow = {};

// ------------------------------------------------------------------ panels

function renderPosting(app) {
  $("posting-text").textContent = app.posting_text || "No posting text was captured.";
  onFirstShow.posting = () => {
    // Clamp long postings; measure once the panel is visible.
    const body = $("posting-body");
    if (body.scrollHeight > body.clientHeight + 4) {
      body.classList.add("fade");
      $("show-more").hidden = false;
    }
  };
  $("show-more").addEventListener("click", () => {
    const open = $("posting-body").classList.toggle("open");
    $("show-more").textContent = open ? "Show less" : "Show full posting";
  });
}

function renderAnswers(app) {
  const answers = app.form_answers;
  $("answers-count").textContent = answers.length ? String(answers.length) : "";
  const panel = $("panel-answers");
  if (!answers.length) {
    panel.replaceChildren(emptyState("inbox", "No answers captured", "Answers you type into application forms show up here."));
    return;
  }
  const byPage = new Map();
  for (const a of answers) {
    if (!byPage.has(a.page_url)) byPage.set(a.page_url, []);
    byPage.get(a.page_url).push(a);
  }
  panel.replaceChildren(
    ...[...byPage].map(([url, list]) =>
      el(
        "div",
        { className: "answer-group" },
        el(
          "div",
          { className: "answer-group-head" },
          el("span", { title: url }, shortUrl(url) || "Unknown page"),
          el("span", { className: "num" }, `${list.length} answer${list.length === 1 ? "" : "s"}`),
        ),
        el(
          "ul",
          { className: "answers" },
          list.map((a) => el("li", {}, el("div", { className: "q" }, a.field_label || a.field_name || "Unlabelled field"), el("div", { className: "a" }, a.value))),
        ),
      ),
    ),
  );
  onFirstShow.answers = () => {
    // Long answers are clamped to 3 lines; click to expand.
    for (const li of panel.querySelectorAll(".answers li")) {
      const a = li.querySelector(".a");
      if (a.scrollHeight <= a.clientHeight + 2) continue;
      li.classList.add("expandable");
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-expanded", "false");
      const toggle = () => li.setAttribute("aria-expanded", String(li.classList.toggle("open")));
      li.addEventListener("click", toggle);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
  };
}

function renderArchived(app) {
  $("tab-archived").hidden = !app.has_snapshot;
  onFirstShow.archived = () => {
    // Heavy; load only when opened.
    $("panel-archived").append(
      el("iframe", { className: "snapshot", src: `/applications/${app.id}/snapshot`, sandbox: "", title: "Archived posting", referrerPolicy: "no-referrer" }),
    );
  };
}

function fact(label, ...value) {
  const content = value.filter((v) => v != null && v !== "" && v !== false);
  if (!content.length) return [];
  return [el("dt", {}, label), el("dd", {}, content)];
}

function renderDetails(app) {
  const other = app.documents.filter((d) => d.kind === "other");
  $("panel-details").replaceChildren(
    ...[
    el(
      "dl",
      { className: "facts" },
      fact("Applied", formatDateTime(app.applied_at)),
      fact("Location", app.location),
      fact("Salary", app.salary),
      fact("Employment", humanize(app.employment_type)),
      fact("Date posted", app.date_posted),
      fact("Job ID", app.job_id && el("code", {}, app.job_id), app.job_id && copyButton(app.job_id, "job ID")),
      fact("Platform", platformName(app.ats_platform)),
      fact("Posting", app.posting_url && el("a", { href: app.posting_url, target: "_blank", rel: "noopener noreferrer", title: app.posting_url }, shortUrl(app.posting_url))),
      fact("Folder", app.folder_path && el("span", { className: "path", title: app.folder_path }, shortPath(app.folder_path)), app.folder_path && copyButton(app.folder_path, "folder path")),
    ),
    app.pages.length ? el("div", { className: "label subhead" }, `Captured pages · ${app.pages.length}`) : null,
    app.pages.length
      ? el(
          "ul",
          { className: "pages" },
          app.pages.map((p) =>
            el(
              "li",
              {},
              el("a", { href: p.url, target: "_blank", rel: "noopener noreferrer", title: p.url }, p.title || shortUrl(p.url)),
              relativeDate(p.captured_at, "muted"),
            ),
          ),
        )
      : null,
    other.length ? el("div", { className: "label subhead" }, "Other files") : null,
    other.length ? el("div", { className: "tiles" }, other.map((d) => tile(d, "File"))) : null,
    ].filter(Boolean),
  );
}

// ------------------------------------------------------------------ menu + delete

function closeMenu() {
  $("menu").hidden = true;
  $("more").setAttribute("aria-expanded", "false");
}
$("more").addEventListener("click", (e) => {
  e.stopPropagation();
  const open = $("menu").hidden;
  $("menu").hidden = !open;
  $("more").setAttribute("aria-expanded", String(open));
  if (open) $("menu").querySelector("button:not([hidden])")?.focus();
});
document.addEventListener("click", (e) => {
  if (!$("menu").hidden && !$("menu").contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("menu").hidden) {
    closeMenu();
    $("more").focus();
  }
});

function wireActions(app) {
  $("copy-folder").hidden = !app.folder_path;
  $("copy-job").hidden = !app.job_id;
  $("copy-folder").addEventListener("click", () => {
    closeMenu();
    copyText(app.folder_path, "Folder path copied");
  });
  $("copy-job").addEventListener("click", () => {
    closeMenu();
    copyText(app.job_id, "Job ID copied");
  });

  $("delete-what").textContent = [app.company, app.position].filter(Boolean).join(" · ");
  $("delete-open").addEventListener("click", () => {
    closeMenu();
    $("delete-dialog").showModal();
  });
  $("delete-cancel").addEventListener("click", () => $("delete-dialog").close());
  $("delete-confirm").addEventListener("click", async () => {
    $("delete-confirm").disabled = $("delete-cancel").disabled = true;
    try {
      const r = await api(`/applications/${app.id}`, { method: "DELETE" });
      const folder = {
        deleted: "Its folder was deleted too.",
        missing: "Its folder was already gone.",
        outside_base: "Its folder is outside your base path, so it was left on disk.",
        not_deleted: "Its folder could not be deleted.",
      }[r.folder_status];
      flash(`Deleted ${app.company || "application"}. ${folder || ""}`.trim());
      location.replace("/");
    } catch (e) {
      $("delete-dialog").close();
      toast(`Delete failed: ${e.message}`, "error");
    } finally {
      $("delete-confirm").disabled = $("delete-cancel").disabled = false;
    }
  });
}

// ------------------------------------------------------------------ load

async function load() {
  if (!id) {
    banner($("messages"), "No application selected.");
    return;
  }
  let app;
  try {
    app = await api(`/applications/${id}`);
  } catch (e) {
    banner($("messages"), `Could not load this application: ${e.message}`);
    return;
  }

  document.title = [app.company, app.position].filter(Boolean).join(" — ") || "Application";
  $("mono-slot").replaceWith(monogram(app.company, "xl"));
  $("company").textContent = app.company || "Unknown company";
  $("position").textContent = app.position || "";

  if (app.posting_url) $("posting-link").href = app.posting_url;
  else $("posting-link").hidden = true;

  const salary = shortSalary(app.salary);
  $("chips").replaceChildren(
    ...[
    chip("clock", `Applied ${relativeLabel(app.applied_at).replace(/^(Today|Yesterday)$/, (m) => m.toLowerCase())}`, formatDateTime(app.applied_at)),
    app.location ? chip("pin", app.location) : null,
    salary ? chip("money", salary, app.salary) : null,
    app.ats_platform ? chip("briefcase", platformName(app.ats_platform), "Applied through") : null,
    ].filter(Boolean),
  );

  const resume = app.documents.find((d) => d.kind === "resume");
  const cover = app.documents.find((d) => d.kind === "cover_letter");
  $("tiles").replaceChildren(tile(resume, "Resume"), tile(cover, "Cover letter"));

  renderPosting(app);
  renderAnswers(app);
  renderArchived(app);
  renderDetails(app);
  wireActions(app);

  $("content").hidden = false;
  select(location.hash.slice(1) || "posting");
}

load();
