import { ext } from "../lib/ext.js";
import { $, el, clear } from "../lib/dom.js";
import { api, describeError, serverLink } from "../lib/api.js";
import { loadConfig, saveConfig, hasServerAccess } from "../lib/config.js";
import { activeTab, capturePage, CaptureError, isReadableUrl } from "../lib/capture.js";
import { extractJob, buildBody, notesFor, extractListing, buildListBody, listingNote, LIST_LIMITS } from "../lib/extract.js";

let cfg = null;
let tab = null;
let extracted = null; // the job read from the page, in this browser: { url, canonical_url, job }; reused for save
let preview = null;
let previewSeq = 0;
let source = null; // { id, url } once the page is a source
let statusReady = Promise.resolve(); // the latest status call; nothing is sent to a workspace before it finished
let listing = null; // the jobs of a page of search results, read in this browser: { url, site, jobs }
let listRows = []; // one per job in the list: { job, box, item, done }
let listBusy = false;
let previewDue = false; // on a page of results, "is this job already there?" waits until the Add job tab is opened

const TIMEOUT = { status: 15000, preview: 40000, save: 40000, list: 120000, source: 30000, test: 90000 };
const LIST_API = 2; // the server's `api` number from which it takes a page of jobs
const OLD_SERVER = "Your JobHuntPA server can't take a page of jobs yet. Update JobHuntPA, then open this again.";

// ---------- small UI helpers ----------

function show(node, on = true) {
  node.classList.toggle("hidden", !on);
}

/** Fill a status box. parts: message string; opts { kind, busy, optionsLink, actions: [[label, fn]] } */
function setStatus(box, message, opts = {}) {
  clear(box);
  box.className = "status" + (opts.kind ? ` ${opts.kind}` : "");
  const p = el("p");
  if (opts.busy) p.append(el("span", { class: "spinner", "aria-hidden": "true" }));
  p.append(document.createTextNode(message));
  box.append(p);
  const actions = [...(opts.actions || [])];
  if (opts.optionsLink) actions.push(["Open Options", () => ext.runtime.openOptionsPage()]);
  if (actions.length) {
    const bar = el("div", { class: "actions" });
    for (const [label, fn] of actions) bar.append(el("button", { type: "button", text: label, onclick: fn }));
    box.append(bar);
  }
}

function setError(box, err, cfgForMsg, extraActions = []) {
  const d = describeError(err, cfgForMsg);
  setStatus(box, d.message, { kind: "error", optionsLink: d.optionsLink, actions: extraActions });
}

function openServerLink(link) {
  const url = serverLink(cfg.server, link);
  if (url) ext.tabs.create({ url });
}

function serverAnchor(text, link) {
  const url = serverLink(cfg.server, link);
  if (!url) return document.createTextNode(text);
  return el("a", {
    href: url,
    text,
    onclick: (e) => {
      e.preventDefault();
      openServerLink(link);
    },
  });
}

// ---------- start ----------

async function init() {
  $("#open-options").addEventListener("click", () => {
    ext.runtime.openOptionsPage();
    window.close();
  });
  cfg = await loadConfig();
  if (!cfg) {
    show($("#setup"));
    return;
  }
  show($("#main"));
  setupTabs();
  setupWorkspaceSelect();
  $("#job-form").addEventListener("submit", onSaveJob);
  $("#job-reread").addEventListener("click", () => startJob(true));
  $("#list-form").addEventListener("submit", onSaveList);
  $("#list-reread").addEventListener("click", () => startJob(true));
  $("#pick-all").addEventListener("click", () => pickJobs(() => true));
  $("#pick-new").addEventListener("click", () => pickJobs((job) => job.is_new));
  $("#pick-none").addEventListener("click", () => pickJobs(() => false));
  $("#source-form").addEventListener("submit", onAddSource);
  $("#source-test").addEventListener("click", onTestSource);
  $("#s-url").addEventListener("input", () => {
    source = null;
    show($("#source-test"), false);
  });

  tab = await activeTab();
  $("#page-url").textContent = tab && tab.url ? tab.url : "";
  if (tab && isReadableUrl(tab.url)) $("#s-url").value = tab.url;
  await startJob(true);
}

