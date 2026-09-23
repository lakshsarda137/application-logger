import { api, banner, el, formatDate, formatSize } from "./common.js";

const $ = (id) => document.getElementById(id);
const id = Number(new URLSearchParams(location.search).get("id"));
const KIND_LABEL = { resume: "Resume", cover_letter: "Cover letter", other: "Other" };

function isPdf(doc) {
  return (doc.mime || "").toLowerCase() === "application/pdf" || /\.pdf$/i.test(doc.filename || "");
}

function renderDocument(doc) {
  const preview = isPdf(doc)
    ? el("iframe", { className: "preview", src: `/documents/${doc.id}`, title: `Preview of ${doc.filename}`, loading: "lazy" })
    : doc.text_preview
      ? el("details", {}, el("summary", {}, "Extracted text"), el("pre", { className: "text" }, doc.text_preview))
      : el("p", { className: "muted small" }, "No preview available for this file type.");

  return el(
    "div",
    { className: "doc" },
    el(
      "div",
      { className: "doc-head" },
      el("span", { className: "grow" }, `${KIND_LABEL[doc.kind] || doc.kind}: ${doc.filename}`),
      el("span", { className: "muted small" }, formatSize(doc.size)),
      el("a", { href: `/documents/${doc.id}`, target: "_blank", rel: "noopener" }, "Open"),
      el("a", { href: `/documents/${doc.id}?download=1` }, "Download"),
    ),
    doc.file_path ? el("p", { className: "muted small" }, "Saved at ", el("code", {}, doc.file_path)) : null,
    preview,
  );
}

function metaRow(label, value) {
  if (!value) return [];
  return [el("dt", {}, label), el("dd", {}, value)];
}

function renderAnswers(answers) {
  $("answers-summary").textContent = `Portal answers (${answers.length})`;
  if (!answers.length) {
    $("answers").replaceChildren(el("p", { className: "muted" }, "No answers were captured."));
    return;
  }
  const byPage = new Map();
  for (const a of answers) {
    if (!byPage.has(a.page_url)) byPage.set(a.page_url, []);
    byPage.get(a.page_url).push(a);
  }
  $("answers").replaceChildren(
    ...[...byPage].map(([url, list]) =>
      el(
        "div",
        { className: "answers-page" },
        el("h3", {}, url || "Unknown page"),
        el("dl", { className: "answers" }, list.flatMap((a) => [
          el("dt", {}, a.field_label || a.field_name || "(unlabelled)"),
          el("dd", {}, a.value),
        ])),
      ),
    ),
  );
}

function renderDelete(app) {
  const area = $("delete-area");
  const start = el("button", { type: "button", className: "danger" }, "Delete");
  start.addEventListener("click", () => {
    const yes = el("button", { type: "button", className: "danger solid" }, "Delete permanently");
    const no = el("button", { type: "button" }, "Cancel");
    no.addEventListener("click", () => area.replaceChildren(start));
    yes.addEventListener("click", async () => {
      yes.disabled = no.disabled = true;
      try {
        const r = await api(`/applications/${app.id}`, { method: "DELETE" });
        const folder = {
          deleted: "Its folder was deleted too.",
          missing: "Its folder was already gone.",
          outside_base: "Its folder is outside your base path, so it was left on disk.",
          not_deleted: "Its folder could not be deleted.",
        }[r.folder_status];
        $("content").hidden = true;
        banner($("messages"), `Deleted. ${folder} Returning to search…`, "ok");
        setTimeout(() => location.assign("/"), 2500);
      } catch (e) {
        banner($("messages"), `Delete failed: ${e.message}`);
        area.replaceChildren(start);
      }
    });
    area.replaceChildren(
      el(
        "div",
        { className: "confirm" },
        el("span", {}, "Delete this application from the database and its folder from disk?"),
        yes,
        no,
      ),
    );
    no.focus();
  });
  area.replaceChildren(start);
}

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
  $("title").textContent = app.company || "Unknown company";
  $("subtitle").textContent = [app.position, `applied ${formatDate(app.applied_at)}`].filter(Boolean).join(" · ");

  const posting = app.posting_url
    ? el("a", { href: app.posting_url, target: "_blank", rel: "noopener noreferrer" }, app.posting_url)
    : null;
  $("meta").replaceChildren(
    ...metaRow("Company", app.company),
    ...metaRow("Role", app.position),
    ...metaRow("Applied", new Date(app.applied_at).toLocaleString()),
    ...metaRow("Location", app.location),
    ...metaRow("Salary", app.salary),
    ...metaRow("Employment type", app.employment_type),
    ...metaRow("Date posted", app.date_posted),
    ...metaRow("Job ID", app.job_id),
    ...metaRow("Platform", app.ats_platform),
    ...metaRow("Posting", posting),
    ...metaRow("Folder", app.folder_path ? el("code", {}, app.folder_path) : null),
  );

  const main = app.documents.filter((d) => d.kind !== "other");
  const other = app.documents.filter((d) => d.kind === "other");
  $("documents").replaceChildren(
    ...(main.length ? main.map(renderDocument) : [el("p", { className: "muted" }, "No resume or cover letter was saved.")]),
  );
  $("other-panel").hidden = !other.length;
  $("other-documents").replaceChildren(...other.map(renderDocument));

  $("posting-text").textContent = app.posting_text || "(No posting text was captured.)";

  if (app.has_snapshot) {
    // Load the (possibly heavy) archived page only when opened.
    $("snapshot-details").addEventListener(
      "toggle",
      () => {
        if (!$("snapshot").childElementCount) {
          $("snapshot").append(
            el("iframe", {
              className: "preview",
              src: `/applications/${app.id}/snapshot`,
              sandbox: "",
              title: "Archived posting",
              referrerPolicy: "no-referrer",
            }),
          );
        }
      },
      { once: false },
    );
  } else {
    $("snapshot-panel").hidden = true;
  }

  renderAnswers(app.form_answers);

  $("pages-summary").textContent = `Captured pages (${app.pages.length})`;
  $("pages").replaceChildren(
    ...app.pages.map((p) =>
      el(
        "li",
        {},
        el("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.title || p.url),
        el("span", { className: "muted small" }, ` · ${formatDate(p.captured_at)}`),
      ),
    ),
  );

  renderDelete(app);
  $("content").hidden = false;
}

load();
