// Minimal JobHuntPA stand-in implementing the extension API contract (Part 8 of the app's docs/design/open-source.md,
// "api": 3): the extension reads the page, the server gets only a finished job; api 2: a page of search results as a
// list of jobs, which only adds; api 3: working a page out from its outline (POST /api/extension/work-out, the AI's
// answers stood in by fixed mappings), the account's saved job-site mappings, sources with a careers mapping.
// The outline and every mapping are checked as strictly as the app checks them. Also serves ./pages for the tests.
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

// ---- api 3: the page outline (Part 8, 8.6), checked as backend/mapping_format.py check_outline checks it ----
const OUTLINE = { bytes: 200000, elements: 2000, depth: 60, text: 100, attrValue: 200, attrs: 12, title: 300 };
const KEPT_ATTRIBUTES = new Set(["id", "class", "role", "itemprop", "itemtype", "itemscope", "aria-label", "href", "datetime", "title", "data-testid", "data-test", "data-qa", "data-automation", "data-cy"]);
const LEFT_OUT_TAGS = new Set(["script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "head"]);
const FORM_FIELDS = new Set(["input", "textarea", "select", "option"]);
const TAG = /^[a-z][a-z0-9-]{0,39}$/;
const pyLen = (s) => [...s].length; // Python counts code points
/** null when the outline is in the contract, else [status, detail, code]. Also {elements, depth}. */
function checkOutline(data) {
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some((k) => k !== "title" && k !== "root") || !("root" in data)) return { bad: [422, "Send the page outline as {title, root}.", "invalid"] };
  const title = data.title == null ? "" : data.title;
  if (typeof title !== "string" || pyLen(title) > OUTLINE.title) return { bad: [422, "The page title must be text of at most 300 characters.", "invalid"] };
  let count = 0, deepest = 0;
  const stack = [[data.root, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    count++;
    deepest = Math.max(deepest, depth);
    if (count > OUTLINE.elements) return { bad: [413, "This page is too big to work out: the outline may hold at most 2,000 elements.", "outline_too_large"] };
    if (depth > OUTLINE.depth) return { bad: [413, "This page is too big to work out: the outline may be at most 60 elements deep.", "outline_too_large"] };
    if (!node || typeof node !== "object" || Array.isArray(node) || Object.keys(node).some((k) => !["tag", "attrs", "text", "children"].includes(k))) return { bad: [422, "Each element of the outline must be {tag, attrs, text, children}.", "invalid"] };
    if (typeof node.tag !== "string" || !TAG.test(node.tag)) return { bad: [422, "An element of the outline has no name, or one that isn't an element's name.", "invalid"] };
    if (LEFT_OUT_TAGS.has(node.tag)) return { bad: [422, "The outline holds a script, a style, a frame or a part of the page's head, which are never sent.", "invalid"] };
    const attrs = node.attrs == null ? {} : node.attrs;
    if (!attrs || typeof attrs !== "object" || Array.isArray(attrs) || Object.keys(attrs).length > OUTLINE.attrs) return { bad: [422, "An element of the outline may have at most 12 attributes, as an object.", "invalid"] };
    for (const [k, v] of Object.entries(attrs)) {
      if (!KEPT_ATTRIBUTES.has(k)) return { bad: [422, `An element of the outline has an attribute that is never sent (${k}).`, "invalid"] };
      if (typeof v !== "string" || pyLen(v) > OUTLINE.attrValue) return { bad: [422, "An attribute's value must be text of at most 200 characters.", "invalid"] };
    }
    const text = node.text == null ? "" : node.text;
    if (typeof text !== "string" || pyLen(text) > OUTLINE.text) return { bad: [422, "An element's text sample must be text of at most 100 characters.", "invalid"] };
    if (FORM_FIELDS.has(node.tag) && text.trim()) return { bad: [422, "A form field's text is never sent.", "invalid"] };
    const children = node.children == null ? [] : node.children;
    if (!Array.isArray(children)) return { bad: [422, "An element's children must be a list.", "invalid"] };
    for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], depth + 1]);
  }
  return { bad: null, elements: count, depth: deepest };
}

