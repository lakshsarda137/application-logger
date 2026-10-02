import { api, ApiError, getConnection, ServerDownError } from "./lib/api.js";
import { cleanFilename, defaultKind, folderName, guessCompanyAndPosition } from "./lib/guess.js";
import { buildLogData, fileKey } from "./lib/logdata.js";
import { deleteSession, getSessionData, recentUploads } from "./lib/sessions.js";

const $ = (id) => document.getElementById(id);
const KINDS = [
  ["resume", "Resume"],
  ["cover_letter", "Cover letter"],
  ["other", "Other"],
];

const params = new URLSearchParams(location.search);
const state = {
  sessionId: params.get("session"),
  pages: [], // { ...page, include }
  postingIndex: 0,
  files: [], // { filename, mime, size, lastModified, blob, kind, fieldLabel, source, userSet }
  answers: [],
  recent: [],
  month: null, // { month, path, exists } from the server
  noToken: false,
  useCustomDir: false,
  folderEdited: false,
  saving: false,
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};

// ------------------------------------------------------------------ banner

function showBanner(message, { kind = "error", action } = {}) {
  const banner = $("banner");
  banner.replaceChildren(document.createTextNode(message));
  banner.className = `banner ${kind}`;
  if (action) {
    const btn = el("button", { type: "button", className: "link", textContent: action.label });
    btn.addEventListener("click", action.onClick);
    banner.append(" ", btn);
  }
  banner.hidden = false;
}

function hideBanner() {
  $("banner").hidden = true;
}

function explain(err) {
  if (err instanceof ServerDownError) {
    showBanner(
      "Server not running. Start it with ./scripts/start.sh, then retry. Your captured data is kept.",
      { action: { label: "Retry", onClick: () => connect() } },
    );
  } else if (err instanceof ApiError && err.status === 401) {
    showBanner("The API token is missing or wrong.", {
      action: { label: "Open settings", onClick: () => chrome.runtime.openOptionsPage() },
    });
  } else {
    showBanner(err.message || String(err));
  }
}

// ------------------------------------------------------------------ save location

async function loadMonthFolder() {
  try {
    state.month = await api("/settings/month-folder");
    return true;
  } catch (e) {
    state.month = null;
    explain(e);
    return false;
  } finally {
    renderSaveLocation();
  }
}

function renderSaveLocation() {
  const m = state.month;
  $("custom-dir").hidden = !state.useCustomDir;
  $("month-missing").hidden = state.useCustomDir || !m || m.exists;
  $("change-path").hidden = state.useCustomDir;
  if (state.useCustomDir) {
    $("save-path").textContent = $("custom-path").value.trim() || "(enter a folder below)";
  } else if (m) {
    $("save-path").textContent = m.exists ? m.path : `${m.path} (doesn't exist yet)`;
    $("month-name").textContent = m.month;
  } else {
    $("save-path").textContent = state.noToken ? "(connect the extension first)" : "(server not reachable)";
  }
}

$("month-yes").addEventListener("click", async () => {
  try {
    state.month = await api("/settings/month-folder", { method: "POST" });
    hideBanner();
  } catch (e) {
    explain(e);
  }
  renderSaveLocation();
});
$("month-no").addEventListener("click", () => {
  state.useCustomDir = true;
  renderSaveLocation();
  $("custom-path").focus();
});
$("change-path").addEventListener("click", () => $("month-no").click());
$("use-month").addEventListener("click", () => {
  state.useCustomDir = false;
  renderSaveLocation();
});
$("custom-path").addEventListener("input", renderSaveLocation);

// ------------------------------------------------------------------ details

function updateFolderName() {
  if (!state.folderEdited) $("folder-name").value = folderName($("company").value, $("position").value);
}
$("company").addEventListener("input", updateFolderName);
$("position").addEventListener("input", updateFolderName);
$("folder-name").addEventListener("input", () => {
  state.folderEdited = true;
});

function applyGuess() {
  const posting = state.pages[state.postingIndex];
  const others = state.pages.filter((p) => p !== posting).reverse(); // newest first
  const guess = guessCompanyAndPosition(posting || {}, others);
  $("company").value = guess.company;
  $("position").value = guess.position;
  updateFolderName();
  $("source").textContent = posting ? posting.url : "";
  $("source").title = posting ? posting.url : "";
}