const TABS = ["tab-job", "tab-list", "tab-source"];
const tabNodes = () => TABS.map((id) => $(`#${id}`));

function selectTab(t, focus = false) {
  for (const x of tabNodes()) {
    const on = x === t;
    x.setAttribute("aria-selected", String(on));
    x.tabIndex = on ? 0 : -1;
    show($(`#${x.getAttribute("aria-controls")}`), on);
  }
  if (focus) t.focus();
  if (t.id === "tab-job" && previewDue) {
    previewDue = false;
    runPreview();
  }
}

function setupTabs() {
  for (const t of tabNodes()) {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      const tabs = tabNodes().filter((x) => !x.classList.contains("hidden")); // "Jobs on this page" is not always there
      const i = tabs.indexOf(t);
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i + tabs.length - 1) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j >= 0) {
        e.preventDefault();
        selectTab(tabs[j], true);
      }
    });
  }
}

function fillWorkspaces() {
  const sel = $("#workspace");
  clear(sel);
  for (const w of cfg.workspaces) {
    sel.append(el("option", { value: String(w.id), text: w.name }));
  }
  if (cfg.workspace != null) sel.value = String(cfg.workspace);
  show(sel.parentElement, cfg.workspaces.length > 0);
}

function setupWorkspaceSelect() {
  fillWorkspaces();
  $("#workspace").addEventListener("change", async (e) => {
    const id = Number(e.target.value);
    cfg.workspace = id;
    await saveConfig({ workspace: id });
    source = null;
    show($("#source-test"), false);
    show($("#source-status"), false);
    if (listing) renderListing(false); // what was added belongs to the other workspace
    if (extracted && !previewDue) runPreview();
  });
}

// ---------- add job ----------

async function startJob(recapture) {
  const status = $("#job-status");
  show($("#job-form"), false);
  show($("#job-result"), false);
  setStatus(status, "Reading the page…", { busy: true });
  show(status);
  $("#job-reread").disabled = true;
  try {
    if (!(await hasServerAccess(cfg.server))) {
      setStatus(status, `This extension has no permission for ${cfg.server} yet. Grant it in Options (press Connect).`, {
        kind: "error",
        optionsLink: true,
      });
      return;
    }
    const reuse = !recapture && extracted;
    const [captured] = await Promise.all([reuse ? null : capturePage(tab), refreshStatus()]);
    if (!reuse) {
      extracted = extractJob(captured); // all the reading and tidying happens here, on this computer
      listing = extractListing(captured);
    }
    renderJob(extracted.job);
    if (!reuse) renderListing(true);
    if (extracted.url && !$("#s-url").value) $("#s-url").value = extracted.url;
    if ($("#tab-list").getAttribute("aria-selected") === "true") {
      // A page of results, not a job: nothing about the page is sent unless the Add job tab is opened.
      previewDue = true;
      show(status, false);
    } else {
      previewDue = false;
      await runPreview();
    }
  } catch (err) {
    if (err instanceof CaptureError) {
      setStatus(status, err.message, { kind: "warn" });
    } else {
      setError(status, err, cfg, [["Try again", () => startJob(true)]]);
    }
  } finally {
    $("#job-reread").disabled = false;
  }
}

/** Validates the key and refreshes the workspace list. Throws ApiError. */
function refreshStatus() {
  statusReady = loadStatus();
  statusReady.catch(() => {}); // callers handle the error; this keeps the stored promise from being "unhandled"
  return statusReady;
}

