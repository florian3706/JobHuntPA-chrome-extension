import { ext } from "./lib/ext.js";
import { loadConfig } from "./lib/config.js";

// First install: open the options page so the user can connect to their server.
ext.runtime.onInstalled.addListener(async (details) => {
  if (details.reason !== "install") return;
  if (!(await loadConfig())) ext.runtime.openOptionsPage();
});
