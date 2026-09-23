// Shared helpers for the dashboard pages. Auth is the HttpOnly cookie the
// server set when it served the page; mutating calls add X-Requested-With.

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

export function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Search snippets mark matches with \x02…\x03; turn them into <mark> safely. */
export function markedText(snippet) {
  const frag = document.createDocumentFragment();
  const parts = (snippet || "").split(/(\x02[^\x03]*\x03)/);
  for (const part of parts) {
    if (part.startsWith("\x02")) frag.append(el("mark", {}, part.slice(1, -1)));
    else if (part) frag.append(part);
  }
  return frag;
}

export function banner(container, message, kind = "error") {
  container.replaceChildren(el("div", { className: `banner ${kind}`, role: kind === "error" ? "alert" : "status" }, message));
}
