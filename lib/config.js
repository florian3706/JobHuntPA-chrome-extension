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

/**
 * Reset: forgets the whole setup (the server address, the key, the workspace and what was remembered about them)
 * and withdraws the permission for the server. The key itself keeps working until it is disconnected in JobHuntPA.
 */
export async function resetSetup() {
  const { server } = await ext.storage.local.get(["server"]);
  await clearConfig();
  if (server) {
    try {
      await ext.permissions.remove({ origins: [originPattern(server)] });
    } catch {
      /* already gone */
    }
  }
}

export async function hasServerAccess(server) {
  try {
    return await ext.permissions.contains({ origins: [originPattern(server)] });
  } catch {
    return false;
  }
}