// ---- api 3: mappings (Part 8, 8.7), the shape the app checks (character set, length, fields; not the cost limits) ----
const FIELDS = {
  job: ["title", "company", "location", "salary", "employment_type", "work_mode", "date", "description"],
  careers: ["list", "title", "link", "location", "salary", "employment_type", "work_mode", "date"],
};
const REQUIRED = { job: ["title", "description"], careers: ["list", "title", "link"] };
const SELECTOR_CHARS = /^[A-Za-z0-9 _#.:>+~*[\]=^$|"'(),/?&%-]+$/;
const FORBIDDEN = /javascript\s*:|vbscript\s*:|livescript\s*:|url\s*\(|expression\s*\(|@import|\/\*|\*\//i;
/** The mapping in the app's checked shape (version, kind, fields in order), or null. */
function checkMapping(m, kind) {
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).some((k) => !["version", "kind", "fields"].includes(k))) return null;
  if ((m.version ?? 1) !== 1 || m.kind !== kind) return null;
  const f = m.fields;
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const out = {};
  for (const [name, spec] of Object.entries(f)) {
    if (!FIELDS[kind].includes(name)) return null;
    if (spec === null) continue;
    if (!spec || typeof spec !== "object" || Object.keys(spec).some((k) => k !== "selector" && k !== "attribute")) return null;
    const sel = typeof spec.selector === "string" ? spec.selector.trim() : "";
    const scopeOk = kind === "careers" && name !== "list";
    if (!sel || sel.length > 300 || (sel === ":scope" ? !scopeOk : !SELECTOR_CHARS.test(sel) || FORBIDDEN.test(sel))) return null;
    let attr = spec.attribute == null ? "" : spec.attribute;
    if (typeof attr !== "string") return null;
    attr = attr.trim().toLowerCase();
    if (attr && (!/^[a-z][a-z0-9_-]{0,39}$/.test(attr) || /^on[a-z]/.test(attr))) return null;
    if (name === "list" && attr) return null;
    out[name] = attr ? { selector: sel, attribute: attr } : { selector: sel };
  }
  if (REQUIRED[kind].some((n) => !out[n])) return null;
  const fields = {};
  for (const n of FIELDS[kind]) if (out[n]) fields[n] = out[n];
  return { version: 1, kind, fields };
}
/** The site of a host name or an http(s) address (Part 8, 8.8), or null. */
function siteOf(value) {
  let h = String(value || "").trim();
  if (h.includes("://")) { try { const u = new URL(h); if (!/^https?:$/.test(u.protocol)) return null; h = u.hostname; } catch { return null; } }
  h = h.replace(/\.$/, "").toLowerCase();
  if (h.startsWith("www.")) h = h.slice(4);
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(h) ? h : null;
}

// The AI's answers, stood in by fixed mappings: by the page's address. JOB_SITE_MAPPING is the one for
// tests/pages/job-mapped.html (also PUT on a real server by tests/e2e.cjs).
const JOB_SITE_FIELDS = { title: { selector: "h1.jt-title" }, company: { selector: ".jt-company" }, location: { selector: "[data-qa=\"job-location\"]" }, salary: { selector: "span.jt-pay" }, employment_type: { selector: ".jt-meta > .jt-type" }, work_mode: { selector: ".jt-mode" }, date: { selector: "time.posted", attribute: "datetime" }, description: { selector: "#jt-body" } };
const JOB_SITE_MAPPING = { version: 1, kind: "job", fields: JOB_SITE_FIELDS };
const JOB_ANSWERS = [
  [/^https:\/\/jobs\.example\.org\//, JOB_SITE_FIELDS],
  [/outline-/, { title: { selector: "h1" }, company: null, description: { selector: "main" } }],
  [/job-huge/, { title: { selector: "h1" }, description: { selector: "#desc" } }],
];
const CAREERS_ANSWERS = [
  [/^https:\/\/careers\.acme\.example\//, { worked_out: true, mapping: { list: { selector: "ul.openings > li" }, title: { selector: ".role" }, link: { selector: "a", attribute: "href" }, location: { selector: ".where" } },
    test: { ok: true, method: "careers page read with its worked-out layout (careers.acme.example)", count: 3, sample: [{ title: "Senior Analyst", location: "Sydney NSW", url: "https://careers.acme.example/o/a1" }, { title: "Data Engineer", location: "Remote", url: "https://careers.acme.example/o/a2" }, { title: "Designer", location: "", url: "https://careers.acme.example/o/a3" }], notes: [] } }],
  [/^https:\/\/careers\.empty\.example\//, { worked_out: true, mapping: { list: { selector: "div.x" }, title: { selector: ":scope" }, link: { selector: "a" } },
    test: { ok: false, error: "no job postings found with the careers page's worked-out layout", notes: ["the layout found no job entries"] } }],
  [/careers\.html$/, { worked_out: false, mapping: null, test: { ok: true, method: "links", count: 2, sample: [{ title: "Senior Analyst", location: "", url: "/pages/job-ld.html" }, { title: "Data Engineer", location: "", url: "/pages/job-plain.html" }], notes: ["2 links looked like postings."] } }],
];
const WORKSPACES = [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }];