async function loadStatus() {
  const s = await api(cfg, "GET", "/api/extension/status", undefined, { timeout: TIMEOUT.status });
  const list = Array.isArray(s.workspaces) ? s.workspaces.map((w) => ({ id: w.id, name: String(w.name) })) : [];
  cfg.workspaces = list;
  cfg.api = Number(s.api) || 1;
  let notice = "";
  if (cfg.workspace != null && !list.some((w) => w.id === cfg.workspace)) {
    // The saved workspace is gone (the server still answers 200): switch before anything is previewed or saved.
    cfg.workspace = list.some((w) => w.id === s.default_workspace) ? s.default_workspace : list[0]?.id ?? null;
    const now = list.find((w) => w.id === cfg.workspace);
    if (now) notice = `The workspace you picked is gone; using ${now.name}.`;
  } else if (cfg.workspace == null && list.length) {
    cfg.workspace = list.some((w) => w.id === s.default_workspace) ? s.default_workspace : list[0].id;
  }
  await saveConfig({ workspaces: list, workspace: cfg.workspace, expiresAt: s.expires_at || "" });
  fillWorkspaces();
  const box = $("#ws-notice");
  if (notice) {
    box.textContent = notice;
    show(box);
  } else {
    show(box, false);
  }
}

/** Asks the server only whether the job is already there; the form was filled from the page by this extension. */
async function runPreview() {
  const seq = ++previewSeq;
  const status = $("#job-status");
  show($("#job-result"), false);
  setStatus(status, "Checking whether JobHuntPA already has this job…", { busy: true });
  show(status);
  $("#job-save").disabled = true;
  try {
    const r = await api(cfg, "POST", "/api/extension/preview", buildBody(extracted), { timeout: TIMEOUT.preview });
    if (seq !== previewSeq) return;
    preview = r;
    renderExisting(r.existing);
    show($("#job-form"));
    show(status, false);
    $("#job-save").disabled = false;
  } catch (err) {
    if (seq !== previewSeq) return;
    if (err.status === 422 && err.field === "title") {
      // Nothing to look up without a title; the user types one and saves.
      preview = { existing: null };
      renderExisting(null);
      show(status, false);
      $("#job-save").disabled = false;
      return;
    }
    show($("#job-form"), false);
    setError(status, err, cfg, [["Try again", runPreview]]);
  }
}

const str = (v) => (v == null ? "" : String(v));

/** Fills the form from the job this extension read from the page. */
function renderJob(job) {
  $("#f-title").value = str(job.title);
  $("#f-company").value = str(job.company);
  $("#f-location").value = str(job.location_text);
  $("#f-salary").value = str(job.salary_text);
  $("#f-type").value = str(job.employment_type);
  $("#f-mode").value = ["onsite", "hybrid", "remote"].includes(job.work_mode) ? job.work_mode : "";
  const desc = str(job.description);
  $("#f-desc").value = desc.slice(0, 1500);
  const from = {
    selection: "your selected text",
    structured: "the page's job data",
    site: "the page's job description",
    main: "the page text",
    body: "the page text",
  }[job.description_from];
  $("#desc-label").textContent =
    "Description (preview" + (desc ? `, ${desc.length.toLocaleString()} characters` : "") + (from ? `, from ${from}` : "") + ")";
  const notes = $("#job-notes");
  clear(notes);
  for (const n of notesFor(job)) notes.append(el("li", { text: n }));
  show($("#job-existing"), false);
  $("#job-save").textContent = "Save job";
  show($("#job-form"));
  $("#f-title").focus();
}

function renderExisting(existing) {
  const ex = $("#job-existing");
  if (existing) {
    clear(ex);
    ex.append(
      el("p", {}, document.createTextNode("Already in JobHuntPA: "), serverAnchor(str(existing.title) || "open it", existing.link || ""),
        document.createTextNode(existing.status ? ` (${existing.status}).` : ".")),
      el("p", { class: "small", text: "Saving updates that job with the values below." }),
    );
    show(ex);
    $("#job-save").textContent = "Update job";
  } else {
    show(ex, false);
    $("#job-save").textContent = "Save job";
  }
}