// ------------------------------------------------------------------ files

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ago(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} h ago`;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// Resume and cover letter are saved without copy numbers ("Resume(75).pdf" -> "Resume.pdf").
const savedName = (file) => (file.kind === "other" ? file.filename : cleanFilename(file.filename));

function renderFiles() {
  $("no-files").hidden = state.files.length > 0;
  $("files").replaceChildren(
    ...state.files.map((file, i) => {
      const name = el("span", { className: "grow ellipsis", textContent: savedName(file) });
      name.title = [
        savedName(file) !== file.filename ? `Uploaded as ${file.filename}` : "",
        file.fieldLabel ? `From “${file.fieldLabel}”` : "",
      ]
        .filter(Boolean)
        .join(" · ") || file.filename;

      const select = el("select");
      select.setAttribute("aria-label", `Label for ${file.filename}`);
      for (const [value, label] of KINDS) select.add(new Option(label, value, false, value === file.kind));
      select.addEventListener("change", () => {
        file.kind = select.value;
        file.userSet = true;
        name.textContent = savedName(file);
      });

      const remove = el("button", { type: "button", className: "icon", textContent: "×" });
      remove.setAttribute("aria-label", `Remove ${file.filename}`);
      remove.addEventListener("click", () => {
        state.files.splice(i, 1);
        renderFiles();
        renderRecent();
      });

      return el("li", {}, name, el("span", { className: "muted", textContent: formatSize(file.size) }), select, remove);
    }),
  );
}

function addFile(file) {
  if (state.files.some((f) => fileKey(f) === fileKey(file))) return false;
  const taken = state.files.map((f) => f.kind);
  state.files.push({ ...file, kind: defaultKind(file.filename, file.fieldLabel, taken), userSet: false });
  return true;
}

$("add-file").addEventListener("change", (e) => {
  for (const f of e.target.files) {
    addFile({
      filename: f.name,
      mime: f.type,
      size: f.size,
      lastModified: f.lastModified,
      blob: f,
      fieldLabel: "",
      source: "disk",
    });
  }
  e.target.value = "";
  renderFiles();
  renderRecent();
});

/** Ask the server's classifier (README §5.1) for labels the user hasn't set. */
async function classifyFiles() {
  const files = state.files.filter((f) => !f.userSet);
  if (!files.length) return;
  const body = new FormData();
  for (const f of files) body.append("files", f.blob, f.filename);
  try {
    const labels = await api("/files/classify", { method: "POST", body });
    labels.forEach((label, i) => {
      if (!files[i].userSet && label?.kind) files[i].kind = label.kind;
    });
    renderFiles();
  } catch {
    // Keep the filename-based guesses.
  }
}

function renderRecent() {
  const shown = state.recent.filter((u) => !state.files.some((f) => fileKey(f) === fileKey(u)));
  $("recent-box").hidden = shown.length === 0;
  $("recent-summary").textContent = `Other recent uploads (${shown.length})`;
  $("recent").replaceChildren(
    ...shown.map((u) => {
      const add = el("button", { type: "button", textContent: "Add" });
      add.addEventListener("click", () => {
        addFile({ ...u, source: "recent" });
        renderFiles();
        renderRecent();
      });
      const text = el("span", { className: "grow ellipsis", textContent: u.filename });
      text.title = u.pageUrl;
      const meta = el("span", {
        className: "muted",
        textContent: [hostOf(u.pageUrl), ago(u.capturedAt)].filter(Boolean).join(" · "),
      });
      return el("li", {}, text, meta, add);
    }),
  );
}

// ------------------------------------------------------------------ captured

function renderPages() {
  $("pages-summary").textContent = `${state.pages.filter((p) => p.include).length} of ${state.pages.length} page(s)`;
  $("pages").replaceChildren(
    ...state.pages.map((p, i) => {
      const isPosting = i === state.postingIndex;
      const radio = el("input", { type: "radio", name: "posting", checked: isPosting });
      radio.setAttribute("aria-label", "This is the job posting");
      radio.title = "This is the job posting";
      radio.addEventListener("change", () => {
        state.postingIndex = i;
        p.include = true;
        applyGuess();
        renderPages();
      });

      const box = el("input", { type: "checkbox", checked: p.include, disabled: isPosting });
      box.setAttribute("aria-label", "Include this page");
      box.addEventListener("change", () => {
        p.include = box.checked;
        renderPages();
      });

      const text = el("span", {
        className: "grow ellipsis",
        textContent: `${isPosting ? "Posting: " : ""}${p.title || p.url}`,
      });
      text.title = p.url;
      return el("li", {}, radio, box, text);
    }),
  );
}

function renderAnswers() {
  $("answers-summary").textContent = `${state.answers.length} answer(s)`;
  $("answers").replaceChildren(
    ...state.answers.map((a, i) => {
      const q = el("strong", { textContent: a.field_label || a.field_name || "(unlabelled)" });
      const text = el("span", { className: "grow" }, q, document.createTextNode(`: ${a.value}`));
      text.title = a.page_url;
      const remove = el("button", { type: "button", className: "icon", textContent: "×" });
      remove.setAttribute("aria-label", "Don't save this answer");
      remove.addEventListener("click", () => {
        state.answers.splice(i, 1);
        renderAnswers();
      });
      return el("li", {}, text, remove);
    }),
  );
}

// ------------------------------------------------------------------ save / discard

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.saving) return;

  const folder = $("folder-name").value.trim();
  if (!folder) {
    showBanner("Enter a folder name.");
    $("folder-name").focus();
    return;
  }
  const saveDir = state.useCustomDir ? $("custom-path").value.trim() : "";
  if (state.useCustomDir && !saveDir) {
    showBanner("Enter the folder to save into, or use this month's folder.");
    $("custom-path").focus();
    return;
  }
  if (!state.useCustomDir && state.month && !state.month.exists) {
    showBanner(`Create the ${state.month.month} folder first, or choose another folder.`);
    return;
  }

  const p = state.pages[state.postingIndex] || {};
  const payload = {
    company: $("company").value.trim(),
    position: $("position").value.trim(),
    folder_name: folder,
    save_dir: saveDir,
    posting: { url: p.url || "", title: p.title || "", text: p.text || "", html: p.html || "", jsonld: p.jsonld || null },
    pages: state.pages
      .filter((pg) => pg.include)
      .map((pg) => ({ url: pg.url, title: pg.title, text: pg.text, captured_at: pg.capturedAt })),
    documents: state.files.map((f) => ({ kind: f.kind, filename: savedName(f), mime: f.mime || null })),
    form_answers: state.answers.map((a) => ({
      page_url: a.page_url,
      field_label: a.field_label,
      field_name: a.field_name,
      value: a.value,
    })),
  };

  const body = new FormData();
  body.append("payload", new Blob([JSON.stringify(payload)], { type: "application/json" }), "payload.json");
  for (const f of state.files) body.append("files", f.blob, savedName(f));

  state.saving = true;
  $("save").disabled = true;
  $("save").textContent = "Saving…";
  hideBanner();
  try {
    const result = await api("/applications", { method: "POST", body, timeoutMs: 120_000 });
    await deleteSession(state.sessionId);
    $("form").hidden = true;
    $("done-path").textContent = result.folder_path;
    $("done").hidden = false; // only seen if the tab can't close itself
    closeDialog();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.detail?.code === "month_folder_missing") {
      state.month = { month: err.detail.month, path: err.detail.path, exists: false };
      renderSaveLocation();
      showBanner(`There's no ${err.detail.month} folder yet.`);
    } else {
      explain(err);
    }
  } finally {
    state.saving = false;
    $("save").disabled = false;
    $("save").textContent = "Save";
  }
});

