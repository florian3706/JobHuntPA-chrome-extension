// Client for the JobHuntPA extension API (see README). Every request: bearer key, no cookies.

export class ApiError extends Error {
  constructor(status, code, detail, extra = {}) {
    super(detail || code || `HTTP ${status}`);
    this.status = status; // 0 = no HTTP answer
    this.code = code || "";
    this.detail = detail || "";
    Object.assign(this, extra); // retryAfter, kind
  }
}

export const KEY_PATTERN = /^jhpa_[A-Za-z0-9_-]{43}$/;

const isLocalHost = (host) =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  host.endsWith(".local") ||
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || // IPv4
  host.startsWith("[") || // IPv6 literal
  !host.includes("."); // single-label LAN name such as "raspberrypi"

/** "raspberrypi.local:8000/foo/" -> "http://raspberrypi.local:8000". Throws Error with a user message. */
export function normalizeServer(input) {
  let s = String(input ?? "").trim();
  if (!s) throw new Error("Enter the address of your JobHuntPA server.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const authority = s.split(/[/?#]/)[0].replace(/^.*@/, "");
    const host = authority.replace(/:\d+$/, "").toLowerCase();
    s = (isLocalHost(host) ? "http://" : "https://") + s;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error("That does not look like a web address. Example: http://127.0.0.1:8000");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The address must start with http:// or https://");
  }
  if (url.username || url.password) throw new Error("Leave the user name and password out of the address.");
  if (!url.hostname) throw new Error("Enter the address of your JobHuntPA server.");
  return url.origin;
}

export async function api(cfg, method, path, body, { timeout = 30000 } = {}) {
  const headers = { Accept: "application/json", Authorization: `Bearer ${cfg.key}` };
  if (cfg.workspace != null) headers["X-Workspace"] = String(cfg.workspace);
  const init = { method, headers, credentials: "omit", cache: "no-store" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const ctl = new AbortController();
  init.signal = ctl.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeout);
  try {
    let res;
    try {
      res = await fetch(cfg.server + path, init);
    } catch (e) {
      throw new ApiError(0, "", "", { kind: timedOut ? "timeout" : "network" });
    }
    const text = await res.text().catch(() => "");
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const detail = data && typeof data.detail === "string" ? data.detail : "";
      throw new ApiError(res.status, data && data.code, detail, {
        retryAfter: Number.parseInt(res.headers.get("Retry-After") || "", 10) || 0,
      });
    }
    if (data === null || typeof data !== "object") {
      throw new ApiError(res.status, "bad_response", "The server's answer was not what JobHuntPA sends. Is the address right?");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** { message, optionsLink } for showing an ApiError (or anything else) to the user. */
export function describeError(err, cfg) {
  if (!(err instanceof ApiError)) return { message: String(err?.message || err), optionsLink: false };
  const where = cfg?.server || "the configured address";
  if (err.status === 0) {
    if (err.kind === "timeout") {
      return { message: `JobHuntPA at ${where} took too long to answer. Try again in a moment.`, optionsLink: false };
    }
    return {
      message: `Can't reach your JobHuntPA server at ${where}. Check that it is running and that you are on the right network (VPN, Wi-Fi).`,
      optionsLink: true,
    };
  }
  switch (err.status) {
    case 401:
      return { message: "The extension key was not accepted (it may be revoked or expired). Reconnect in Options.", optionsLink: true };
    case 403:
      return { message: err.detail || "This action is not allowed with an extension key.", optionsLink: false };
    case 404:
      if (!err.detail || /^not found$/i.test(err.detail)) {
        return { message: "This server does not offer the browser extension API. Update JobHuntPA and try again.", optionsLink: false };
      }
      return { message: `${err.detail} Pick a workspace again.`, optionsLink: true };
    case 423:
      return { message: err.detail || "JobHuntPA is busy encrypting data. Try again in a few minutes.", optionsLink: false };
    case 429: {
      const wait = err.retryAfter ? ` Try again in ${err.retryAfter} s.` : " Try again in a moment.";
      return { message: `Too many requests.${wait}`, optionsLink: false };
    }
    default:
      return { message: err.detail || `The server answered with an error (${err.status}).`, optionsLink: false };
  }
}

/** Open link only when it stays on the configured server. Returns the URL string or "". */
export function serverLink(server, link) {
  try {
    const u = new URL(link, server + "/");
    if (u.origin !== server) return "";
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.href;
  } catch {
    return "";
  }
}
