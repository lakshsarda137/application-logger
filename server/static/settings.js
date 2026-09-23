import { api, banner, initTopbar, shortPath, toast } from "./common.js";

const $ = (id) => document.getElementById(id);
let basePath = "";

initTopbar();

function render(settings) {
  basePath = settings.base_path;
  $("base-display").textContent = shortPath(basePath, 56);
  $("base-display").title = basePath;

  const m = settings.month_folder;
  $("month-display").textContent = m.month;
  $("month-display").title = m.path;
  $("month-status").hidden = false;
  $("month-status").className = `status ${m.exists ? "ok" : "warn"}`;
  $("month-status").textContent = m.exists ? "Folder ready" : "Folder missing";
  $("create-month").hidden = m.exists;
}

function editing(on) {
  $("base-form").hidden = !on;
  $("base-edit").hidden = on;
  if (on) {
    $("base-path").value = basePath;
    $("base-path").focus();
  }
}

$("base-edit").addEventListener("click", () => editing(true));
$("base-cancel").addEventListener("click", () => editing(false));
$("base-form").addEventListener("keydown", (e) => {
  if (e.key === "Escape") editing(false);
});

$("base-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    render(await api("/settings", { method: "PUT", json: { base_path: $("base-path").value.trim() } }));
    editing(false);
    $("messages").replaceChildren();
    toast("Save location updated");
  } catch (err) {
    banner($("messages"), err.message);
  }
});

$("create-month").addEventListener("click", async () => {
  try {
    await api("/settings/month-folder", { method: "POST" });
    render(await api("/settings"));
    toast("Folder created");
  } catch (err) {
    banner($("messages"), err.message);
  }
});

api("/settings")
  .then(render)
  .catch((e) => banner($("messages"), `Could not load settings: ${e.message}`));
