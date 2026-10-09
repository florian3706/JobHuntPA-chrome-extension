import { ext } from "../lib/ext.js";
import { $, el, clear } from "../lib/dom.js";
import { api, normalizeServer, describeError, KEY_PATTERN } from "../lib/api.js";
import { loadConfig, saveConfig, clearConfig, originPattern } from "../lib/config.js";

const statusBox = $("#status");
let current = null;

function setStatus(message, kind = "") {
  clear(statusBox);
  statusBox.className = "status" + (kind ? ` ${kind}` : "");
  statusBox.append(el("p", { text: message }));
}

function renderConnected(cfg) {
  current = cfg;
  const on = !!cfg;
  $("#disconnect").classList.toggle("hidden", !on);
  $("#ws-box").classList.toggle("hidden", !on || !cfg.workspaces.length);
  if (!on) return;
  $("#server").value = cfg.server;
  $("#key").value = "";
  $("#key").placeholder = "Saved. Paste a new key only to replace it.";
  const sel = $("#workspace");
  clear(sel);
  for (const w of cfg.workspaces) sel.append(el("option", { value: String(w.id), text: w.name }));
  if (cfg.workspace != null) sel.value = String(cfg.workspace);
}

async function init() {
  const cfg = await loadConfig();
  renderConnected(cfg);
  if (cfg) {
    const until = cfg.expiresAt ? ` Key valid until ${new Date(cfg.expiresAt).toLocaleDateString()}.` : "";
    setStatus(`Connected to ${cfg.server}${cfg.label ? ` as "${cfg.label}"` : ""}.${until}`, "ok");
  }
}

$("#toggle-key").addEventListener("click", () => {
  const input = $("#key");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("#toggle-key").textContent = show ? "Hide" : "Show";
  $("#toggle-key").setAttribute("aria-pressed", String(show));
});

// Enter in a field presses Connect (a plain click handler keeps permissions.request inside a user gesture).
$("#connect-form").addEventListener("submit", (e) => e.preventDefault());
for (const id of ["#server", "#key"]) {
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#connect").click();
    }
  });
}

// IMPORTANT: no `await` before permissions.request (Firefox requires it inside the user's click).
$("#connect").addEventListener("click", () => {
  let server;
  try {
    server = normalizeServer($("#server").value);
  } catch (err) {
    setStatus(err.message, "error");
    return;
  }
  const typedKey = $("#key").value.trim();
  const keepKey = !typedKey && current && current.server === server;
  if (!keepKey && !KEY_PATTERN.test(typedKey)) {
    setStatus(
      typedKey
        ? "That does not look like an extension key. It starts with jhpa_ and is about 48 characters long."
        : "Paste the extension key from JobHuntPA (Settings, Browser extension).",
      "error",
    );
    return;
  }
  const granted = ext.permissions.request({ origins: [originPattern(server)] });
  connect(server, keepKey ? current.key : typedKey, granted);
});

async function connect(server, key, grantedPromise) {
  $("#connect").disabled = true;
  setStatus("Connecting…");
  try {
    let granted = false;
    try {
      granted = await grantedPromise;
    } catch (err) {
      setStatus(`The browser refused the permission request: ${err?.message || err}`, "error");
      return;
    }
    if (!granted) {
      setStatus(`Without permission for ${server} the extension cannot talk to your server. Press Connect again and allow it.`, "error");
      return;
    }
    const probe = { server, key, workspace: server === current?.server ? current.workspace : null };
    let s;
    try {
      s = await api(probe, "GET", "/api/extension/status", undefined, { timeout: 15000 });
    } catch (err) {
      const d = describeError(err, probe);
      setStatus(d.message.replace(/ Reconnect in Options\.$/, " Check the key you pasted."), "error");
      return;
    }
    const workspaces = (Array.isArray(s.workspaces) ? s.workspaces : []).map((w) => ({ id: w.id, name: String(w.name) }));
    const keep = workspaces.find((w) => w.id === probe.workspace);
    const workspace = keep ? keep.id : workspaces.some((w) => w.id === s.default_workspace) ? s.default_workspace : workspaces[0]?.id ?? null;
    const oldServer = current?.server;
    await saveConfig({ server, key, workspace, workspaces, label: s.label || "", expiresAt: s.expires_at || "" });
    if (oldServer && oldServer !== server) {
      ext.permissions.remove({ origins: [originPattern(oldServer)] }).catch(() => {});
    }
    renderConnected(await loadConfig());
    setStatus(`Connected to ${server}${s.label ? ` as "${s.label}"` : ""}. You can close this page and use the toolbar button.`, "ok");
  } finally {
    $("#connect").disabled = false;
  }
}

$("#workspace").addEventListener("change", async (e) => {
  const id = Number(e.target.value);
  await saveConfig({ workspace: id });
  if (current) current.workspace = id;
});

$("#disconnect").addEventListener("click", async () => {
  const server = current?.server;
  await clearConfig();
  if (server) {
    try {
      await ext.permissions.remove({ origins: [originPattern(server)] });
    } catch {
      /* already gone */
    }
  }
  renderConnected(null);
  $("#key").placeholder = "jhpa_…";
  $("#server").value = "";
  setStatus("Disconnected. The key was removed from this browser and the permission for your server was withdrawn. You may also revoke the key in JobHuntPA.", "ok");
});

init();