function collectFields() {
  const f = {
    title: $("#f-title").value.trim(),
    company: $("#f-company").value.trim(),
    location_text: $("#f-location").value.trim(),
    salary_text: $("#f-salary").value.trim(),
    employment_type: $("#f-type").value.trim(),
    work_mode: $("#f-mode").value,
  };
  return f; // an emptied field stays empty: the form is the job that gets sent
}

async function onSaveJob(e) {
  e.preventDefault();
  const btn = $("#job-save");
  const result = $("#job-result");
  const status = $("#job-status");
  const fields = collectFields();
  if (!fields.title) {
    setStatus(status, "No job title was found on this page. Type one in, then save.", { kind: "error" });
    show(status);
    $("#f-title").focus();
    return;
  }
  btn.disabled = true;
  show(result, false);
  setStatus(status, "Saving…", { busy: true });
  show(status);
  try {
    const r = await api(cfg, "POST", "/api/extension/jobs", buildBody(extracted, fields), { timeout: TIMEOUT.save });
    show(status, false);
    clear(result);
    const verb = r.created === false ? "Updated the existing job" : "Saved";
    result.className = "status ok";
    result.append(
      el("p", {}, document.createTextNode(`${verb} — `), serverAnchor("Open in JobHuntPA", r.link || "")),
      el("p", { class: "small muted", text: [r.title, r.company].filter(Boolean).join(" · ") }),
    );
    if (typeof r.excluded_reason === "string" && r.excluded_reason.trim()) {
      result.append(
        el("p", {
          class: "small",
          text: "The job is saved, but your search filters exclude it, so it only shows in JobHuntPA's Jobs list with \u201cShow excluded\u201d ticked.",
        }),
        el("p", { class: "small muted", id: "excluded-reason", text: r.excluded_reason.trim() }),
      );
    }
    show(result);
    result.querySelector("a")?.focus();
  } catch (err) {
    setError(status, err, cfg);
  } finally {
    btn.disabled = false;
  }
}

// ---------- add the jobs on a page of search results ----------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Fills the "Jobs on this page" tab from the cards read from the page; the tab only shows when there are any.
 * With `pickTab`, the tab is opened when the page shows no single job of its own (a results page).
 */
function renderListing(pickTab) {
  const tabBtn = $("#tab-list");
  const jobs = listing ? listing.jobs : [];
  show(tabBtn, jobs.length > 0);
  show($("#list-status"), false);
  show($("#list-result"), false);
  const ul = $("#list-jobs");
  clear(ul);
  listRows = [];
  if (!jobs.length) {
    if (tabBtn.getAttribute("aria-selected") === "true") selectTab($("#tab-job"));
    return;
  }
  const fresh = jobs.filter((j) => j.is_new).length;
  $("#list-note").textContent = listingNote(jobs) + (fresh && fresh < jobs.length ? " Those are ticked." : "");
  show($("#pick-new"), fresh > 0 && fresh < jobs.length);
  for (const job of jobs) {
    const box = el("input", { type: "checkbox" });
    box.checked = fresh ? job.is_new : true;
    box.addEventListener("change", updateListButton);
    const tags = [];
    if (job.is_new) tags.push("New to you");
    const meta = [job.company, job.location_text, job.salary_text, job.listed].filter(Boolean).join(" \u00b7 ");
    const text = el("span", { class: "jobrow" }, el("span", { class: "jobrow-title", text: job.title }));
    if (meta) text.append(el("span", { class: "jobrow-meta", text: meta }));
    for (const t of tags) text.append(el("span", { class: "tag", text: t }));
    const item = el("li", {}, el("label", {}, box, text));
    ul.append(item);
    listRows.push({ job, box, item, done: false });
  }
  if ((cfg.api || 1) < LIST_API) {
    setStatus($("#list-status"), OLD_SERVER, { kind: "warn" });
    show($("#list-status"));
  }
  updateListButton();
  if (pickTab && extracted && extracted.job.method === "page") {
    selectTab(tabBtn);
    if (!$("#list-save").disabled) $("#list-save").focus();
  }
}

