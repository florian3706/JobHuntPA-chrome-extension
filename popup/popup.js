import { ext } from "../lib/ext.js";
import { $, el, clear } from "../lib/dom.js";
import { api, describeError, serverLink } from "../lib/api.js";
import { loadConfig, saveConfig, hasServerAccess, resetSetup } from "../lib/config.js";
import { activeTab, capturePage, CaptureError, isReadableUrl, captureOutline, readMappedValues } from "../lib/capture.js";
import { extractJob, buildBody, notesFor, extractListing, buildListBody, listingNote, LIST_LIMITS } from "../lib/extract.js";
import { needsMapping, applyMappedValues, mappedPreview } from "../lib/extract.js";
import { siteOf, siteOfUrl, jobMappingFields, jobMappingOf, workOutRequest, FIELD_LABELS } from "../lib/mapping.js";

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
let pageExtracted = null; // the job as the page's own reading found it, before any mapping was applied
let mapChecked = false; // the site's saved mapping was looked up for this reading of the page
let mapBusy = false;
let mapSeq = 0; // a new reading of the page makes the answer of a work-out still running for the old one moot
let mapState = null; // the mapping being shown for acceptance: { site, fields, values }
let srcState = null; // the careers page being shown for acceptance: { url, label, mapping }

// A work-out may take up to 10 minutes on the server, which always answers before 15 (Part 8, 8.6).
const TIMEOUT = { status: 15000, preview: 40000, save: 40000, list: 120000, source: 30000, test: 90000, mapping: 15000, workOut: 15 * 60 * 1000 };
const LIST_API = 2; // the server's `api` number from which it takes a page of jobs
const MAPPING_API = 3; // ... from which it works pages out with its AI and keeps the layouts of job sites
const OLD_SERVER = "Your JobHuntPA server can't take a page of jobs yet. Update JobHuntPA, then open this again.";
const OLD_MAPPING = "Your JobHuntPA server can't work out pages yet. Update JobHuntPA, then try again.";

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
  setupSettings();
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
    srcState = null;
    show($("#source-test"), false);
    show($("#source-review"), false);
  });
  $("#map-accept").addEventListener("click", onAcceptMapping);
  $("#map-reject").addEventListener("click", onRejectMapping);
  $("#source-confirm").addEventListener("click", onConfirmSource);
  $("#source-cancel").addEventListener("click", () => {
    srcState = null;
    show($("#source-review"), false);
    show($("#source-status"), false);
    $("#source-add").focus();
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
    checkJob();
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
    show($("#source-review"), false);
    srcState = null;
    if (listing) renderListing(false); // what was added belongs to the other workspace
    if (extracted && !previewDue) runPreview();
  });
}

// ---------- settings: what this browser is connected to, reconnect, reset ----------

function setupSettings() {
  $("#settings-toggle").addEventListener("click", () => showSettings($("#settings").classList.contains("hidden")));
  $("#set-check").addEventListener("click", onCheckConnection);
  $("#set-reconnect").addEventListener("click", () => {
    ext.runtime.openOptionsPage(); // the browser's permission question needs a page that stays open
    window.close();
  });
  $("#set-reset").addEventListener("click", () => {
    show($("#set-status"), false);
    show($("#reset-confirm"));
    $("#reset-no").focus();
  });
  $("#reset-no").addEventListener("click", () => {
    show($("#reset-confirm"), false);
    $("#set-reset").focus();
  });
  $("#reset-yes").addEventListener("click", onReset);
}

function fillSettings() {
  $("#set-server").textContent = cfg.server;
  $("#set-label").textContent = cfg.label || "(no name)";
  $("#set-expires").textContent = cfg.expiresAt ? new Date(cfg.expiresAt).toLocaleDateString() : "unknown";
}

/** Shows the settings in place of the tabs, or the tabs again. */
function showSettings(on) {
  show($("#settings"), on);
  show($("#work"), !on);
  show($("#work-head"), !on);
  $("#settings-toggle").textContent = on ? "Back" : "Settings";
  if (!on) {
    $("#settings-toggle").focus();
    return;
  }
  fillSettings();
  show($("#set-status"), false);
  show($("#reset-confirm"), false);
  $("#settings-title").focus();
}

