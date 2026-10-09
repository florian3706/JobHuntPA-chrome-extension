import { ext } from "./ext.js";

// Everything lives in storage.local (never storage.sync: the key must not leave this device).
const KEYS = ["server", "key", "workspace", "workspaces", "label", "expiresAt"];

export async function loadConfig() {
  const c = await ext.storage.local.get(KEYS);
  if (!c.server || !c.key) return null;
  return {
    server: c.server,
    key: c.key,
    workspace: c.workspace ?? null,
    workspaces: Array.isArray(c.workspaces) ? c.workspaces : [],
    label: c.label || "",
    expiresAt: c.expiresAt || "",
  };
}

export async function saveConfig(patch) {
  await ext.storage.local.set(patch);
}

export async function clearConfig() {
  await ext.storage.local.remove(KEYS);
}

export const originPattern = (server) => `${server}/*`;

export async function hasServerAccess(server) {
  try {
    return await ext.permissions.contains({ origins: [originPattern(server)] });
  } catch {
    return false;
  }
}