$("discard").addEventListener("click", () => {
  const yes = el("button", { type: "button", className: "link", textContent: "Yes, discard" });
  const no = el("button", { type: "button", className: "link", textContent: "Keep it" });
  yes.addEventListener("click", async () => {
    await deleteSession(state.sessionId);
    closeDialog();
  });
  no.addEventListener("click", () => $("discard-area").replaceChildren($("discard")));
  $("discard-area").replaceChildren(document.createTextNode("Delete everything captured for this tab? "), yes, " ", no);
});

$("cancel").addEventListener("click", () => closeDialog());
$("close-done").addEventListener("click", () => closeDialog());

/** The dialog is a tab next to the job page: switch back to that page and close. */
async function closeDialog() {
  const from = Number(params.get("tab"));
  if (from) await chrome.tabs?.update(from, { active: true }).catch(() => {});
  try {
    const self = await chrome.tabs?.getCurrent();
    if (self) return await chrome.tabs.remove(self.id);
  } catch {
    // Fall through.
  }
  window.close();
}

// ------------------------------------------------------------------ init

async function connect() {
  hideBanner();
  const { apiToken } = await getConnection();
  state.noToken = !apiToken;
  if (!apiToken) {
    showBanner("Paste the API token from config.local.json into the extension's settings first.", {
      action: { label: "Open settings", onClick: () => chrome.runtime.openOptionsPage() },
    });
    renderSaveLocation();
    return;
  }
  if (await loadMonthFolder()) await classifyFiles();
}

async function init() {
  const data = state.sessionId && (await getSessionData(state.sessionId));
  if (!data) {
    $("form").hidden = true;
    showBanner("Nothing to log: this capture expired or was already saved.");
    return;
  }

  const built = buildLogData(data, { loggedUrl: params.get("url") || "" });
  // Pages from well before the posting (e.g. a different job browsed earlier in
  // the same tab) start unticked; the posting and everything after are included.
  const postingAt = Date.parse(built.posting?.capturedAt) || 0;
  state.pages = built.pages.map((p) => ({
    ...p,
    include: p.id === built.posting?.id || !postingAt || (Date.parse(p.capturedAt) || 0) >= postingAt - 60_000,
  }));
  state.postingIndex = Math.max(0, state.pages.findIndex((p) => p.id === built.posting?.id));
  state.answers = built.answers;
  for (const u of built.files) addFile({ ...u, source: "page" });
  state.recent = await recentUploads({ excludeSessionId: state.sessionId });

  applyGuess();
  renderFiles();
  renderRecent();
  renderPages();
  renderAnswers();
  renderSaveLocation();
  await connect();
  // A server problem (shown by connect) matters more than a capture warning.
  const warn = params.get("warn");
  if (warn && $("banner").hidden) showBanner(warn, { kind: "warn" });
}

init().catch((e) => showBanner(`Could not open the capture: ${e.message}`));