async function onCheckConnection() {
  const box = $("#set-status");
  const btn = $("#set-check");
  btn.disabled = true;
  show($("#reset-confirm"), false);
  setStatus(box, "Checking\u2026", { busy: true });
  show(box);
  try {
    if (!(await hasServerAccess(cfg.server))) {
      setStatus(box, `This extension has no permission for ${cfg.server} any more. Press Reconnect and connect again.`, { kind: "error" });
      return;
    }
    await refreshStatus();
    fillSettings();
    setStatus(box, "The connection works.", { kind: "ok" });
  } catch (err) {
    setError(box, err, cfg);
  } finally {
    btn.disabled = false;
  }
}

async function onReset() {
  await resetSetup();
  cfg = null;
  show($("#main"), false);
  const note = $("#setup-note");
  note.textContent = "Reset. The server address, the key and the workspace were removed from this browser.";
  show(note);
  show($("#setup"));
  $("#open-options").focus();
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
      pageExtracted = extracted;
      mapChecked = false;
      mapSeq++;
      mapBusy = false;
      mapState = null;
      show($("#map-box"), false);
      show($("#map-review"), false);
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
      await checkJob();
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
  cfg.expiresAt = s.expires_at || "";
  if (s.label) cfg.label = String(s.label);
  await saveConfig({ workspaces: list, workspace: cfg.workspace, expiresAt: cfg.expiresAt, label: cfg.label });
  fillWorkspaces();
  const box = $("#ws-notice");
  if (notice) {
    box.textContent = notice;
    show(box);
  } else {
    show(box, false);
  }
}

