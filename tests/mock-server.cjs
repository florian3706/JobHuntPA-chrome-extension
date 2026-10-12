// Minimal JobHuntPA stand-in implementing the extension API contract (v3: the extension reads the page, the server gets only a finished job;
// api 2: a page of search results as a list of jobs, which only adds). Also serves ./pages for the tests.
const http = require("http");
const fs = require("fs");
const path = require("path");

/** A test page's HTML. job-huge.html gets megabytes of script and style filled in, like a real app page. */
function readPage(name) {
  const f = path.join(__dirname, "pages", path.basename(name));
  if (!fs.existsSync(f)) return null;
  let html = fs.readFileSync(f, "utf8");
  if (html.includes("<!--HUGE-->")) {
    const state = JSON.stringify({ session: { token: "SECRET-SESSION-TOKEN-123", user: "private.person@example.org" }, junk: "x".repeat(3000000) });
    html = html.replace("<!--HUGE-->", `<script>window.__APP_STATE__=${state};</script><style>${".c{color:red}\n".repeat(80000)}</style>`);
  }
  return html;
}

const KEY = "jhpa_" + "A".repeat(43);
const WORKSPACES = [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }];

function createMock({ port = 0, host = "127.0.0.1" } = {}) {
  const state = { mode: "ok", jobs: [], sources: [], log: [], violations: [], nextJob: 12, nextSource: 5 };
  const send = (res, status, body, headers = {}) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
    res.end(data);
  };
  const err = (res, status, detail, code, headers, field) => send(res, status, { detail, ...(code ? { code } : {}), ...(field ? { field } : {}) }, headers);

  // ---- contract v3: strict validation of the request body (preview and save share it) ----
  const BODY_MAX = 512 * 1024;
  const JOB_LIMITS = { title: 500, company: 500, location_text: 500, salary_text: 500, employment_type: 100, posted_at: 40, url: 2048, description: 100000, description_from: 20, method: 10 };
  const WORK_MODES = ["onsite", "hybrid", "remote", "unknown", ""];
  const FROM = ["selection", "structured", "site", "main", "body", ""];
  const METHODS = ["jsonld", "site", "page", ""];
  const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;
  /** null when the body is fine, else [status, detail, code, field]. Anything not in the contract is refused. */
  function validate(body, size) {
    if (size > BODY_MAX) return [413, "Too large.", "too_large"];
    if (!body || typeof body !== "object" || Array.isArray(body)) return [422, "Body must be an object.", "invalid"];
    for (const k of Object.keys(body)) if (!["url", "canonical_url", "job"].includes(k)) return [422, `Unknown field ${k}.`, "invalid", k];
    for (const k of ["url", "canonical_url"]) {
      if (body[k] === undefined && k === "canonical_url") continue;
      if (typeof body[k] !== "string" || !/^https?:\/\//.test(body[k])) return [422, `${k} must be an http(s) address.`, "invalid", k];
      if (body[k].length > 2048) return [413, `${k} too long.`, "too_large", k];
    }
    const job = body.job === undefined ? {} : body.job;
    if (!job || typeof job !== "object" || Array.isArray(job)) return [422, "job must be an object.", "invalid", "job"];
    for (const [k, v] of Object.entries(job)) {
      if (!(k in JOB_LIMITS) && k !== "work_mode") return [422, `Unknown field job.${k}.`, "invalid", k];
      if (typeof v !== "string") return [422, `job.${k} must be text.`, "invalid", k];
      if (k in JOB_LIMITS && v.length > JOB_LIMITS[k]) return [413, `job.${k} too long.`, "too_large", k];
      if (k !== "url" && HTML_TAG.test(v)) { state.violations.push(`HTML in job.${k}: ${v.slice(0, 80)}`); return [422, `job.${k} must be plain text.`, "invalid", k]; }
    }
    if (!WORK_MODES.includes(job.work_mode || "")) return [422, "bad work_mode", "invalid", "work_mode"];
    if (!FROM.includes(job.description_from || "")) return [422, "bad description_from", "invalid", "description_from"];
    if (!METHODS.includes(job.method || "")) return [422, "bad method", "invalid", "method"];
    return null;
  }
  // ---- api 2: a page of search results ({url, jobs: [...]}) ----
  const LISTED_LIMITS = { url: 2048, title: 500, company: 500, location_text: 500, salary_text: 500, employment_type: 100, posted_at: 40, industry: 200, description: 5000 };
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  /** null when the body is fine, else [status, detail, code, field]. */
  function validateList(body, size) {
    if (size > BODY_MAX) return [413, "Too large.", "too_large"];
    if (!body || typeof body !== "object" || Array.isArray(body)) return [422, "Body must be an object.", "invalid"];
    for (const k of Object.keys(body)) if (!["url", "jobs"].includes(k)) return [422, `Unknown field ${k}.`, "invalid", k];
    if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) return [422, "url must be an http(s) address.", "invalid", "url"];
    if (!Array.isArray(body.jobs) || !body.jobs.length) return [422, "No jobs were sent.", "invalid", "jobs"];
    if (body.jobs.length > 50) return [413, "At most 50 jobs can be added at once.", "too_large", "jobs"];
    for (const job of body.jobs) {
      if (!job || typeof job !== "object" || Array.isArray(job)) return [422, "Each job must be an object.", "invalid", "jobs"];
      for (const [k, v] of Object.entries(job)) {
        if (!(k in LISTED_LIMITS) && k !== "work_mode") return [422, `Unknown field ${k}.`, "invalid", k];
        if (typeof v !== "string") return [422, `${k} must be text.`, "invalid", k];
        if (k in LISTED_LIMITS && v.length > LISTED_LIMITS[k]) return [413, `${k} too long.`, "too_large", k];
        if (k !== "url" && HTML_TAG.test(v)) { state.violations.push(`HTML in a listed job's ${k}: ${v.slice(0, 80)}`); return [422, `${k} must be plain text.`, "invalid", k]; }
      }
      if (!WORK_MODES.includes(job.work_mode || "")) return [422, "bad work_mode", "invalid", "work_mode"];
      if (job.posted_at && !ISO_DATE.test(job.posted_at)) return [422, "bad posted_at", "invalid", "posted_at"];
      if (!job.title || !job.title.trim()) return [422, "A job on this page has no title.", "invalid", "title"];
      let own;
      try { own = new URL(job.url || "", body.url); } catch { own = null; }
      if (!job.url || !own || own.host !== new URL(body.url).host || !/^https?:$/.test(own.protocol)) return [422, "A job on this page has an address on another site.", "invalid", "url"];
    }
    return null;
  }
  /** Which URL is stored: SEEK jobs by id, else job.url / canonical on the same host as url, else url. */
  function storedUrl(body) {
    const u = new URL(body.url);
    if (/(^|\.)seek\.(com|com\.au|co\.nz)$/.test(u.hostname)) { // au.seek.com is where SEEK lives now
      const id = /\/job\/(\d+)/.exec(u.pathname) || /[?&]jobId=(\d+)/.exec(u.search);
      if (id) return `https://www.seek.com.au/job/${id[1]}`;
    }
    for (const c of [(body.job || {}).url, body.canonical_url]) {
      try { if (c && new URL(c).host === u.host) return c; } catch { /* next */ }
    }
    return body.url;
  }
  const ws = (req) => Number(req.headers["x-workspace"] || 1);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname.startsWith("/pages/")) {
      const html = readPage(path.basename(url.pathname));
      return html != null ? send(res, 200, html) : send(res, 404, "nope");
    }
    if (url.pathname === "/__control") { state.mode = url.searchParams.get("mode") || "ok"; return send(res, 200, { mode: state.mode }); }
    if (url.pathname === "/__state") return send(res, 200, { jobs: state.jobs, sources: state.sources, log: state.log, violations: state.violations });
    if (url.pathname === "/__reset") { state.jobs = []; state.sources = []; state.log = []; state.violations = []; state.mode = "ok"; return send(res, 200, { ok: true }); }

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 422, "Invalid JSON."); }
      state.log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || "", workspace: req.headers["x-workspace"] || "", cookie: req.headers.cookie || "", origin: req.headers.origin || "", bytes: Buffer.byteLength(raw), body });
      if (!url.pathname.startsWith("/api/")) return err(res, 404, "Not Found");
      if (req.headers.authorization !== `Bearer ${KEY}` || state.mode === "revoked") return err(res, 401, "This extension key is not valid.", "token_invalid");
      if (state.mode === "busy") return err(res, 423, "The server is encrypting your data. Try again in a few minutes.", "encrypting");
      if (state.mode === "rate") return err(res, 429, "Too many tries with keys that don't work. Try again in 7 seconds.", "rate_limited", { "Retry-After": "7" });
      // "readbusy": the one-at-a-time limit for reading pages (preview and save only)
      if (state.mode === "readbusy" && req.method === "POST" && /^\/api\/extension\/(preview|jobs)$/.test(url.pathname))
        return err(res, 429, "JobHuntPA is already reading another page. Try again in a few seconds.", "busy", { "Retry-After": "5" });
      const w = ws(req);
      if (url.pathname !== "/api/extension/status" && !WORKSPACES.some((x) => x.id === w)) return err(res, 404, "Workspace not found.");

      if (req.method === "GET" && url.pathname === "/api/extension/status")
        // "wsgone": the account no longer has the workspace the extension stored (the server still answers 200).
        // "oldapi": a server from before it took a page of jobs
        return send(res, 200, { ok: true, api: state.mode === "oldapi" ? 1 : 2, app_version: "1.13.0", label: "Test browser", expires_at: "2027-10-09T12:00:00Z", workspaces: state.mode === "wsgone" ? WORKSPACES.slice(1) : WORKSPACES, default_workspace: state.mode === "wsgone" ? 3 : 1 });
      if (req.method === "POST" && /^\/api\/extension\/(preview|jobs)$/.test(url.pathname)) {
        const bad = validate(body, Buffer.byteLength(raw));
        if (bad) return err(res, bad[0], bad[1], bad[2], undefined, bad[3]);
        const stored = storedUrl(body);
        const existing = state.jobs.find((j) => j.url === stored && j.ws === w);
        if (url.pathname.endsWith("/preview"))
          return send(res, 200, { url: stored, existing: existing ? { id: existing.id, title: existing.title, status: "to_review", link: `/job.html?id=${existing.id}&ws=${w}` } : null });
        const job = body.job || {};
        if (!job.title) return err(res, 422, "No job title was found on this page. Type one in, then save.", "invalid", undefined, "title");
        let row = existing;
        const created = !row;
        if (!row) { row = { id: state.nextJob++, ws: w, url: stored }; state.jobs.push(row); }
        Object.assign(row, job, { url: stored });
        return send(res, created ? 201 : 200, { job_id: row.id, created, title: row.title, company: row.company || "", link: `/job.html?id=${row.id}&ws=${w}`,
          // "excluded_reason": only for the plain test page; null otherwise (older servers omit the field)
          excluded_reason: /job-plain/.test(body.url || "") ? "Your search excludes jobs located in Hamburg." : null });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/jobs/batch") {
        if (state.mode === "oldapi") return err(res, 403, "Not available with an extension key.", "token_scope");
        const bad = validateList(body, Buffer.byteLength(raw));
        if (bad) return err(res, bad[0], bad[1], bad[2], undefined, bad[3]);
        const out = [];
        let added = 0;
        for (const job of body.jobs) {
          const stored = storedUrl({ url: new URL(job.url, body.url).href });
          let row = state.jobs.find((j) => j.url === stored && j.ws === w);
          const created = !row;
          if (!row) { row = { id: state.nextJob++, ws: w, ...job, url: stored, listed: true }; state.jobs.push(row); added++; } // an existing job is left as it is
          out.push({ url: stored, job_id: row.id, created, title: row.title, company: row.company || "", link: `/job.html?id=${row.id}&ws=${w}`,
            // "excluded_reason": only for jobs in Hamburg (see the plain test page)
            excluded_reason: created && /Hamburg/.test(row.location_text || "") ? "Your search excludes jobs located in Hamburg." : null });
        }
        return send(res, 200, { added, existing: body.jobs.length - added, jobs: out });
      }
      if (req.method === "GET" && url.pathname === "/api/sources") return send(res, 200, state.sources.filter((s) => s.ws === w));
      if (req.method === "POST" && url.pathname === "/api/sources") {
        if (!/^https?:\/\//.test(body.url || "")) return err(res, 422, "That is not a valid web address.");
        if (state.sources.some((s) => s.url === body.url && s.ws === w)) return err(res, 409, "This URL is already a source.");
        const s = { id: state.nextSource++, ws: w, label: body.label || "", url: body.url, enabled: true, last_run: null, last_count: null, last_error: null, last_method: null };
        state.sources.push(s);
        return send(res, 201, s);
      }
      const t = /^\/api\/sources\/(\d+)\/test$/.exec(url.pathname);
      if (req.method === "POST" && t) {
        const s = state.sources.find((x) => x.id === Number(t[1]) && x.ws === w);
        if (!s) return err(res, 404, "Source not found.");
        if (/fail/.test(s.url)) return send(res, 200, { ok: false, error: "The page could not be fetched (HTTP 403).", notes: ["robots.txt allows crawling."] });
        return send(res, 200, { ok: true, method: "links", count: 14, sample: [{ title: "Senior Analyst", location: "Berlin", url: s.url + "#1" }, { title: "Data Engineer", location: "Hamburg", url: s.url + "#2" }, { title: "Designer", location: "", url: s.url + "#3" }], notes: ["14 links looked like postings."] });
      }
      if (url.pathname.startsWith("/api/extension/keys")) return err(res, 403, "Not available with an extension key.", "token_scope");
      return err(res, 404, "Not Found");
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, state, port: server.address().port, url: `http://${host}:${server.address().port}`, key: KEY, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

module.exports = { createMock, KEY, readPage };
if (require.main === module) createMock({ port: Number(process.env.PORT || 8000) }).then((m) => console.log(`mock JobHuntPA on ${m.url}\nkey ${m.key}`));