function pickJobs(want) {
  for (const row of listRows) if (!row.done) row.box.checked = !!want(row.job);
  updateListButton();
}

function updateListButton() {
  const n = listRows.filter((r) => r.box.checked && !r.done).length;
  const btn = $("#list-save");
  btn.textContent = n ? `Add ${plural(n, "job")}` : "Add jobs";
  btn.disabled = !n || listBusy || (cfg.api || 1) < LIST_API;
}

/** Shows under a job what became of it, and takes it out of the next "Add". `saved` is the server's answer for it. */
function markRow(row, saved) {
  row.done = true;
  row.box.checked = false;
  row.box.disabled = true;
  const p = el("p", { class: "outcome" });
  if (!saved) p.append(document.createTextNode("Sent."));
  else {
    const filtered = typeof saved.excluded_reason === "string" && saved.excluded_reason.trim();
    const what = saved.created === false ? "Already in JobHuntPA" : filtered ? "Added, but your search filters exclude it" : "Added";
    p.append(document.createTextNode(`${what} \u2014 `), serverAnchor("open", saved.link || ""));
  }
  row.item.append(p);
}

async function onSaveList(e) {
  e.preventDefault();
  const status = $("#list-status");
  const result = $("#list-result");
  const picked = listRows.filter((r) => r.box.checked && !r.done);
  if (!picked.length || listBusy) return;
  listBusy = true;
  updateListButton();
  show(result, false);
  setStatus(status, `Adding ${plural(picked.length, "job")}\u2026 this can take a minute.`, { busy: true });
  show(status);
  let added = 0;
  let existing = 0;
  let excluded = 0;
  let failed = null;
  try {
    await statusReady; // the workspace may still be checked; a failure is reported below
    for (let i = 0; i < picked.length; i += LIST_LIMITS.jobs) {
      const part = picked.slice(i, i + LIST_LIMITS.jobs);
      const r = await api(cfg, "POST", "/api/extension/jobs/batch", buildListBody(listing, part.map((row) => row.job)), { timeout: TIMEOUT.list });
      const out = Array.isArray(r.jobs) ? r.jobs : [];
      part.forEach((row, n) => markRow(row, out.length === part.length ? out[n] : null));
      for (const o of out) {
        if (o.created === false) existing++;
        else {
          added++;
          if (typeof o.excluded_reason === "string" && o.excluded_reason.trim()) excluded++;
        }
      }
    }
  } catch (err) {
    failed = err;
  } finally {
    listBusy = false;
    updateListButton();
  }
  if (failed) {
    if (failed.status === 403 && failed.code === "token_scope") setStatus(status, OLD_SERVER, { kind: "warn" });
    else setError(status, failed, cfg);
    if (!added && !existing) return;
  } else {
    show(status, false);
  }
  clear(result);
  result.className = "status ok";
  const lines = [added ? `Added ${plural(added, "job")}.` : "No new jobs were added."];
  if (existing) lines.push(`${plural(existing, "job")} ${existing === 1 ? "was" : "were"} already in JobHuntPA and ${existing === 1 ? "was left as it is" : "were left as they are"}.`);
  result.append(el("p", {}, document.createTextNode(`${lines.join(" ")} `), serverAnchor("Open JobHuntPA", "/")));
  if (excluded) {
    result.append(
      el("p", {
        class: "small",
        id: "list-excluded",
        text: `Your search filters exclude ${excluded === added ? (added === 1 ? "it" : "all of them") : `${excluded} of the added jobs`}, so ${excluded === 1 ? "it only shows" : "those only show"} in JobHuntPA's Jobs list with \u201cShow excluded\u201d ticked.`,
      }),
    );
  }
  show(result);
  result.querySelector("a")?.focus();
}

