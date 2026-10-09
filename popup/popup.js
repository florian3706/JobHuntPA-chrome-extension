import { ext } from "../lib/ext.js";
import { $, el, clear } from "../lib/dom.js";
import { api, describeError, serverLink } from "../lib/api.js";
import { loadConfig, saveConfig, hasServerAccess } from "../lib/config.js";
import { activeTab, capturePage, CaptureError, isReadableUrl } from "../lib/capture.js";

let cfg = null;
let tab = null;
let page = null; // captured page, reused for save and when the workspace changes
let preview = null;
let previewSeq = 0;
let source = null; // { id, url } once the page is a source

const TIMEOUT = { status: 15000, preview: 40000, save: 40000, source: 30000, test: 90000 };

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

function setupTabs() {
  const tabs = [$("#tab-job"), $("#tab-source")];
  const panels = { "tab-job": $("#panel-job"), "tab-source": $("#panel-source") };
  const select = (t, focus) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      show(panels[x.id], on);
    }
    if (focus) t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => select(t, false));
    t.addEventListener("keydown", (e) => {
      let j = -1;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i + tabs.length - 1) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j >= 0) {
        e.preventDefault();
        select(tabs[j], true);
      }
    });
  });
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
    if (page) runPreview();
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
    const [captured] = await Promise.all([recapture || !page ? capturePage(tab) : page, refreshStatus()]);
    page = captured;
    if (page.url && !$("#s-url").value) $("#s-url").value = page.url;
    await runPreview();
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
async function refreshStatus() {
  const s = await api(cfg, "GET", "/api/extension/status", undefined, { timeout: TIMEOUT.status });
  const list = Array.isArray(s.workspaces) ? s.workspaces.map((w) => ({ id: w.id, name: String(w.name) })) : [];
  cfg.workspaces = list;
  if (!list.some((w) => w.id === cfg.workspace)) {
    cfg.workspace = list.some((w) => w.id === s.default_workspace) ? s.default_workspace : list[0]?.id ?? null;
  }
  await saveConfig({ workspaces: list, workspace: cfg.workspace, expiresAt: s.expires_at || "" });
  fillWorkspaces();
}

function pageBody(fields) {
  return {
    url: page.url,
    page_title: page.page_title,
    html: page.html,
    text: page.text,
    selection: page.selection,
    fields: fields || {},
  };
}

async function runPreview() {
  const seq = ++previewSeq;
  const status = $("#job-status");
  show($("#job-form"), false);
  show($("#job-result"), false);
  setStatus(status, "Asking JobHuntPA what job this page describes…", { busy: true });
  show(status);
  try {
    const r = await api(cfg, "POST", "/api/extension/preview", pageBody(), { timeout: TIMEOUT.preview });
    if (seq !== previewSeq) return;
    preview = r;
    renderPreview(r);
    show(status, false);
  } catch (err) {
    if (seq !== previewSeq) return;
    if (err.status === 422 && err.field === "title") {
      // No title could be read: let the user type one (and the rest); saving sends the page again.
      preview = { job: {}, existing: null, notes: [err.detail || "No job title was found on this page. Type one in, then save."] };
      renderPreview(preview);
      show(status, false);
      return;
    }
    setError(status, err, cfg, [["Try again", runPreview]]);
  }
}

const str = (v) => (v == null ? "" : String(v));

function renderPreview(r) {
  const job = r.job || {};
  $("#f-title").value = str(job.title);
  $("#f-company").value = str(job.company);
  $("#f-location").value = str(job.location_text);
  $("#f-salary").value = str(job.salary_text);
  $("#f-type").value = str(job.employment_type);
  const mode = ["onsite", "hybrid", "remote"].includes(job.work_mode) ? job.work_mode : "";
  $("#f-mode").value = mode;
  $("#f-desc").value = str(job.description_preview);
  const chars = Number(job.description_chars) || 0;
  const from = { selection: "your selected text", structured: "the page's job data", page: "the page text" }[job.description_from];
  $("#desc-label").textContent =
    "Description (preview" + (chars ? `, ${chars.toLocaleString()} characters` : "") + (from ? `, from ${from}` : "") + ")";

  const notes = $("#job-notes");
  clear(notes);
  for (const n of Array.isArray(r.notes) ? r.notes : []) notes.append(el("li", { text: String(n) }));

  const ex = $("#job-existing");
  if (r.existing) {
    clear(ex);
    ex.append(
      el("p", {}, document.createTextNode("Already in JobHuntPA: "), serverAnchor(str(r.existing.title) || "open it", r.existing.link || ""),
        document.createTextNode(r.existing.status ? ` (${r.existing.status}).` : ".")),
      el("p", { class: "small", text: "Saving updates that job with the values below." }),
    );
    show(ex);
    $("#job-save").textContent = "Update job";
  } else {
    show(ex, false);
    $("#job-save").textContent = "Save job";
  }
  show($("#job-form"));
  $("#f-title").focus();
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
  for (const k of Object.keys(f)) if (!f[k]) delete f[k];
  return f;
}

async function onSaveJob(e) {
  e.preventDefault();
  const btn = $("#job-save");
  const result = $("#job-result");
  const status = $("#job-status");
  btn.disabled = true;
  show(result, false);
  setStatus(status, "Saving…", { busy: true });
  show(status);
  try {
    const r = await api(cfg, "POST", "/api/extension/jobs", pageBody(collectFields()), { timeout: TIMEOUT.save });
    show(status, false);
    clear(result);
    const verb = r.created === false ? "Updated the existing job" : "Saved";
    result.className = "status ok";
    result.append(
      el("p", {}, document.createTextNode(`${verb} — `), serverAnchor("Open in JobHuntPA", r.link || "")),
      el("p", { class: "small muted", text: [r.title, r.company].filter(Boolean).join(" · ") }),
    );
    show(result);
    result.querySelector("a")?.focus();
  } catch (err) {
    setError(status, err, cfg);
  } finally {
    btn.disabled = false;
  }
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
