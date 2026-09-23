// Talks to the local server. Settings live in chrome.storage.local.

export const DEFAULT_SERVER = "http://127.0.0.1:8765";

export class ServerDownError extends Error {
  constructor() {
    super("Server not running");
    this.name = "ServerDownError";
  }
}

export class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

export async function getConnection() {
  const { serverUrl, apiToken } = await chrome.storage.local.get({
    serverUrl: DEFAULT_SERVER,
    apiToken: "",
  });
  return { serverUrl: (serverUrl || DEFAULT_SERVER).replace(/\/+$/, ""), apiToken };
}

/** fetch() against the server. Throws ServerDownError / ApiError. Returns parsed JSON. */
export async function api(path, { method = "GET", json, body, timeoutMs = 60_000 } = {}) {
  const { serverUrl, apiToken } = await getConnection();
  const headers = { "X-API-Token": apiToken };
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }

  let res;
  try {
    res = await fetch(serverUrl + path, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Network errors (connection refused) and timeouts both mean "not reachable".
    throw new ServerDownError();
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? res.statusText);
  return data;
}