function createMock({ port = 0, host = "127.0.0.1" } = {}) {
  const state = { mode: "ok", jobs: [], sources: [], log: [], violations: [], nextJob: 12, nextSource: 5, mappings: {}, workOuts: [] };
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
    if (url.pathname === "/__state") return send(res, 200, { jobs: state.jobs, sources: state.sources, log: state.log, violations: state.violations, mappings: state.mappings, workOuts: state.workOuts });
    if (url.pathname === "/__reset") { state.jobs = []; state.sources = []; state.log = []; state.violations = []; state.mode = "ok"; state.mappings = {}; state.workOuts = []; return send(res, 200, { ok: true }); }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      const bytes = Buffer.byteLength(raw);
      // the work-out's cap is looked at before anything is parsed (the app reads at most 200,000 bytes)
      if (req.method === "POST" && url.pathname === "/api/extension/work-out" && bytes > OUTLINE.bytes) {
        state.violations.push(`work-out request of ${bytes} bytes`);
        state.log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || "", workspace: req.headers["x-workspace"] || "", cookie: "", origin: "", bytes, body: null });
        return err(res, 413, "This page is too big to work out: at most 200,000 bytes of outline can be sent.", "outline_too_large", undefined, "outline");
      }
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
        // "api2": a server from before AI mappings
        return send(res, 200, { ok: true, api: state.mode === "oldapi" ? 1 : state.mode === "api2" ? 2 : 3, app_version: "1.13.0", label: "Test browser", expires_at: "2027-10-09T12:00:00Z", workspaces: state.mode === "wsgone" ? WORKSPACES.slice(1) : WORKSPACES, default_workspace: state.mode === "wsgone" ? 3 : 1 });
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
      const api3 = /^\/api\/extension\/(work-out|mappings)(\/|$)/.test(url.pathname);
      if (api3 && (state.mode === "oldapi" || state.mode === "api2")) return err(res, 403, "Not available with an extension key.", "token_scope");

      // ---- api 3: working a page out ----
      if (req.method === "POST" && url.pathname === "/api/extension/work-out") {
        for (const k of Object.keys(body)) if (!["kind", "url", "outline"].includes(k)) return err(res, 422, `JobHuntPA doesn't know the value "${k}".`, "invalid", undefined, k);
        if (!["job", "careers"].includes(body.kind)) return err(res, 422, 'Say what kind of page it is: "job" or "careers".', "invalid", undefined, "kind");
        if (typeof body.url !== "string" || body.url.length > 2048 || !/^https?:\/\//i.test(body.url)) return err(res, 422, "Only pages with an http:// or https:// address can be worked out.", "invalid", undefined, "url");
        if (body.kind === "careers" && state.mode === "refuse") return err(res, 422, "This address can't be a source: It is a name for your local network or this computer, not a public website.", "refused_address", undefined, "url");
        if (!siteOf(body.url)) return err(res, 422, "This page's address has no site name JobHuntPA can use, so it can't be worked out.", "invalid", undefined, "url");
        const checked = checkOutline(body.outline);
        if (checked.bad) { state.violations.push(`outline refused: ${checked.bad[1]}`); return err(res, checked.bad[0], checked.bad[1], checked.bad[2], undefined, "outline"); }
        state.workOuts.push({ kind: body.kind, url: body.url, bytes, elements: checked.elements, depth: checked.depth, ws: w });
        const answer = () => {
          if (state.mode === "aibusy") return err(res, 429, "JobHuntPA is already working out a page for you. Try again when it has finished.", "busy", { "Retry-After": "5" });
          if (state.mode === "timedout") return err(res, 504, "JobHuntPA took more than 10 minutes working this page out, so it stopped. Try again later; a page that keeps taking this long can't be worked out.", "timed_out");
          const noAi = () => err(res, 400, "Working out a page needs the AI. Set up an AI provider in Settings.", "ai_not_set_up");
          const site = siteOf(body.url);
          if (body.kind === "job") {
            if (state.mode === "noai") return noAi();
            if (state.mode === "aifail") return err(res, 502, "The AI service didn't answer. Check its settings in JobHuntPA, or try again later.", "ai_failed");
            const hit = JOB_ANSWERS.find(([re]) => re.test(body.url));
            if (!hit || state.mode === "notworked") return err(res, 422, "JobHuntPA couldn't work out this site: the AI didn't answer with a page layout it can use. Try again, or type the job's details in.", "not_worked_out");
            const mapping = checkMapping({ kind: "job", fields: hit[1] }, "job");
            // "hostile": an answer not in the shape of 8.7 (another top-level key); "oddsite": a site that isn't one
            if (state.mode === "hostile") return send(res, 200, { site: "../../api/sources", kind: "job", worked_out: true, mapping: { ...mapping, evil: "x" } });
            if (state.mode === "oddsite") return send(res, 200, { site: "../../api/sources", kind: "job", worked_out: true, mapping });
            return send(res, 200, { site, kind: "job", worked_out: true, mapping });
          }
          const hit = CAREERS_ANSWERS.find(([re]) => re.test(body.url));
          if (!hit) return send(res, 200, { site, kind: "careers", url: body.url, worked_out: false, mapping: null, test: { ok: false, error: "The page could not be fetched (HTTP 403).", notes: [] } });
          const a = hit[1];
          if (a.worked_out && state.mode === "noai") return noAi();
          return send(res, 200, { site, kind: "careers", url: body.url, worked_out: a.worked_out, mapping: a.mapping ? checkMapping({ kind: "careers", fields: a.mapping }, "careers") : null, test: a.test });
        };
        return state.mode === "slow" ? setTimeout(answer, 1500) : answer();
      }

      // ---- api 3: the account's saved job-site mappings ----
      if (url.pathname === "/api/extension/mappings" && req.method === "GET") {
        const list = Object.keys(state.mappings).sort().map((site) => ({ site, fields: Object.keys(state.mappings[site].mapping.fields), updated_at: state.mappings[site].updated_at }));
        return send(res, 200, { mappings: list, max: 500 });
      }
      const ms = /^\/api\/extension\/mappings\/(.*)$/.exec(url.pathname);
      if (ms) {
        const rawSite = decodeURIComponent(ms[1]);
        if (!/^[A-Za-z0-9.-]{1,253}$/.test(rawSite)) return err(res, 403, "Not available with an extension key.", "token_scope");
        const site = siteOf(rawSite);
        if (!site) return err(res, 422, "That isn't a site's name (a host name such as jobs.example.com).", "invalid", undefined, "site");
        const row = state.mappings[site];
        if (req.method === "GET") return row ? send(res, 200, { site, mapping: row.mapping, updated_at: row.updated_at }) : err(res, 404, "No layout is saved for this site.", "not_found");
        if (req.method === "DELETE") { if (!row) return err(res, 404, "No layout is saved for this site.", "not_found"); delete state.mappings[site]; return send(res, 200, { ok: true }); }
        if (req.method === "PUT") {
          if (bytes > 16 * 1024) return err(res, 413, "This mapping is too big.", "too_large");
          if (!body || typeof body !== "object" || Object.keys(body).join(",") !== "mapping") return err(res, 422, "Send {mapping}.", "invalid", undefined, "mapping");
          const m = checkMapping(body.mapping, "job");
          if (!m) { state.violations.push("PUT of a mapping not in the shape of 8.7"); return err(res, 422, "The page layout can't be used: It isn't a mapping JobHuntPA can use.", "invalid_mapping", undefined, "mapping"); }
          // "toomany": the account already has the 500 saved layouts the app keeps (Part 8, 8.2 and 8.8)
          if (!row && state.mode === "toomany") return err(res, 409, "You have saved 500 sites' layouts, the most there can be. Forget some you no longer use (Settings).", "too_many_mappings");
          const updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
          state.mappings[site] = { mapping: m, updated_at };
          return send(res, row ? 200 : 201, { site, mapping: m, updated_at, created: !row });
        }
        return err(res, 405, "Method Not Allowed");
      }

      if (req.method === "GET" && url.pathname === "/api/sources") return send(res, 200, state.sources.filter((s) => s.ws === w));
      if (req.method === "POST" && url.pathname === "/api/sources") {
        for (const k of Object.keys(body)) if (!["url", "label", "mapping"].includes(k)) return err(res, 422, `Unknown field ${k}.`, "invalid", undefined, k);
        if (!/^https?:\/\//.test(body.url || "")) return err(res, 422, "Not a valid URL: " + String(body.url || "").slice(0, 80));
        if (state.mode === "refuse") return err(res, 422, "This address can't be a source: It is a name for your local network or this computer, not a public website.", "refused_address", undefined, "url");
        let mapping = null;
        if (body.mapping != null) {
          mapping = checkMapping(body.mapping, "careers");
          if (!mapping) { state.violations.push("POST /api/sources with a mapping not in the shape of 8.7"); return err(res, 422, "The page layout can't be used: It isn't a mapping JobHuntPA can use.", "invalid_mapping", undefined, "mapping"); }
        }
        const had = state.sources.find((s) => s.url === body.url && s.ws === w);
        if (had && mapping) { had.mapping = mapping; return send(res, 200, { ...had, updated: true }); }
        if (had) return err(res, 409, "That URL is already a source");
        const s = { id: state.nextSource++, ws: w, label: body.label || "", url: body.url, enabled: true, last_run: null, last_count: null, last_error: null, last_method: null, mapping };
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

module.exports = { createMock, KEY, readPage, checkOutline, checkMapping, siteOf, JOB_SITE_MAPPING };
if (require.main === module) createMock({ port: Number(process.env.PORT || 8000) }).then((m) => console.log(`mock JobHuntPA on ${m.url}\nkey ${m.key}`));