// ---------- add source ----------

function describeSource(url, label) {
  return label ? `${label} (${url})` : url;
}

async function onAddSource(e) {
  e.preventDefault();
  const status = $("#source-status");
  const url = $("#s-url").value.trim();
  const label = $("#s-label").value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setStatus(status, "Enter a web address starting with http:// or https://.", { kind: "warn" });
    show(status);
    return;
  }
  const btn = $("#source-add");
  btn.disabled = true;
  show($("#source-test"), false);
  setStatus(status, "Adding…", { busy: true });
  show(status);
  try {
    await statusReady; // the workspace may still be checked; a failure is reported below
    if (!(await hasServerAccess(cfg.server))) {
      setStatus(status, "No permission for your JobHuntPA server yet. Grant it in Options.", { kind: "error", optionsLink: true });
      return;
    }
    const body = label ? { url, label } : { url };
    const s = await api(cfg, "POST", "/api/sources", body, { timeout: TIMEOUT.source });
    source = { id: s.id, url };
    setStatus(status, `Added as a source: ${describeSource(s.url || url, s.label || label)}. The next searches will crawl it.`, { kind: "ok" });
    show($("#source-test"));
  } catch (err) {
    if (err.status === 409) {
      setStatus(status, "This page is already one of your sources.", { kind: "warn" });
      await findExistingSource(url);
    } else {
      setError(status, err, cfg);
    }
  } finally {
    btn.disabled = false;
  }
}

/** After a 409, find the existing source so it can still be tested. Best effort. */
async function findExistingSource(url) {
  try {
    const list = await api(cfg, "GET", "/api/sources", undefined, { timeout: TIMEOUT.source });
    const norm = (u) => String(u || "").replace(/\/+$/, "").toLowerCase();
    const hit = Array.isArray(list) ? list.find((s) => norm(s.url) === norm(url)) : null;
    if (hit) {
      source = { id: hit.id, url };
      show($("#source-test"));
    }
  } catch {
    /* the warning above already tells the user what matters */
  }
}

async function onTestSource() {
  if (!source) return;
  const status = $("#source-status");
  const btn = $("#source-test");
  btn.disabled = true;
  setStatus(status, "Testing this source… this can take up to a minute.", { busy: true });
  show(status);
  try {
    const r = await api(cfg, "POST", `/api/sources/${encodeURIComponent(source.id)}/test`, {}, { timeout: TIMEOUT.test });
    clear(status);
    if (r.ok) {
      const n = Number(r.count) || 0;
      status.className = "status " + (n > 0 ? "ok" : "warn");
      status.append(
        el("p", { text: n > 0 ? `Found ${n} posting${n === 1 ? "" : "s"}${r.method ? ` (read via ${r.method})` : ""}.` : "No postings found on this page." }),
      );
      const sample = Array.isArray(r.sample) ? r.sample.slice(0, 5) : [];
      if (sample.length) {
        const ul = el("ul", { class: "samples" });
        for (const s of sample) ul.append(el("li", { text: [s.title, s.location].filter(Boolean).join(" — ") }));
        status.append(ul);
      }
    } else {
      status.className = "status error";
      status.append(el("p", { text: str(r.error) || "The test did not find any postings." }));
    }
    const notes = Array.isArray(r.notes) ? r.notes : [];
    if (notes.length) {
      const ul = el("ul", { class: "notes" });
      for (const n of notes) ul.append(el("li", { text: String(n) }));
      status.append(ul);
    }
  } catch (err) {
    setError(status, err, cfg);
  } finally {
    btn.disabled = false;
  }
}

init().catch((err) => {
  show($("#main"), false);
  show($("#setup"));
  const p = el("p", { class: "status error", text: `Something went wrong: ${err?.message || err}` });
  $("#setup").append(p);
});