/** The saved layout of the site when the page's own reading needs one, then "is this job already there?". */
async function checkJob() {
  await lookupMapping();
  await runPreview();
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

// ---------- a job site JobHuntPA's AI worked out (api 3) ----------

/** The page's site (Part 8, 8.8), or "" when it has none the app takes. */
const pageSite = () => (pageExtracted ? siteOfUrl(pageExtracted.url) : "");

/** Whether the popup may look for, or offer to work out, a layout for this page. */
function mappable() {
  return !!pageSite() && (cfg.api || 1) >= MAPPING_API && needsMapping(pageExtracted) && !(listing && listing.jobs.length);
}

/**
 * When the page's own reading found no title or no description: the layout saved for the site (GET), applied to the
 * page with the browser's selector functions. None saved, or one that no longer finds a title: the offer to work the
 * site out. Runs once for each reading of the page.
 */
async function lookupMapping() {
  if (mapChecked) return;
  mapChecked = true;
  if (!mappable()) return;
  const site = pageSite();
  const box = $("#map-box");
  setStatus(box, `Looking for a layout saved for ${site}…`, { busy: true });
  show(box);
  try {
    await statusReady;
    const r = await api(cfg, "GET", `/api/extension/mappings/${encodeURIComponent(site)}`, undefined, { timeout: TIMEOUT.mapping });
    const fields = jobMappingFields(r.mapping);
    if (!fields) return offerWorkOut("stale", site); // a layout the app no longer accepts comes back as null
    const merged = applyMappedValues(pageExtracted, await readMappedValues(tab, fields));
    if (!merged) return offerWorkOut("stopped", site);
    extracted = merged;
    renderJob(extracted.job);
    setStatus(box, `Read with the layout JobHuntPA worked out for ${site}.`, { kind: "ok", actions: [["Work it out again", onWorkOut]] });
  } catch (err) {
    if (err.status === 404 && err.code === "not_found") return offerWorkOut("none", site);
    if (err instanceof CaptureError) return setStatus(box, err.message, { kind: "warn" });
    if (err.status === 403 && err.code === "token_scope") return show(box, false);
    if ([0, 401, 423, 429].includes(err.status)) return show(box, false); // the "already there?" check says it next
    setError(box, err, cfg);
  }
}

function offerWorkOut(why, site) {
  const text = {
    none:
      "JobHuntPA didn't find this job's title and description on this page. It can work out where this site shows them: JobHuntPA's AI looks at an outline of this page (the names of its parts, a few of their attributes and short samples of their text; no scripts, styles or form values).",
    stopped: `The layout saved for ${site} no longer finds the job's title on this page. JobHuntPA can work this site out again.`,
    stale: `The layout saved for ${site} can't be used any more (JobHuntPA was updated). JobHuntPA can work this site out again.`,
  }[why];
  setStatus($("#map-box"), text, { kind: why === "none" ? "" : "warn", actions: [[why === "none" ? "Work out this site" : "Work it out again", onWorkOut]] });
  show($("#map-box"));
}

/** What a failed work-out says; `retry` runs it again, `extra` are more [label, fn] actions. */
function workOutError(box, err, retry, extra = []) {
  if (err instanceof CaptureError) return setStatus(box, err.message, { kind: "warn", actions: extra });
  if (err.status === 429 && err.code === "busy") {
    return setStatus(box, "JobHuntPA is still working out the last page; try again in a minute.", { kind: "warn", actions: [["Try again", retry], ...extra] });
  }
  if (err.status === 403 && err.code === "token_scope") return setStatus(box, OLD_MAPPING, { kind: "warn", actions: extra });
  if (err.status === 400 && err.code === "ai_not_set_up") {
    return setStatus(box, err.detail || "Working out a page needs the AI, which isn't set up in JobHuntPA (Settings).", {
      kind: "error",
      actions: [["Open JobHuntPA", () => openServerLink("/")], ...extra],
    });
  }
  const d = describeError(err, cfg);
  const again = err.status === 0 || err.status === 502 || err.status === 504 || (err.status === 422 && err.code === "not_worked_out");
  setStatus(box, d.message, { kind: "error", optionsLink: d.optionsLink, actions: [...(again ? [["Try again", retry]] : []), ...extra] });
}

/** Sends the page's outline to JobHuntPA, whose AI works out the site's layout; shows the job it finds. */
async function onWorkOut() {
  if (mapBusy || !pageExtracted) return;
  const seq = mapSeq;
  const site = pageSite();
  const box = $("#map-box");
  mapBusy = true;
  mapState = null;
  show($("#map-review"), false);
  setStatus(box, "Working out this site… This may take a few minutes (JobHuntPA's tasks tray shows it too). Keep this window open: closing it loses the answer.", { busy: true });
  show(box);
  try {
    await statusReady;
    if ((cfg.api || 1) < MAPPING_API) return setStatus(box, OLD_MAPPING, { kind: "warn" });
    const { outline } = await captureOutline(tab); // built in the page; no HTML of it leaves the browser
    const body = workOutRequest("job", pageExtracted.url, outline);
    if (!body) throw new CaptureError("This page is too big to be worked out.");
    const r = await api(cfg, "POST", "/api/extension/work-out", body, { timeout: TIMEOUT.workOut });
    if (seq !== mapSeq) return; // the page was read again meanwhile
    const fields = jobMappingFields(r.mapping);
    if (!fields) {
      return setStatus(box, "JobHuntPA's answer had no page layout this extension can use. Try again, or type the job's details in.", { kind: "error", actions: [["Try again", onWorkOut]] });
    }
    showReview(siteOf(r.site) || site, fields, await readMappedValues(tab, fields)); // the answer's site only when it is one
  } catch (err) {
    if (seq === mapSeq) workOutError(box, err, onWorkOut);
  } finally {
    if (seq === mapSeq) mapBusy = false;
  }
}

/** Shows the job the worked-out layout finds on this page, field by field, before the person accepts it. */
function showReview(site, fields, values) {
  const dl = $("#map-fields");
  clear(dl);
  for (const { field, value } of mappedPreview(fields, values)) {
    dl.append(el("dt", { text: FIELD_LABELS[field] || field }));
    const text = field === "description" && value.length > 600 ? `${value.slice(0, 600)}…` : value;
    dl.append(el("dd", { class: value ? "" : "none", text: value ? text : "not found on this page" }));
  }
  const usable = !!applyMappedValues(pageExtracted, values);
  mapState = usable ? { site, fields, values } : null;
  $("#map-review-note").textContent = usable
    ? `JobHuntPA's AI worked out where ${site} shows each part of a job. On this page it finds:`
    : `JobHuntPA's AI answered with a layout for ${site}, but it finds no job title on this page, so it can't be used.`;
  show($("#map-accept"), usable);
  $("#map-reject").textContent = usable ? "Don't use it" : "Close";
  show($("#map-box"), false);
  show($("#map-review"));
  $("#map-review-title").focus();
}

/** Saves the layout for the site (PUT: the checked layout, rebuilt) and fills the form with the job it found. */
async function onAcceptMapping() {
  if (!mapState) return;
  const { site, fields, values } = mapState;
  const mapping = jobMappingOf(fields);
  const btn = $("#map-accept");
  const box = $("#map-box");
  btn.disabled = true;
  setStatus(box, `Saving the layout for ${site}…`, { busy: true });
  show(box);
  try {
    const r = await api(cfg, "PUT", `/api/extension/mappings/${encodeURIComponent(site)}`, { mapping }, { timeout: TIMEOUT.save });
    mapState = null;
    show($("#map-review"), false);
    const merged = applyMappedValues(pageExtracted, values);
    if (merged) {
      extracted = merged;
      renderJob(extracted.job);
      renderExisting(preview ? preview.existing : null);
    }
    setStatus(box, `Saved. JobHuntPA uses this layout for ${siteOf(r.site) || site} from now on. The form shows the job it found: check it, then save the job.`, { kind: "ok" });
  } catch (err) {
    if (err.status === 403 && err.code === "token_scope" && (cfg.api || 1) < MAPPING_API) setStatus(box, OLD_MAPPING, { kind: "warn" });
    else if (err.status === 409) setStatus(box, err.detail || "JobHuntPA can't keep another site's layout.", { kind: "error" });
    else setError(box, err, cfg, [["Try again", onAcceptMapping]]);
  } finally {
    btn.disabled = false;
  }
}

function onRejectMapping() {
  mapState = null;
  show($("#map-review"), false);
  setStatus($("#map-box"), "Not used: nothing was saved. The form has what the extension read from the page itself.", { actions: [["Work out this site", onWorkOut]] });
  show($("#map-box"));
  $("#f-title").focus();
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

/** Whether the source to add is the page the person has open, so JobHuntPA can show the jobs it finds there first. */
function checkable(url) {
  return (cfg.api || 1) >= MAPPING_API && !!tab && tab.url === url && isReadableUrl(url) && !!siteOfUrl(url);
}

async function onAddSource(e) {
  e.preventDefault();
  const status = $("#source-status");
  const url = $("#s-url").value.trim();
  const label = $("#s-label").value.trim();
  srcState = null;
  show($("#source-review"), false);
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
    if (checkable(url)) await checkSource(url, label);
    else await addSource(url, label, null);
  } catch (err) {
    setError(status, err, cfg);
  } finally {
    btn.disabled = false;
  }
}

/**
 * "Add as a source" for the open page (api 3): JobHuntPA reads the page itself the usual ways and, when they find no
 * jobs, its AI works out where the page lists them from the page's outline; the jobs the app found are shown before
 * anything is saved.
 */
async function checkSource(url, label) {
  const status = $("#source-status");
  srcState = null;
  show($("#source-review"), false);
  show($("#source-test"), false);
  setStatus(status, "Checking which jobs JobHuntPA finds on this page… It reads the page itself; when it finds none, its AI works out where the page lists them. This may take a few minutes (JobHuntPA's tasks tray shows it too).", { busy: true });
  show(status);
  const anyway = ["Add it anyway", () => addSource(url, label, null)];
  try {
    const { outline } = await captureOutline(tab);
    const body = workOutRequest("careers", url, outline);
    if (!body) throw new CaptureError("This page is too big to be worked out.");
    const r = await api(cfg, "POST", "/api/extension/work-out", body, { timeout: TIMEOUT.workOut });
    showSourceReview(r, url, label);
  } catch (err) {
    if (err.status === 422 && err.code === "refused_address") {
      setStatus(status, err.detail || "This address can't be a source: it is on your local network or this computer.", { kind: "error" });
    } else {
      workOutError(status, err, () => checkSource(url, label), [anyway]);
    }
  }
}

/** "no job postings found" -> "No job postings found." */
const sentence = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/\s+$/, "") + (/[.!?]$/.test(t.trim()) ? "" : ".") : "");

