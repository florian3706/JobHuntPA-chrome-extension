// End-to-end test: real Chromium + the unpacked extension against the mock server (default)
// or a real JobHuntPA server. See tests/README.md.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright");
const { createMock } = require("./mock-server.cjs");

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
      const f = path.join(__dirname, "pages", path.basename(req.url.split("?")[0]));
      if (fs.existsSync(f)) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(fs.readFileSync(f)); }
      else { res.writeHead(404); res.end("no"); }
    }).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close() }));
  });
}

(async () => {
  const mock = REAL ? null : await createMock();
  const pages = REAL ? await pagesServer() : null;
  const serverUrl = REAL ? process.env.JHPA_SERVER.replace(/\/+$/, "") : mock.url;
  const key = REAL ? process.env.JHPA_KEY : mock.key;
  const pagesUrl = REAL ? pages.url : mock.url;
  if (!key) throw new Error("JHPA_KEY is required with JHPA_SERVER");
  const serverHost = new URL(serverUrl).hostname;
  const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "jhpa-ext-"));
  copyExtension(extDir, [`http://${serverHost}/*`, `https://${serverHost}/*`, "http://127.0.0.1/*", "http://localhost/*"]);

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
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  const base = `chrome-extension://${extId}`;
  console.log(`extension ${extId}, server ${serverUrl} (${REAL ? "real" : "mock"})`);
  for (const p of ctx.pages()) if (p.url().includes("options")) await p.close(); // opened on install

  const reset = async () => { if (mock) await fetch(`${mock.url}/__reset`); };
  const mode = async (m) => { if (mock) await fetch(`${mock.url}/__control?mode=${m}`); };
  const storage = () => sw.evaluate(() => chrome.storage.local.get(null));

  // ---- Options: connect flow ----
  const opt = await ctx.newPage();
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
  const newJobTab = async (p) => { const t = await ctx.newPage(); await t.goto(`${pagesUrl}/pages/${p}`); return t; };

  // ---- Job from a page with JSON-LD ----
  await reset();
  const ldTab = await newJobTab("job-ld.html");
  let popup = await openPopup(ldTab);
  await popup.waitForSelector("#job-form:not(.hidden)", { timeout: 20000 });
  eq("preview: title", await popup.inputValue("#f-title"), "Senior Analyst");
  eq("preview: company", await popup.inputValue("#f-company"), REAL ? await popup.inputValue("#f-company") : "Example Corp");
  check("preview: description present", (await popup.inputValue("#f-desc")).length > 20);
  check("popup shows the page url", (await popup.textContent("#page-url")).includes("job-ld.html"));
  await popup.screenshot({ path: path.join(OUT, "popup-job.png") });
  if (!REAL) {
    const req = (await (await fetch(`${mock.url}/__state`)).json()).log.find((x) => x.path === "/api/extension/preview");
    check("preview body carries html+text+title", req.body.html.includes("ld+json") && req.body.text.includes("Analyse") && req.body.page_title.startsWith("Senior Analyst"));
    eq("preview: X-Workspace sent", req.workspace, "1");
    eq("preview: no origin/cookie leak", req.cookie, "");
  }
  await popup.fill("#f-title", "Senior Analyst (edited)");
  await popup.selectOption("#f-mode", "hybrid");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  const resultText = await popup.textContent("#job-result");
  check("saved message", /Saved — Open in JobHuntPA/.test(resultText), resultText);
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
  await popup.waitForSelector("#job-form:not(.hidden)");
  check("existing job is announced", /Already in JobHuntPA/.test(await popup.textContent("#job-existing")));
  eq("button says Update", await popup.textContent("#job-save"), "Update job");
  await popup.click("#job-save");
  await popup.waitForSelector("#job-result:not(.hidden)");
  check("update message", /Updated the existing job/.test(await popup.textContent("#job-result")));

  // Selection used as description + "Read page again"
  await ldTab.bringToFront();
  await ldTab.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById("sel")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
  await popup.click("#job-reread");
  await popup.waitForSelector("#job-form:not(.hidden)");
  check("selection reaches the server", REAL || (await popup.inputValue("#f-desc")).includes("Select this sentence"), await popup.inputValue("#f-desc"));
  await popup.close();

  // ---- Job from a page without structured data ----
  const plainTab = await newJobTab("job-plain.html");
  popup = await openPopup(plainTab);
  await popup.waitForSelector("#job-form:not(.hidden)");
  check("plain page: title found", (await popup.inputValue("#f-title")).includes("Data Engineer"));
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
    await popup.waitForFunction(() => document.querySelector("#job-existing").classList.contains("hidden") && !document.querySelector("#job-form").classList.contains("hidden"));
    eq("switching workspace re-runs preview (no existing job there)", await popup.textContent("#job-save"), "Save job");
    eq("workspace choice persisted", (await storage()).workspace, 3);
    await popup.selectOption("#workspace", "1");
  }
  await popup.close();

  // ---- Page without any detectable title: the user types one ----
  const noTitleTab = await newJobTab("job-notitle.html");
  popup = await openPopup(noTitleTab);
  await popup.waitForSelector("#job-form:not(.hidden)");
  eq("no title: field left empty", await popup.inputValue("#f-title"), "");
  check("no title: server's hint shown", /No job title was found/.test(await popup.textContent("#job-notes")), await popup.textContent("#job-notes"));
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
    await popup.waitForSelector("#job-form:not(.hidden)");
    eq("stale workspace falls back to the default", (await storage()).workspace, 1);
    eq("stale workspace: notice shown", await popup.textContent("#ws-notice"), "The workspace you picked is gone; using Main search.");
    eq("stale workspace: notice is a live region", await popup.getAttribute("#ws-notice", "aria-live"), "polite");
    await popup.close();

    // the server lists the account's workspaces without the stored one (answers 200 for the unknown id)
    await reset();
    await mode("wsgone");
    await sw.evaluate(() => chrome.storage.local.set({ workspace: 1, workspaces: [{ id: 1, name: "Main search" }, { id: 3, name: "Plan B" }] }));
    popup = await openPopup(ldTab);
    await popup.waitForSelector("#job-form:not(.hidden)");
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
    await popup.waitForSelector("#job-form:not(.hidden)");
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

  // ---- Options: wrong key shows an error and keeps the old connection ----
  await opt.reload();
  await opt.fill("#key", "jhpa_" + "C".repeat(43));
  await opt.click("#connect");
  await opt.waitForSelector("#status.error");
  check("options: bad key -> 401 message", /not accepted|Reconnect|check the key/i.test(await opt.textContent("#status")), await opt.textContent("#status"));
  eq("old key kept after failed connect", (await storage()).key, key);

  // ---- Disconnect ----
  await opt.reload();
  await opt.click("#disconnect");
  await opt.waitForFunction(() => /Disconnected/.test(document.querySelector("#status").textContent));
  st = await storage();
  check("disconnect forgets the key", !st.key && !st.server, JSON.stringify(st));
  popup = await openPopup(ldTab);
  await popup.waitForSelector("#setup:not(.hidden)");
  check("popup asks to open Options when not configured", true);
  await popup.close();

  // ---- Server down ----
  await sw.evaluate(([s, k]) => chrome.storage.local.set({ server: s, key: k, workspace: 1, workspaces: [{ id: 1, name: "Main" }] }), ["http://127.0.0.1:9", key]);
  popup = await openPopup(ldTab);
  await popup.waitForSelector("#job-status.error", { timeout: 30000 });
  const down = await popup.textContent("#job-status");
  check("server down message", /Can't reach your JobHuntPA server at http:\/\/127\.0\.0\.1:9/.test(down), down);
  await popup.screenshot({ path: path.join(OUT, "popup-down.png") });
  await popup.close();

  check("no console/page errors in extension pages", problems.length === 0, problems.join(" | "));
  await ctx.close();
  if (mock) await mock.close();
  if (pages) pages.close();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
