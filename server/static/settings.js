import { api, banner, el } from "./common.js";

const $ = (id) => document.getElementById(id);

function renderMonth(m) {
  $("month-status").replaceChildren(
    m.exists ? "Saving to " : `There's no ${m.month} folder yet: `,
    el("code", {}, m.path),
  );
  $("create-month").hidden = m.exists;
}

async function load() {
  try {
    const settings = await api("/settings");
    $("base-path").value = settings.base_path;
    renderMonth(settings.month_folder);
  } catch (e) {
    banner($("messages"), `Could not load settings: ${e.message}`);
  }
}

$("base-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const settings = await api("/settings", { method: "PUT", json: { base_path: $("base-path").value.trim() } });
    $("base-path").value = settings.base_path;
    renderMonth(settings.month_folder);
    banner($("messages"), "Base path saved.", "ok");
  } catch (err) {
    banner($("messages"), err.message);
  }
});

$("create-month").addEventListener("click", async () => {
  try {
    renderMonth(await api("/settings/month-folder", { method: "POST" }));
    banner($("messages"), "Folder created.", "ok");
  } catch (err) {
    banner($("messages"), err.message);
  }
});

load();