/** Shows the jobs the app found on the careers page (the work-out's dry run), with Add and Cancel. */
function showSourceReview(r, url, label) {
  const test = r && r.test && typeof r.test === "object" ? r.test : {};
  const n = Number(test.count) || 0;
  const found = test.ok === true && n > 0;
  const mapping = r && r.worked_out === true && r.mapping && typeof r.mapping === "object" && r.mapping.kind === "careers" ? r.mapping : null;
  const pageUrl = r && typeof r.url === "string" && /^https?:\/\//i.test(r.url) ? r.url : url;
  srcState = { url: pageUrl, label, mapping: found ? mapping : null };
  show($("#source-status"), false);
  const how = test.method ? ` (read via ${str(test.method)})` : "";
  $("#source-found").textContent = found
    ? `JobHuntPA found ${plural(n, "job")} on this page${mapping ? " with the layout its AI worked out for it" : ""}${how}. Check them, then add the page.`
    : `${sentence(str(test.error)) || "JobHuntPA found no jobs on this page."}${mapping ? " The layout its AI worked out found none either." : ""} You can still add the page; JobHuntPA's searches will read it again.`;
  const ul = $("#source-sample");
  clear(ul);
  for (const s of Array.isArray(test.sample) ? test.sample.slice(0, 8) : []) {
    if (s && typeof s === "object") ul.append(el("li", { text: [str(s.title), str(s.location)].filter(Boolean).join(" — ") }));
  }
  const notes = $("#source-notes");
  clear(notes);
  for (const x of Array.isArray(test.notes) ? test.notes : []) notes.append(el("li", { text: str(x) }));
  $("#source-confirm").textContent = found ? "Add as a source" : "Add it anyway";
  show($("#source-review"));
  $("#source-review-title").focus();
}

