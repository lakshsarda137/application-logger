import { api, ApiError, DEFAULT_SERVER, getConnection, ServerDownError } from "./lib/api.js";

const $ = (id) => document.getElementById(id);

function status(message, kind) {
  const el = $("status");
  el.textContent = message;
  el.className = `banner ${kind}`;
  el.hidden = false;
}

async function save() {
  const serverUrl = $("server-url").value.trim() || DEFAULT_SERVER;
  let parsed;
  try {
    parsed = new URL(serverUrl);
  } catch {
    status("Server URL is not a valid URL.", "error");
    return false;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    status("The server must be on this machine (127.0.0.1 or localhost).", "error");
    return false;
  }
  await chrome.storage.local.set({ serverUrl, apiToken: $("api-token").value.trim() });
  return true;
}

async function test() {
  try {
    const settings = await api("/settings");
    await chrome.storage.local.set({ resumeName: settings.resume_name || "" });
    const m = settings.month_folder;
    status(
      `Connected. Saving to ${m.path}${m.exists ? "" : ` (the ${m.month} folder doesn't exist yet)`}.`,
      "ok",
    );
  } catch (e) {
    if (e instanceof ServerDownError) status("Can't reach the server. Is ./scripts/start.sh running?", "error");
    else if (e instanceof ApiError && e.status === 401) status("Server is running, but the token is wrong.", "error");
    else status(e.message, "error");
  }
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await save()) await test();
});

$("test").addEventListener("click", async () => {
  if (await save()) await test();
});

$("dashboard").addEventListener("click", async () => {
  const { serverUrl } = await getConnection();
  chrome.tabs.create({ url: `${serverUrl}/` });
});

getConnection().then(({ serverUrl, apiToken }) => {
  $("server-url").value = serverUrl;
  $("api-token").value = apiToken;
});
