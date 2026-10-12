// End-to-end test: real Chromium + the unpacked extension against the mock server (default)
// or a real JobHuntPA server. See tests/README.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");
const { createMock, readPage } = require("./mock-server.cjs");

const REAL = !!process.env.JHPA_SERVER;
const EXT_SRC = path.resolve(__dirname, "..");
const OUT = path.join(__dirname, "out");
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`);
  if (!ok) failures++;
};
const eq = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

function copyExtension(dest, hosts) {
  fs.cpSync(EXT_SRC, dest, { recursive: true, filter: (p) => !/[\\/](tests|\.git|scripts|node_modules)([\\/]|$)/.test(p.slice(EXT_SRC.length)) });
  const mf = JSON.parse(fs.readFileSync(path.join(dest, "manifest.json"), "utf8"));
  // Headless Chromium cannot answer the permission prompt, so the test copy pre-grants the server hosts.
  mf.host_permissions = hosts;
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify(mf, null, 2));
}

// Static server for the test pages when running against a real JobHuntPA (the mock serves them itself).
function pagesServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const html = readPage(path.basename(req.url.split("?")[0]));
      if (html != null) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); }
      else { res.writeHead(404); res.end("no"); }
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

// Real mode with JHPA_EMAIL / JHPA_PASSWORD: a cookie session on the same server, used to read back what the extension
// saved (GET /api/jobs, /api/jobs/{id}) and to make and revoke a key.
async function signIn(serverUrl) {
  const email = process.env.JHPA_EMAIL, password = process.env.JHPA_PASSWORD;
  if (!email || !password) return null;
  const r = await fetch(`${serverUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`sign-in failed: ${r.status}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const csrf = (await r.json()).csrf;
  const call = async (method, p, body) => {
    const res = await fetch(`${serverUrl}${p}`, { method, headers: { cookie, "X-CSRF-Token": csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b || {}), del: (p) => call("DELETE", p) };
}

(async () => {
  const mock = REAL ? null : await createMock();
  const pages = REAL ? await pagesServer() : null;
  const serverUrl = REAL ? process.env.JHPA_SERVER.replace(/\/+$/, "") : mock.url;
  const key = REAL ? process.env.JHPA_KEY : mock.key;
  const pagesUrl = REAL ? pages.url : mock.url;
  if (!key) throw new Error("JHPA_KEY is required with JHPA_SERVER");
  const api = REAL ? await signIn(serverUrl) : null;
  const serverHost = new URL(serverUrl).hostname;
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "jhpa-ext-"));
  copyExtension(extDir, [`http://${serverHost}/*`, `https://${serverHost}/*`, "http://127.0.0.1/*", "http://localhost/*", "https://www.seek.com.au/*", "https://au.seek.com/*", "https://boards.greenhouse.io/*"]);

  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), "jhpa-prof-")), {
    executablePath: process.env.CHROME_BIN || undefined,
    headless: false,
    args: ["--headless=new", "--no-sandbox", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
    viewport: { width: 420, height: 700 },
  });
  const problems = [];
  const watch = (p) => {
    p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_/.test(m.text())) problems.push(`console: ${m.text()}`); });
  };
  ctx.on("page", watch);
  const posted = []; // what the extension POSTed to the server (real mode; the mock keeps its own log)
  ctx.on("request", (r) => {
    if (r.method() === "POST" && r.url().startsWith(serverUrl) && /extension\/(preview|jobs)$/.test(r.url())) posted.push({ path: r.url().slice(serverUrl.length), raw: r.postData() || "" });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const base = `chrome-extension://${extId}`;
  console.log(`extension ${extId}, server ${serverUrl} (${REAL ? "real" : "mock"})`);
  for (const p of ctx.pages()) if (p.url().includes("options")) await p.close(); // opened on install

  const seenBodies = [], seenViolations = []; // kept across resets, for the final checks
  const reset = async () => {
    if (!mock) return;
    const st0 = await (await fetch(`${mock.url}/__state`)).json();
    seenBodies.push(...st0.log.filter((x) => /extension\/(preview|jobs)$/.test(x.path)));
    seenViolations.push(...st0.violations);
    await fetch(`${mock.url}/__reset`);
  };
  const mode = async (m) => { if (mock) await fetch(`${mock.url}/__control?mode=${m}`); };
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

  // ---- Options: connect flow ----
  let opt = await ctx.newPage();
  await opt.goto(`${base}/options/options.html`);
  await opt.fill("#server", serverUrl.replace(/^http:\/\//, "")); // scheme omitted on purpose
  await opt.fill("#key", "not-a-key");
  await opt.click("#connect");
  check("options rejects a malformed key", /does not look like an extension key/.test(await opt.textContent("#status")));
  await opt.fill("#key", key);
  eq("key field is a password field", await opt.getAttribute("#key", "type"), "password");
  await opt.click("#toggle-key");
  eq("show/hide reveals the key", await opt.getAttribute("#key", "type"), "text");
  await opt.click("#toggle-key");
  await opt.click("#connect");
  await opt.waitForSelector("#status.ok");
  check("options shows connected", /Connected to/.test(await opt.textContent("#status")), await opt.textContent("#status"));
  let st = await storage();
  eq("server stored normalised", st.server, serverUrl);
  eq("key stored in storage.local", st.key, key);
  check("workspaces stored", Array.isArray(st.workspaces) && st.workspaces.length >= 1);
  if (!REAL) {
    eq("workspace dropdown filled", await opt.locator("#workspace option").count(), 2);
    const l = (await (await fetch(`${mock.url}/__state`)).json()).log.find((x) => x.path === "/api/extension/status");
    eq("status request: bearer key", l.auth, `Bearer ${key}`);
    eq("status request: no cookies", l.cookie, "");
  }
  await opt.screenshot({ path: path.join(OUT, "options.png") });

  // Opens the popup page in a background tab of the same window as `target`, so that
  // tabs.query({active, currentWindow}) inside the popup returns `target` (as it does for the real popup).
  async function openPopup(target) {
    const popup = await ctx.newPage();
    await target.bringToFront();
    await popup.goto(`${base}/popup/popup.html`);
    return popup;
  }
  // The form shows as soon as the extension has read the page; "ready" also waits for the "already there?" check.
  const ready = async (pp, timeout = 20000) => {
    await pp.waitForSelector("#job-form:not(.hidden)", { timeout });
    await pp.waitForSelector("#job-save:not([disabled])", { timeout });
  };
  const state = async () => (await fetch(`${mock.url}/__state`)).json();
  const lastBody = async (re = /preview$/) => { const l = (await state()).log.filter((x) => re.test(x.path)); return l[l.length - 1]; };
  const HTML_TAG = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;
  const sizes = [];
  // SEEK lives at au.seek.com (www.seek.com.au redirects there): answer those addresses from the test page files (no network involved)
  await ctx.route(/^https:\/\/au\.seek\.com\/job\/12345678/, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readPage("job-seek.html") }));
  await ctx.route("https://www.seek.com.au/job/12345678", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readPage("job-seek.html") }));
  await ctx.route("https://boards.greenhouse.io/acme-corp/jobs/4242", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readPage("job-nocompany.html") }));
  await ctx.route(/^https:\/\/au\.seek\.com\/product-manager-jobs/, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: readPage("results-seek.html") }));
  const newJobTab = async (p) => { const t = await ctx.newPage(); await t.goto(/^https:/.test(p) ? p : `${pagesUrl}/pages/${p}`); return t; };

  // ---- Job from a page with JSON-LD ----
  await reset();
  const ldTab = await newJobTab("job-ld.html");
  let popup = await openPopup(ldTab);
  await ready(popup);
  eq("preview: title", await popup.inputValue("#f-title"), "Senior Analyst");
  eq("preview: company", await popup.inputValue("#f-company"), REAL ? await popup.inputValue("#f-company") : "Example Corp");
  check("preview: description present", (await popup.inputValue("#f-desc")).length > 20);
  check("popup shows the page url", (await popup.textContent("#page-url")).includes("job-ld.html"));
  check("a job page has no \"Jobs on this page\" tab", (await popup.locator("#tab-list.hidden").count()) === 1);
  await popup.screenshot({ path: path.join(OUT, "popup-job.png") });
  eq("form: location from the address parts", await popup.inputValue("#f-location"), "Berlin, BE, DE");
  eq("form: salary from baseSalary", await popup.inputValue("#f-salary"), "EUR 60,000–75,000 per year");
  eq("form: employment type", await popup.inputValue("#f-type"), "Full time");
  eq("form: TELECOMMUTE is remote", await popup.inputValue("#f-mode"), "remote");
  const descPreview = await popup.inputValue("#f-desc");
  check("form: JSON-LD description shown as text with list items", descPreview.includes("reporting stack & work") && descPreview.includes("- SQL\n- Python") && !HTML_TAG.test(descPreview), descPreview);
  check("form: says where the description came from", /from the page's job data/.test(await popup.textContent("#desc-label")), await popup.textContent("#desc-label"));
  if (!REAL) {
    const req = await lastBody();
    const j = req.body.job;
    eq("preview body: only url and job", Object.keys(req.body).join(","), "url,job");
    check("preview body: no html/text/fields", !("html" in req.body) && !("text" in req.body) && !("fields" in req.body) && !("html" in j) && !("text" in j));
    check("preview body: small", req.bytes < 5000, String(req.bytes));
    sizes.push(["JSON-LD page", req.bytes]);
    check("preview body: job values", j.title === "Senior Analyst" && j.company === "Example Corp" && j.salary_text === "EUR 60,000–75,000 per year" && j.work_mode === "remote" && j.posted_at === "2026-09-30" && j.method === "jsonld" && j.description_from === "structured", JSON.stringify(j));
    check("preview body: description is plain text", j.description.includes("- SQL\n- Python") && !HTML_TAG.test(j.description), j.description);
    eq("preview: X-Workspace sent", req.workspace, "1");
    eq("preview: no origin/cookie leak", req.cookie, "");
  }
  await popup.fill("#f-title", "Senior Analyst (edited)");
  await popup.selectOption("#f-mode", "hybrid");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  const resultText = await popup.textContent("#job-result");
  check("saved message", (REAL ? /(Saved|Updated)/ : /Saved — Open in JobHuntPA/).test(resultText), resultText);
  if (!REAL) {
    const j = (await (await fetch(`${mock.url}/__state`)).json()).jobs[0];
    eq("edited title was sent", j.title, "Senior Analyst (edited)");
    eq("edited work mode was sent", j.work_mode, "hybrid");
  }
  const [opened] = await Promise.all([ctx.waitForEvent("page"), popup.click("#job-result a")]);
  if (!REAL) {
    check("no excluded note when the field is null", !/exclude/.test(resultText) && (await popup.locator("#excluded-reason").count()) === 0, resultText);
  }
  check("link opens the configured server origin", opened.url().startsWith(serverUrl) || (await opened.waitForURL(/./).then(() => opened.url().startsWith(serverUrl))), opened.url());
  await opened.close();

  // Same page again -> already exists
  await popup.close();
  popup = await openPopup(ldTab);
  await ready(popup);
  check("existing job is announced", /Already in JobHuntPA/.test(await popup.textContent("#job-existing")));
  eq("button says Update", await popup.textContent("#job-save"), "Update job");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  check("update message", /Updated the existing job/.test(await popup.textContent("#job-result")));

  // Selection used as description + "Read page again"
  await ldTab.bringToFront();
  await ldTab.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("sel")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await popup.click("#job-reread");
  await ready(popup);
  check("selection reaches the form", (await popup.inputValue("#f-desc")).includes("Select this sentence"), await popup.inputValue("#f-desc"));
  check("selection: description says it comes from the selected text", /from your selected text/.test(await popup.textContent("#desc-label")), await popup.textContent("#desc-label"));
  check("selection: note shown", /Selected text will be used/.test(await popup.textContent("#job-notes")), await popup.textContent("#job-notes"));
  if (!REAL) {
    const j = (await lastBody()).body.job;
    check("selection: sent as the whole description, nothing else of the page", j.description === "Select this sentence to use it as the description." && j.description_from === "selection", JSON.stringify(j.description));
  }
  await popup.close();

  // ---- Job from a page without structured data ----
  const plainTab = await newJobTab("job-plain.html");
  popup = await openPopup(plainTab);
  await ready(popup);
  eq("plain page: title from the heading", await popup.inputValue("#f-title"), "Data Engineer");
  eq("plain page: work mode from a plain hint in the text", await popup.inputValue("#f-mode"), "hybrid");
  check("plain page: note says values come from the page", /No structured job data/.test(await popup.textContent("#job-notes")), await popup.textContent("#job-notes"));
  check("plain page: description is the page text", /build pipelines/.test(await popup.inputValue("#f-desc")) && /from the page text/.test(await popup.textContent("#desc-label")), await popup.textContent("#desc-label"));
  if (!REAL) {
    const req = await lastBody();
    check("plain page: method page, small body", req.body.job.method === "page" && req.body.job.description_from === "body" && req.bytes < 3000, JSON.stringify(req.body.job));
    sizes.push(["plain page", req.bytes]);
  }
  await popup.fill("#f-company", "Acme Ltd");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  check("plain page saved", /Saved/.test(await popup.textContent("#job-result")));
  if (!REAL) {
    const rt = await popup.textContent("#job-result");
    check("excluded: note says saved but filtered out", /saved, but your search filters exclude it/.test(rt) && /Show excluded/.test(rt), rt);
    eq("excluded: server's reason shown", await popup.textContent("#excluded-reason"), "Your search excludes jobs located in Hamburg.");
    check("excluded: Open link still there", (await popup.locator("#job-result a").count()) === 1);
    check("excluded: inside the live region", (await popup.getAttribute("#job-result", "aria-live")) === "polite");
  }

  // ---- Workspace switch ----
  if (!REAL) {
    await popup.selectOption("#workspace", "3");
    await ready(popup);
    eq("switching workspace re-runs preview (no existing job there)", await popup.textContent("#job-save"), "Save job");
    eq("workspace choice persisted", (await storage()).workspace, 3);
    await popup.selectOption("#workspace", "1");
    await ready(popup);
    eq("switching back finds the job again", await popup.textContent("#job-save"), "Update job");
  }
  await popup.close();

  // ---- No company anywhere on the page: taken from the job board's address ----
  const ghTab = await newJobTab("https://boards.greenhouse.io/acme-corp/jobs/4242");
  popup = await openPopup(ghTab);
  await ready(popup);
  eq("no company: taken from the Greenhouse address", await popup.inputValue("#f-company"), "Acme Corp");
  eq("no company: title", await popup.inputValue("#f-title"), "Site Reliability Engineer");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  check("no company: saved", /Saved|Updated/.test(await popup.textContent("#job-result")), await popup.textContent("#job-result"));
  await popup.close();
  await ghTab.close();

  // ---- JSON-LD inside @graph (with a broken script before it), HTML-encoded description, several locations ----
  const graphTab = await newJobTab("job-graph.html");
  popup = await openPopup(graphTab);
  await ready(popup);
  eq("graph: title", await popup.inputValue("#f-title"), "Platform Engineer");
  eq("graph: company", await popup.inputValue("#f-company"), "Graphly");
  eq("graph: locations joined", await popup.inputValue("#f-location"), "Leeds, GB; Remote, GB");
  eq("graph: single salary value", await popup.inputValue("#f-salary"), "GBP 65,000 per year");
  eq("graph: employment types", await popup.inputValue("#f-type"), "Full time, Contract");
  eq("graph: description of an entity-encoded posting is text", await popup.inputValue("#f-desc"), "Build the platform.\n\nKeep it running.");
  if (REAL) {
    await popup.click("#job-save");
    await popup.waitForSelector("#job-result:not(.hidden)");
    check("graph: saved on the real server", /Saved|Updated/.test(await popup.textContent("#job-result")), await popup.textContent("#job-result"));
  }
  if (!REAL) {
    const req = await lastBody();
    check("graph: body", req.body.job.method === "jsonld" && req.bytes < 3000, JSON.stringify(req.body.job));
    sizes.push(["@graph page", req.bytes]);
  }
  await popup.close();
  await graphTab.close();

  // ---- SEEK-style markup (served for https://au.seek.com/job/12345678, with the parameters SEEK's own links carry) ----
  const seekTab = await newJobTab("https://au.seek.com/job/12345678?type=standard&ref=search-standalone");
  popup = await openPopup(seekTab);
  await ready(popup);
  eq("seek: title from data-automation", await popup.inputValue("#f-title"), "Marketing Coordinator");
  eq("seek: company", await popup.inputValue("#f-company"), "Brightside Pty Ltd");
  eq("seek: location", await popup.inputValue("#f-location"), "Sydney NSW");
  eq("seek: salary", await popup.inputValue("#f-salary"), "$80,000 - $90,000 per year");
  eq("seek: work type", await popup.inputValue("#f-type"), "Full time");
  const seekDesc = await popup.inputValue("#f-desc");
  check("seek: description is the ad's element only (not the sidebar)", seekDesc.includes("Plan campaigns") && seekDesc.includes("Events") && !/Similar jobs/.test(seekDesc), seekDesc);
  check("seek: description from the page's job description", /from the page's job description/.test(await popup.textContent("#desc-label")), await popup.textContent("#desc-label"));
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  if (REAL) check("seek: saved on the real server", /Saved|Updated/.test(await popup.textContent("#job-result")), await popup.textContent("#job-result"));
  if (!REAL) {
    const req = await lastBody(/jobs$/);
    check("seek: body", req.body.job.method === "site" && req.body.url === "https://au.seek.com/job/12345678?type=standard&ref=search-standalone" && req.bytes < 3000, JSON.stringify(req.body));
    sizes.push(["SEEK-style page", req.bytes]);
    check("seek: stored under the address JobHuntPA's searches use, whatever SEEK's own address is", (await state()).jobs.some((j) => j.url === "https://www.seek.com.au/job/12345678" && j.title === "Marketing Coordinator"));
  }
  await popup.close();
  await seekTab.close();

  // ---- A page of search results (SEEK-style job cards, served for https://au.seek.com/product-manager-jobs) ----
  await reset();
  const listReady = (pp) => pp.waitForSelector("#list-save", { state: "visible", timeout: 20000 });
  const ticked = (pp) => pp.locator("#list-jobs input:checked").count();
  const resultsUrl = "https://au.seek.com/product-manager-jobs?tags=new";
  const listTab = await newJobTab(resultsUrl);
  popup = await openPopup(listTab);
  await listReady(popup);
  eq("results: the tab is there and opened", await popup.getAttribute("#tab-list", "aria-selected"), "true");
  if (!REAL) eq("results: opening the popup sends nothing about the page", (await state()).log.map((x) => x.path).join(" "), "/api/extension/status");
  eq("results: the other panels are hidden", await popup.locator("#panel-job.hidden, #panel-source.hidden").count(), 2);
  eq("results: each job once, cards without a title or job number left out", await popup.locator("#list-jobs li").count(), 6);
  eq("results: note", await popup.textContent("#list-note"), "6 jobs found on this page. 3 are marked \u201cNew to you\u201d. Those are ticked.");
  eq("results: the new-to-you jobs are ticked", await ticked(popup), 3);
  eq("results: button says how many", await popup.textContent("#list-save"), "Add 3 jobs");
  const firstRow = await popup.textContent("#list-jobs li:nth-child(1)");
  check("results: a row shows title, employer, place and the card's date line", /Product Manager/.test(firstRow) && /Northwind Software \u00b7 North Sydney, Sydney NSW \u00b7 4d ago \u00b7 Viewed/.test(firstRow), firstRow);
  const secondRow = await popup.textContent("#list-jobs li:nth-child(2)");
  check("results: entities are text, salary shown, badge in words", /Senior Product Owner & Delivery Lead/.test(secondRow) && /\$150,000 – \$170,000 per year/.test(secondRow) && /New to you/.test(secondRow), secondRow);
  eq("results: every tick box has its job as its label", await popup.locator("#list-jobs label input[type=checkbox]").count(), 6);
  await popup.click("#pick-none");
  check("results: nothing ticked, nothing to add", (await ticked(popup)) === 0 && (await popup.isDisabled("#list-save")) && (await popup.textContent("#list-save")) === "Add jobs");
  await popup.click("#pick-new");
  eq("results: tick new to you", await ticked(popup), 3);
  await popup.click("#pick-all");
  eq("results: tick all", await popup.textContent("#list-save"), "Add 6 jobs");
  await popup.uncheck("#list-jobs li:nth-child(6) input");
  eq("results: unticking one job", await popup.textContent("#list-save"), "Add 5 jobs");
  await popup.screenshot({ path: path.join(OUT, "popup-list.png") });
  await popup.click("#list-save");
  await popup.waitForSelector("#list-result:not(.hidden)");
  const listResult = await popup.textContent("#list-result");
  check("results: says what was added", (REAL ? /(Added \d+ jobs?|No new jobs were added)\./ : /^Added 5 jobs\. Open JobHuntPA/).test(listResult), listResult);
  eq("results: added rows can't be sent again", await popup.locator("#list-jobs input:disabled").count(), 5);
  check("results: nothing left to add", (await popup.isDisabled("#list-save")) && (await popup.textContent("#list-save")) === "Add jobs");
  check("results: the answer is in a live region", (await popup.getAttribute("#list-result", "aria-live")) === "polite");
  if (!REAL) {
    const outcomes = await popup.locator("#list-jobs .outcome").allTextContents();
    check("results: each row says what became of it", outcomes.length === 5 && outcomes.filter((t) => t === "Added \u2014 open").length === 4 && outcomes.includes("Added, but your search filters exclude it \u2014 open"), JSON.stringify(outcomes));
    eq("results: filtered-out note", await popup.textContent("#list-excluded"), "Your search filters exclude 1 of the added jobs, so it only shows in JobHuntPA's Jobs list with \u201cShow excluded\u201d ticked.");
    const req = await lastBody(/jobs\/batch$/);
    eq("results: body is the page address and the jobs", Object.keys(req.body).join(","), "url,jobs");
    eq("results: page address", req.body.url, resultsUrl);
    eq("results: only the ticked jobs are sent, each under its address on the page's site", req.body.jobs.map((j) => j.url).join(" "), [1, 2, 3, 4, 5].map((n) => `https://au.seek.com/job/7000000${n}`).join(" "));
    const sentJob = req.body.jobs[0];
    check("results: a job's values", sentJob.title === "Product Manager" && sentJob.company === "Northwind Software" && sentJob.location_text === "North Sydney, Sydney NSW" && sentJob.work_mode === "hybrid" && sentJob.employment_type === "Full time" && sentJob.industry === "Product Management & Development" && /^\d{4}-\d{2}-\d{2}$/.test(sentJob.posted_at), JSON.stringify(sentJob));
    eq("results: a job's summary", sentJob.description, "Own the roadmap of a planning product.\n\n- Flexible work\n- Small team\n- Learning budget\n\nWork type: Full time\nClassification: Product Management & Development, Information & Communication Technology");
    check("results: remote, on-site, contract, several places", req.body.jobs[1].work_mode === "remote" && req.body.jobs[4].work_mode === "onsite" && req.body.jobs[2].employment_type === "Contract/Temp" && !("work_mode" in req.body.jobs[2]) && req.body.jobs[4].location_text === "Hamburg; Perth WA", JSON.stringify(req.body.jobs.map((j) => [j.work_mode, j.employment_type, j.location_text])));
    check("results: only known values, plain text, nothing else of the page", req.body.jobs.every((j) => Object.keys(j).every((k) => ["url", "title", "company", "location_text", "salary_text", "employment_type", "work_mode", "posted_at", "industry", "description"].includes(k)) && Object.values(j).every((v) => typeof v === "string" && !HTML_TAG.test(v))) && !/SECRET-SESSION-TOKEN|private\.person|Private Person|Career advice|SEEK_REDUX_DATA/.test(JSON.stringify(req.body)));
    check("results: small request", req.bytes < 6000, String(req.bytes));
    sizes.push(["page of results (5 jobs)", req.bytes]);
    eq("results: X-Workspace sent", req.workspace, "1");
    eq("results: no cookie", req.cookie, "");
    const saved = (await state()).jobs;
    check("results: stored under the addresses JobHuntPA's searches use", saved.length === 5 && saved.every((j) => /^https:\/\/www\.seek\.com\.au\/job\/7000000[1-5]$/.test(j.url)), JSON.stringify(saved.map((j) => j.url)));
    const [openedList] = await Promise.all([ctx.waitForEvent("page"), popup.click("#list-result a")]);
    check("results: the link opens the configured server", openedList.url().startsWith(serverUrl) || (await openedList.waitForURL(/./).then(() => openedList.url().startsWith(serverUrl))), openedList.url());
    await openedList.close();
    const [openedJob] = await Promise.all([ctx.waitForEvent("page"), popup.click("#list-jobs li:nth-child(1) .outcome a")]);
    check("results: a row's link opens that job on the server", /job\.html\?id=\d+&ws=1$/.test(openedJob.url()) || (await openedJob.waitForURL(/./).then(() => /job\.html\?id=\d+&ws=1$/.test(openedJob.url()))), openedJob.url());
    await openedJob.close();
  }
  await popup.close();

  // The same page again: what is there is left alone, the rest is added
  popup = await openPopup(listTab);
  await listReady(popup);
  await popup.click("#pick-all");
  await popup.click("#list-save");
  await popup.waitForSelector("#list-result:not(.hidden)");
  if (!REAL) {
    eq("results again: only the missing job is added", (await popup.textContent("#list-result")).replace(/ Open JobHuntPA.*$/, ""), "Added 1 job. 5 jobs were already in JobHuntPA and were left as they are.");
    const outcomes = await popup.locator("#list-jobs .outcome").allTextContents();
    check("results again: rows say which were already there", outcomes.filter((t) => t === "Already in JobHuntPA \u2014 open").length === 5 && outcomes.filter((t) => t === "Added \u2014 open").length === 1, JSON.stringify(outcomes));
    const kept = (await state()).jobs.find((j) => j.url === "https://www.seek.com.au/job/70000001");
    check("results again: six jobs stored, none twice", (await state()).jobs.length === 6 && !!kept);
  } else {
    check("results again: nothing new the second time", /No new jobs were added|Added 1 job\./.test(await popup.textContent("#list-result")), await popup.textContent("#list-result"));
  }
  // The Add job tab still works on such a page: its "already there?" check runs when the tab is opened
  if (!REAL) check("results: no preview was sent while the list tab was open", !(await state()).log.some((x) => /preview$/.test(x.path)));
  await popup.click("#tab-job");
  await ready(popup);
  check("results: opening Add job checks the page as a job then", REAL || (await state()).log.filter((x) => /preview$/.test(x.path)).length === 1);
  // Arrow keys reach the extra tab
  await popup.focus("#tab-job");
  await popup.keyboard.press("ArrowRight");
  eq("results: arrow key moves to the list tab", await popup.getAttribute("#tab-list", "aria-selected"), "true");
  await popup.keyboard.press("ArrowRight");
  eq("results: and on to the source tab", await popup.getAttribute("#tab-source", "aria-selected"), "true");
  await popup.keyboard.press("Home");
  eq("results: Home goes back to the first tab", await popup.getAttribute("#tab-job", "aria-selected"), "true");
  await popup.close();

  if (!REAL) {
    // Workspace switch: the other workspace has none of these jobs yet
    popup = await openPopup(listTab);
    await listReady(popup);
    await popup.selectOption("#workspace", "3");
    await popup.waitForFunction(() => document.querySelectorAll("#list-jobs .outcome").length === 0 && document.querySelector("#list-save").textContent === "Add 3 jobs");
    await popup.click("#list-save");
    await popup.waitForSelector("#list-result:not(.hidden)");
    check("results: the other workspace gets its own jobs", /^Added 3 jobs\./.test(await popup.textContent("#list-result")) && (await lastBody(/jobs\/batch$/)).workspace === "3", await popup.textContent("#list-result"));
    await popup.selectOption("#workspace", "1");
    await popup.close();

    // A server from before it took a page of jobs
    await mode("oldapi");
    popup = await openPopup(listTab);
    await popup.waitForSelector("#list-status.warn");
    check("old server: says to update JobHuntPA, and nothing can be sent", /can't take a page of jobs yet\. Update JobHuntPA/.test(await popup.textContent("#list-status")) && (await popup.isDisabled("#list-save")), await popup.textContent("#list-status"));
    await popup.close();
    await mode("ok");

    // The server refuses the request (busy): the list stays and can be sent again
    popup = await openPopup(listTab);
    await listReady(popup);
    await popup.click("#pick-all");
    await mode("busy");
    await popup.click("#list-save");
    await popup.waitForSelector("#list-status.error");
    check("results: an error keeps the list and the ticks", /encrypting/.test(await popup.textContent("#list-status")) && (await ticked(popup)) === 6 && !(await popup.isDisabled("#list-save")), await popup.textContent("#list-status"));
    await mode("ok");
    await popup.click("#list-save");
    await popup.waitForSelector("#list-result:not(.hidden)");
    check("results: sending again after the error works", /No new jobs were added\. 6 jobs were already in JobHuntPA/.test(await popup.textContent("#list-result")) && (await popup.locator("#list-status.hidden").count()) === 1, await popup.textContent("#list-result"));
    await popup.close();
  }
  await listTab.close();

  // ---- A heavy page: megabytes of inline script (with app state) and style ----
  const hugeTab = await newJobTab("job-huge.html");
  const hugeHtmlSize = await hugeTab.evaluate(() => document.documentElement.outerHTML.length);
  check("huge page really is huge", hugeHtmlSize > 3000000, String(hugeHtmlSize));
  popup = await openPopup(hugeTab);
  await ready(popup, 30000);
  eq("huge: title", await popup.inputValue("#f-title"), "Backend Developer");
  if (REAL) {
    await popup.click("#job-save");
    await popup.waitForSelector("#job-result:not(.hidden)");
    check("huge: saved on the real server", /Saved|Updated/.test(await popup.textContent("#job-result")), await popup.textContent("#job-result"));
  }
  if (!REAL) {
    const req = await lastBody();
    check("huge: payload stays small", req.bytes < 3000, `${req.bytes} bytes`);
    check("huge: nothing of the scripts or app state is sent", !/SECRET-SESSION-TOKEN|private\.person|window\.__APP_STATE__|color:red/.test(JSON.stringify(req.body)));
    sizes.push([`heavy page (${(hugeHtmlSize / 1e6).toFixed(1)} MB of HTML)`, req.bytes]);
  }
  await popup.close();
  await hugeTab.close();

  // ---- Page without any detectable title: the user types one ----
  const noTitleTab = await newJobTab("job-notitle.html");
  popup = await openPopup(noTitleTab);
  await ready(popup);
  eq("no title: field left empty", await popup.inputValue("#f-title"), "");
  check("no title: hint shown", /No job title was found/.test(await popup.textContent("#job-notes")), await popup.textContent("#job-notes"));
  await popup.click("#job-save");
  await popup.waitForSelector("#job-status.error");
  check("no title: saving without one explains why", /No job title was found/.test(await popup.textContent("#job-status")), await popup.textContent("#job-status"));
  await popup.fill("#f-title", "Warehouse Operator");
  await popup.fill("#f-company", "Shipco");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  check("no title: saved after typing one", /Saved/.test(await popup.textContent("#job-result")), await popup.textContent("#job-result"));
  await popup.close();
  await noTitleTab.close();

  // ---- Source ----
  const careersTab = await newJobTab("careers.html");
  popup = await openPopup(careersTab);
  await popup.waitForSelector("#tab-job");
  await popup.focus("#tab-job");
  await popup.keyboard.press("ArrowRight");
  eq("arrow key switches tab", await popup.getAttribute("#tab-source", "aria-selected"), "true");
  eq("source url prefilled", await popup.inputValue("#s-url"), `${pagesUrl}/pages/careers.html`);
  await popup.fill("#s-label", "Example careers");
  await popup.click("#source-add");
  await popup.waitForSelector("#source-status.ok");
  check("source added", /Added as a source/.test(await popup.textContent("#source-status")));
  await popup.click("#source-test");
  await popup.waitForSelector("#source-status .samples, #source-status.error", { timeout: 100000 });
  const testText = await popup.textContent("#source-status");
  if (!REAL) check("test shows count and samples", /Found 14 postings/.test(testText) && /Senior Analyst — Berlin/.test(testText), testText);
  await popup.screenshot({ path: path.join(OUT, "popup-source.png") });
  await popup.click("#source-add");
  await popup.waitForSelector("#source-status.warn");
  check("409 handled gracefully", /already one of your sources/.test(await popup.textContent("#source-status")));
  await popup.waitForSelector("#source-test:not(.hidden)");
  check("test still offered for the existing source", true);
  await popup.fill("#s-url", "ftp://nope");
  await popup.click("#source-add");
  check("bad url refused client-side", /http:\/\/ or https:\/\//.test(await popup.textContent("#source-status")));
  await popup.close();

  // ---- Restricted page ----
  const blank = await ctx.newPage(); // about:blank
  popup = await openPopup(blank);
  await popup.waitForSelector("#job-status:not(.hidden)");
  check("restricted page message", /does not let extensions read/.test(await popup.textContent("#job-status")), await popup.textContent("#job-status"));
  await popup.close();
  await blank.close();

  // ---- Error paths ----
  const badKeyTest = async () => {
    await sw.evaluate((k) => chrome.storage.local.set({ key: k }), "jhpa_" + "B".repeat(43));
    popup = await openPopup(ldTab);
    await popup.waitForSelector("#job-status.error");
    const t = await popup.textContent("#job-status");
    check("401 -> reconnect in Options", /Reconnect in Options/.test(t) && (await popup.locator("#job-status button", { hasText: "Open Options" }).count()) === 1, t);
    await popup.screenshot({ path: path.join(OUT, "popup-401.png") });
    await popup.close();
    await sw.evaluate((k) => chrome.storage.local.set({ key: k }), key);
  };
  await badKeyTest();
  if (REAL && api) {
    // a key that was revoked in JobHuntPA
    const made = await api.post("/api/extension/keys", { label: "e2e revoked" });
    eq("real: made a key to revoke", made.status, 201);
    eq("real: revoked the key", (await api.del(`/api/extension/keys/${made.json.id}`)).status, 200);
    await sw.evaluate((k) => chrome.storage.local.set({ key: k }), made.json.key);
    popup = await openPopup(ldTab);
    await popup.waitForSelector("#job-status.error");
    const rv = await popup.textContent("#job-status");
    check("real: revoked key -> reconnect message", /Reconnect in Options/.test(rv), rv);
    await popup.close();
    await opt.reload();
    await opt.fill("#key", made.json.key);
    await opt.click("#connect");
    await opt.waitForSelector("#status.error");
    check("real: options with a revoked key -> not accepted", /not accepted|Reconnect|check the key/i.test(await opt.textContent("#status")), await opt.textContent("#status"));
    await sw.evaluate((k) => chrome.storage.local.set({ key: k }), key);
    // a workspace the server doesn't know (deleted, or from another account)
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 987654, workspaces: [{ id: 987654, name: "Gone" }] }));
    popup = await openPopup(ldTab);
    await ready(popup);
    const wsNow = (await storage()).workspace;
    check("real: unknown workspace -> falls back to a real one", wsNow !== 987654 && (await storage()).workspaces.some((w) => w.id === wsNow), JSON.stringify(await storage()));
    check("real: unknown workspace -> notice shown", /workspace you picked is gone/.test(await popup.textContent("#ws-notice")), await popup.textContent("#ws-notice"));
    check("real: preview after the fallback finds the existing job", /Already in JobHuntPA/.test(await popup.textContent("#job-existing")));
    await popup.close();
  }
  if (!REAL) {
    for (const [m, re] of [["busy", /encrypting/], ["rate", /Try again in 7 seconds/]]) {
      await mode(m);
      popup = await openPopup(ldTab);
      await popup.waitForSelector("#job-status.error");
      check(`${m} mode message`, re.test(await popup.textContent("#job-status")), await popup.textContent("#job-status"));
      await popup.close();
    }
    await mode("ok");
    // workspace that no longer exists
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 99, workspaces: [{ id: 99, name: "Gone" }] }));
    popup = await openPopup(ldTab);
    await ready(popup);
    eq("stale workspace falls back to the default", (await storage()).workspace, 1);
    eq("stale workspace: notice shown", await popup.textContent("#ws-notice"), "The workspace you picked is gone; using Main search.");
    eq("stale workspace: notice is a live region", await popup.getAttribute("#ws-notice", "aria-live"), "polite");
    await popup.close();

    // the server lists the account's workspaces without the stored one (answers 200 for the unknown id)
    await reset();
    await mode("wsgone");
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 1, workspaces: [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }] }));
    popup = await openPopup(ldTab);
    await ready(popup);
    eq("gone workspace: switched to the default", (await storage()).workspace, 3);
    eq("gone workspace: popup notice", await popup.textContent("#ws-notice"), "The workspace you picked is gone; using Plan B.");
    eq("gone workspace: dropdown shows the new one", await popup.inputValue("#workspace"), "3");
    await popup.click("#job-save");
    await popup.waitForSelector("#job-result:not(.hidden)");
    const sent = (await (await fetch(`${mock.url}/__state`)).json()).log.filter((x) => /preview|jobs$/.test(x.path));
    check("gone workspace: preview and save used the new id only", sent.length === 2 && sent.every((x) => x.workspace === "3"), JSON.stringify(sent.map((x) => x.workspace)));
    await popup.screenshot({ path: path.join(OUT, "popup-ws-gone.png") });
    await popup.close();
    // options page: same switch, with a notice
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 1, workspaces: [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }] }));
    await opt.reload();
    await opt.waitForFunction(() => /workspace you picked is gone/.test(document.querySelector("#status").textContent));
    eq("gone workspace: options notice", await opt.textContent("#status"), "The workspace you picked is gone; using Plan B.");
    eq("gone workspace: options stored the default", (await storage()).workspace, 3);
    eq("gone workspace: options dropdown", await opt.inputValue("#workspace"), "3");
    await mode("ok");
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 1, workspaces: [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }] }));
    await opt.reload();

    // 429 "busy": the one-at-a-time limit for reading pages
    await mode("readbusy");
    popup = await openPopup(ldTab);
    await popup.waitForSelector("#job-status.error");
    check("busy 429 on preview shows the server's sentence", /already reading another page/.test(await popup.textContent("#job-status")), await popup.textContent("#job-status"));
    await mode("ok");
    await popup.click("#job-status button:has-text('Try again')");
    await ready(popup);
    check("busy 429: retry works", (await popup.inputValue("#f-title")).includes("Senior Analyst"));
    await mode("readbusy");
    await popup.click("#job-save");
    await popup.waitForSelector("#job-status.error");
    check("busy 429 on save shows the server's sentence", /already reading another page/.test(await popup.textContent("#job-status")), await popup.textContent("#job-status"));
    check("busy 429 on save keeps the form and re-enables Save", !(await popup.isDisabled("#job-save")) && !(await popup.locator("#job-form").evaluate((n) => n.classList.contains("hidden"))));
    await mode("ok");
    await popup.click("#job-reread");
    await popup.waitForFunction(() => document.querySelector("#job-status").classList.contains("hidden") && !document.querySelector("#job-form").classList.contains("hidden"));
    await popup.click("#job-save");
    await popup.waitForSelector("#job-result:not(.hidden)");
    check("busy 429: Read page again then save works", /Updated|Saved/.test(await popup.textContent("#job-result")));
    await popup.close();
  }

  // ---- Settings in the popup: what it is connected to, check, reconnect, reset ----
  popup = await openPopup(ldTab);
  await ready(popup);
  eq("settings: a button in the popup's head", await popup.textContent("#settings-toggle"), "Settings");
  await popup.click("#settings-toggle");
  await popup.waitForSelector("#settings:not(.hidden)");
  eq("settings: server shown", await popup.textContent("#set-server"), serverUrl);
  if (!REAL) eq("settings: the key's name shown", await popup.textContent("#set-label"), "Test browser");
  check("settings: the key's last day shown", /\d/.test(await popup.textContent("#set-expires")), await popup.textContent("#set-expires"));
  eq("settings: the tabs and the page's details are out of the way", await popup.locator("#work.hidden, #work-head.hidden").count(), 2);
  eq("settings: the button now goes back", await popup.textContent("#settings-toggle"), "Back");
  eq("settings: focus moves to the heading", await popup.evaluate(() => document.activeElement.id), "settings-title");
  await popup.screenshot({ path: path.join(OUT, "popup-settings.png") });
  await popup.click("#set-check");
  await popup.waitForSelector("#set-status.ok");
  eq("settings: check connection", await popup.textContent("#set-status"), "The connection works.");
  if (!REAL) {
    await mode("revoked");
    await popup.click("#set-check");
    await popup.waitForSelector("#set-status.error");
    check("settings: a key that stopped working says to reconnect", /Reconnect in Options/.test(await popup.textContent("#set-status")) && (await popup.locator("#set-status button", { hasText: "Open Options" }).count()) === 1, await popup.textContent("#set-status"));
    await mode("ok");
  }
  // Reset asks first; Cancel leaves everything as it is
  await popup.click("#set-reset");
  await popup.waitForSelector("#reset-confirm:not(.hidden)");
  check("settings: reset asks first, with Cancel in focus", /removes the server address, the key and the chosen workspace/.test(await popup.textContent("#reset-confirm")) && (await popup.evaluate(() => document.activeElement.id)) === "reset-no", await popup.textContent("#reset-confirm"));
  await popup.click("#reset-no");
  check("settings: Cancel keeps the setup", (await storage()).key === key && (await popup.locator("#reset-confirm.hidden").count()) === 1 && (await popup.evaluate(() => document.activeElement.id)) === "set-reset");
  await popup.click("#settings-toggle");
  check("settings: Back shows the page's tabs again", (await popup.locator("#settings.hidden").count()) === 1 && (await popup.textContent("#settings-toggle")) === "Settings" && (await popup.isVisible("#job-form")));
  // Reconnect opens the options page (and closes the popup)
  await opt.close();
  await popup.click("#settings-toggle");
  const [reopened] = await Promise.all([ctx.waitForEvent("page"), popup.click("#set-reconnect")]);
  await reopened.waitForURL(/options\/options\.html/);
  check("settings: Reconnect opens the options page", true);
  opt = reopened;
  await opt.waitForSelector("#status.ok");
  check("options: says what it is connected to, with the saved key kept", /Connected to/.test(await opt.textContent("#status")) && (await opt.inputValue("#server")) === serverUrl && (await opt.inputValue("#key")) === "", await opt.textContent("#status"));
  check("options: reconnect or reset is explained", /Reconnect or reset/.test(await opt.textContent("#manage-title")) && (await opt.isVisible("#reset")));
  // Reconnect with the saved key: Connect alone tries it again
  await opt.click("#connect");
  await opt.waitForFunction(() => /You can close this page/.test(document.querySelector("#status").textContent));
  eq("options: Connect with an empty key field keeps the saved key", (await storage()).key, key);
  if (!popup.isClosed()) await popup.close();

  // ---- Options: wrong key shows an error and keeps the old connection ----
  await opt.reload();
  await opt.fill("#key", "jhpa_" + "C".repeat(43));
  await opt.click("#connect");
  await opt.waitForSelector("#status.error");
  check("options: bad key -> 401 message", /not accepted|Reconnect|check the key/i.test(await opt.textContent("#status")), await opt.textContent("#status"));
  eq("old key kept after failed connect", (await storage()).key, key);

  // ---- Reset in the options page ----
  await opt.reload();
  await opt.waitForSelector("#manage:not(.hidden)");
  await opt.click("#reset");
  await opt.waitForSelector("#reset-confirm:not(.hidden)");
  await opt.click("#reset-no");
  check("options: Cancel keeps the setup", (await storage()).key === key && (await opt.locator("#reset-confirm.hidden").count()) === 1);
  await opt.click("#reset");
  await opt.click("#reset-yes");
  await opt.waitForFunction(() => /^Reset\./.test(document.querySelector("#status").textContent));
  st = await storage();
  check("reset forgets the server, the key and the workspace", Object.keys(st).length === 0, JSON.stringify(Object.keys(st)));
  check("options: after a reset the form is empty and there is nothing left to reset", (await opt.inputValue("#server")) === "" && (await opt.locator("#manage.hidden").count()) === 1 && /keeps working until you disconnect this extension in JobHuntPA/.test(await opt.textContent("#status")), await opt.textContent("#status"));
  popup = await openPopup(ldTab);
  await popup.waitForSelector("#setup:not(.hidden)");
  check("popup asks to open Options when not configured", (await popup.locator("#setup-note.hidden").count()) === 1);
  await popup.close();

  // ---- Reset from the popup's settings ----
  await sw.evaluate(([s, k]) => chrome.storage.local.set({ server: s, key: k, workspace: null, workspaces: [], label: "Test browser", expiresAt: "2027-10-09T12:00:00Z" }), [serverUrl, key]);
  popup = await openPopup(ldTab);
  await ready(popup);
  await popup.click("#settings-toggle");
  await popup.click("#set-reset");
  await popup.click("#reset-yes");
  await popup.waitForSelector("#setup:not(.hidden)");
  st = await storage();
  check("popup reset: everything is forgotten", Object.keys(st).length === 0, JSON.stringify(Object.keys(st)));
  check("popup reset: says so and offers to connect again", /^Reset\. The server address, the key and the workspace were removed/.test(await popup.textContent("#setup-note")) && (await popup.locator("#main.hidden").count()) === 1 && (await popup.evaluate(() => document.activeElement.id)) === "open-options", await popup.textContent("#setup-note"));
  await popup.screenshot({ path: path.join(OUT, "popup-reset.png") });
  await popup.close();

  // ---- Server down ----
  await sw.evaluate(([s, k]) => chrome.storage.local.set({ server: s, key: k, workspace: 1, workspaces: [{ id: 1, name: "Main" }] }), ["http://127.0.0.1:9", key]);
  popup = await openPopup(ldTab);
  await popup.waitForSelector("#job-status.error", { timeout: 30000 });
  const down = await popup.textContent("#job-status");
  check("server down message", /Can't reach your JobHuntPA server at http:\/\/127\.0\.0\.1:9/.test(down), down);
  await popup.screenshot({ path: path.join(OUT, "popup-down.png") });
  await popup.close();

  if (!REAL) {
    await reset();
    const bodies = seenBodies;
    check("every preview/save body: no html, no text, no fields, under 20 KB", bodies.length > 10 && bodies.every((x) => !("html" in x.body) && !("text" in x.body) && !("fields" in x.body) && x.bytes < 20000), String(bodies.length));
    check("the mock never saw HTML in a job value", seenViolations.length === 0, seenViolations.join(" | "));
    console.log("payload sizes: " + sizes.map(([n, b]) => `${n} ${b} B`).join("; "));
  }
  if (REAL) {
    check("real: every POST body is only url, canonical_url, job", posted.length >= 8 && posted.every((x) => Object.keys(JSON.parse(x.raw)).every((k) => ["url", "canonical_url", "job"].includes(k))), String(posted.length));
    check("real: every POST body under 20 KB and no html/text fields", posted.every((x) => x.raw.length < 20000 && !/"(html|text|fields)":/.test(x.raw)));
    const huge = posted.filter((x) => /job-huge/.test(x.raw));
    check("real: heavy page payload stays small", huge.length >= 1 && huge.every((x) => x.raw.length < 3000 && !/SECRET-SESSION-TOKEN|__APP_STATE__/.test(x.raw)), huge.map((x) => x.raw.length).join(","));
    console.log("payload sizes (real): " + posted.map((x) => `${x.path.split("/").pop()} ${x.raw.length} B`).join(", "));
  }
  if (REAL && api) {
    const list = await api.get("/api/jobs?include=excluded,hidden");
    eq("real: job list", list.status, 200);
    const byUrl = {};
    for (const it of [...list.json].sort((a, b) => a.id - b.id)) byUrl[it.url] = (await api.get(`/api/jobs/${it.id}`)).json;
    const at = (name) => byUrl[Object.keys(byUrl).filter((u) => u.endsWith(name)).pop()] || {};
    const plain = (d) => typeof d === "string" && !/<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i.test(d) && !/&(amp|lt|gt|nbsp|quot);/.test(d);
    const want = [
      ["job-ld.html", { title: "Senior Analyst", company: "Example Corp", location_text: "Berlin, BE, DE", salary_text: "EUR 60,000–75,000 per year", work_mode: "remote", employment_type: "full_time" }, (d) => d.includes("- SQL\n- Python") && d.includes("\n\n") && d.includes("stack & work")],
      ["job-graph.html", { title: "Platform Engineer", company: "Graphly", location_text: "Leeds, GB; Remote, GB", salary_text: "GBP 65,000 per year" }, (d) => d === "Build the platform.\n\nKeep it running."],
      ["https://www.seek.com.au/job/12345678", { title: "Marketing Coordinator", company: "Brightside Pty Ltd", location_text: "Sydney NSW", salary_text: "$80,000 - $90,000 per year", employment_type: "full_time" }, (d) => d.includes("Plan campaigns") && d.includes("\n") && !/Similar jobs/.test(d)],
      ["https://boards.greenhouse.io/acme-corp/jobs/4242", { title: "Site Reliability Engineer", company: "Acme Corp" }, (d) => /pagers/.test(d)],
      ["job-plain.html", { title: "Data Engineer", company: "Acme Ltd", work_mode: "hybrid" }, (d) => /build pipelines/.test(d)],
      ["job-huge.html", { title: "Backend Developer" }, (d) => d.length > 20 && d.length <= 100000],
      ["job-notitle.html", { title: "Warehouse Operator", company: "Shipco" }, (d) => /warehouse/.test(d)],
    ];
    for (const [suffix, fields, descOk] of want) {
      const j = at(suffix);
      check(`real: stored ${suffix} exists`, !!j.id, JSON.stringify(Object.keys(byUrl)));
      for (const [k, v] of Object.entries(fields)) eq(`real: stored ${suffix} ${k}`, j[k], v);
      eq(`real: stored ${suffix} source says the extension, one job, and the site`, j.source, `browser:single:${j.url ? new URL(j.url).hostname.replace(/^www\./, "") : ""}`);
      check(`real: stored ${suffix} description is plain text`, plain(j.description) && descOk(j.description || ""), JSON.stringify(j.description));
    }
    check("real: SEEK job stored under the clean SEEK address", !!byUrl["https://www.seek.com.au/job/12345678"]);
    const fromList = [1, 2, 3, 4, 5, 6].map((n) => byUrl[`https://www.seek.com.au/job/7000000${n}`] || {});
    check("real: the results page's jobs are stored as summaries that came in bulk from SEEK", fromList.every((j) => j.source === "browser:bulk:seek.com.au" && j.detail_status === "summary"), JSON.stringify(fromList.map((j) => [j.source, j.detail_status])));
  }
  check("no console/page errors in extension pages", problems.length === 0, problems.join(" | "));
  await ctx.close();
  if (mock) await mock.close();
  if (pages) pages.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