async function onConfirmSource() {
  if (!srcState) return;
  const { url, label, mapping } = srcState;
  srcState = null;
  await addSource(url, label, mapping);
}

/** POST /api/sources, with the careers mapping the app worked out when there is one. */
async function addSource(url, label, mapping) {
  const status = $("#source-status");
  show($("#source-review"), false);
  setStatus(status, "Adding…", { busy: true });
  show(status);
  const btns = [$("#source-add"), $("#source-confirm")];
  for (const b of btns) b.disabled = true;
  try {
    const body = { url };
    if (label) body.label = label;
    if (mapping) body.mapping = mapping;
    const s = await api(cfg, "POST", "/api/sources", body, { timeout: TIMEOUT.source });
    source = { id: s.id, url };
    const what = describeSource(str(s.url) || url, str(s.label) || label);
    setStatus(
      status,
      s.updated === true
        ? `This page was already one of your sources (${what}); it now has the layout JobHuntPA worked out for it.`
        : `Added as a source: ${what}. The next searches will crawl it${mapping ? " with the layout JobHuntPA worked out" : ""}.`,
      { kind: "ok" },
    );
    show($("#source-test"));
  } catch (err) {
    if (err.status === 409) {
      setStatus(status, "This page is already one of your sources.", { kind: "warn" });
      await findExistingSource(url);
    } else {
      setError(status, err, cfg);
    }
  } finally {
    for (const b of btns) b.disabled = false;
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
