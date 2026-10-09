// Minimal JobHuntPA stand-in implementing the extension API contract (v1). Also serves ./pages for the tests.
const http = require("http");
const fs = require("fs");
const path = require("path");

const KEY = "jhpa_" + "A".repeat(43);
const WORKSPACES = [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }];

function createMock({ port = 0, host = "127.0.0.1" } = {}) {
  const state = { mode: "ok", jobs: [], sources: [], log: [], nextJob: 12, nextSource: 5 };
  const send = (res, status, body, headers = {}) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
    res.end(data);
  };
  const err = (res, status, detail, code, headers, field) => send(res, status, { detail, ...(code ? { code } : {}), ...(field ? { field } : {}) }, headers);

  function readJobLd(html) {
    const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    if (!m) return null;
    try {
      const d = JSON.parse(m[1]);
      if (d["@type"] !== "JobPosting") return null;
      const a = d.jobLocation?.address || {};
      const v = d.baseSalary?.value || {};
      return {
        title: d.title, company: d.hiringOrganization?.name || "",
        location_text: [a.addressLocality, a.addressCountry].filter(Boolean).join(", "),
        salary_text: v.minValue ? `${v.minValue}-${v.maxValue} ${d.baseSalary.currency}` : "",
        employment_type: d.employmentType || "", work_mode: d.jobLocationType === "TELECOMMUTE" ? "remote" : "unknown",
        description: d.description.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      };
    } catch { return null; }
  }
  function readPlain(b) {
    const title = (/<h1[^>]*>(.*?)<\/h1>/.exec(b.html || "") || [])[1] || (b.page_title || "").split(/ [|-] /)[0];
    const company = (/<h2[^>]*>(.*?)<\/h2>/.exec(b.html || "") || [])[1] || "";
    return { title, company, location_text: "", salary_text: "", employment_type: "", work_mode: /hybrid/i.test(b.text) ? "hybrid" : "unknown", description: (b.text || "").trim() };
  }
  function build(b) {
    const ld = readJobLd(b.html || "");
    const base = ld || readPlain(b);
    const desc = b.selection ? b.selection : base.description;
    const notes = b.selection ? ["Selected text will be used as the description."] : [];
    if (!ld) notes.push("No structured job data found; read the page text.");
    return { method: ld ? "jsonld" : "page", base, desc, descFrom: b.selection ? "selection" : ld ? "structured" : "page", notes };
  }
  const ws = (req) => Number(req.headers["x-workspace"] || 1);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname.startsWith("/pages/")) {
      const f = path.join(__dirname, "pages", path.basename(url.pathname));
      return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f, "utf8")) : send(res, 404, "nope");
    }
    if (url.pathname === "/__control") { state.mode = url.searchParams.get("mode") || "ok"; return send(res, 200, { mode: state.mode }); }
    if (url.pathname === "/__state") return send(res, 200, { jobs: state.jobs, sources: state.sources, log: state.log });
    if (url.pathname === "/__reset") { state.jobs = []; state.sources = []; state.log = []; state.mode = "ok"; return send(res, 200, { ok: true }); }

    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return err(res, 422, "Invalid JSON."); }
      state.log.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || "", workspace: req.headers["x-workspace"] || "", cookie: req.headers.cookie || "", origin: req.headers.origin || "", body });
      if (!url.pathname.startsWith("/api/")) return err(res, 404, "Not Found");
      if (req.headers.authorization !== `Bearer ${KEY}` || state.mode === "revoked") return err(res, 401, "This extension key is not valid.", "token_invalid");
      if (state.mode === "busy") return err(res, 423, "The server is encrypting your data. Try again in a few minutes.", "encrypting");
      if (state.mode === "rate") return err(res, 429, "Too many tries with keys that don't work. Try again in 7 seconds.", "rate_limited", { "Retry-After": "7" });
      const w = ws(req);
      if (url.pathname !== "/api/extension/status" && !WORKSPACES.some((x) => x.id === w)) return err(res, 404, "Workspace not found.");

      if (req.method === "GET" && url.pathname === "/api/extension/status")
        return send(res, 200, { ok: true, api: 1, app_version: "1.13.0", label: "Test browser", expires_at: "2027-10-09T12:00:00Z", workspaces: WORKSPACES, default_workspace: 1 });
      if (req.method === "POST" && url.pathname === "/api/extension/preview") {
        const b = build(body);
        if (!b.base.title && !(body.fields || {}).title) return err(res, 422, "No job title was found on this page. Type one in, then save.", "invalid", undefined, "title");
        const ex = state.jobs.find((j) => j.url === body.url && j.ws === w);
        return send(res, 200, {
          method: b.method,
          job: { ...b.base, posted_at: "", url: body.url, description_preview: b.desc.slice(0, 1500), description_chars: b.desc.length, description_from: b.descFrom },
          existing: ex ? { id: ex.id, title: ex.title, status: "to_review", link: `/job.html?id=${ex.id}&ws=${w}` } : null,
          notes: b.notes,
        });
      }
      if (req.method === "POST" && url.pathname === "/api/extension/jobs") {
        const b = build(body);
        const f = body.fields || {};
        const merged = { ...b.base, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) };
        if (!merged.title) return err(res, 422, "No job title was found on this page. Type one in, then save.", "invalid", undefined, "title");
        let job = state.jobs.find((j) => j.url === body.url && j.ws === w);
        const created = !job;
        if (!job) { job = { id: state.nextJob++, ws: w, url: body.url }; state.jobs.push(job); }
        Object.assign(job, merged);
        return send(res, created ? 201 : 200, { job_id: job.id, created, title: job.title, company: job.company, link: `/job.html?id=${job.id}&ws=${w}` });
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

module.exports = { createMock, KEY };
if (require.main === module) createMock({ port: Number(process.env.PORT || 8000) }).then((m) => console.log(`mock JobHuntPA on ${m.url}\nkey ${m.key}`));
