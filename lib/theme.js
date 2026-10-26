// The theme: the popup and the options page paint the theme chosen for the JobHuntPA account (Settings > Theme),
// which the server sends with GET /api/extension/status ("theme", since the app's 2.1.0 successor; an older server
// sends none). It is kept in storage.local beside the server address, read before the pages show (lib/theme-boot.js)
// and applied here once the status answers. The ids and labels are the app's THEMES (frontend/common.js); the
// colours are css/themes.css, a copy of the app's. There is no theme setting of the extension's own.
import { ext } from "./ext.js";

export const DEFAULT_THEME = "vanilla-dark-aa"; // the app's default for a new install (also in theme-boot.js)

/** Every theme the app offers: id, its name in the picker, light or dark (`auto`: System). */
export const THEMES = [
  { id: "system", label: "System", mode: "auto" },
  { id: "vanilla-dark-aa", label: "Vanilla Dark", mode: "dark" },
  { id: "vanilla-dark", label: "Vanilla Dark (exact)", mode: "dark" },
  { id: "vanilla-light-aa", label: "Vanilla Light", mode: "light" },
  { id: "vanilla-light", label: "Vanilla Light (exact)", mode: "light" },
  { id: "dark", label: "Dark", mode: "dark" },
  { id: "light", label: "Light", mode: "light" },
  { id: "catppuccin-latte-aa", label: "Catppuccin Latte", mode: "light" },
  { id: "catppuccin-latte", label: "Catppuccin Latte (exact)", mode: "light" },
  { id: "catppuccin-frappe-aa", label: "Catppuccin Frappé", mode: "dark" },
  { id: "catppuccin-frappe", label: "Catppuccin Frappé (exact)", mode: "dark" },
  { id: "catppuccin-macchiato-aa", label: "Catppuccin Macchiato", mode: "dark" },
  { id: "catppuccin-macchiato", label: "Catppuccin Macchiato (exact)", mode: "dark" },
  { id: "catppuccin-mocha-aa", label: "Catppuccin Mocha", mode: "dark" },
  { id: "catppuccin-mocha", label: "Catppuccin Mocha (exact)", mode: "dark" },
  { id: "rose-pine-aa", label: "Rosé Pine", mode: "dark" },
  { id: "rose-pine", label: "Rosé Pine (exact)", mode: "dark" },
  { id: "rose-pine-moon-aa", label: "Rosé Pine Moon", mode: "dark" },
  { id: "rose-pine-moon", label: "Rosé Pine Moon (exact)", mode: "dark" },
  { id: "rose-pine-dawn-aa", label: "Rosé Pine Dawn", mode: "light" },
  { id: "rose-pine-dawn", label: "Rosé Pine Dawn (exact)", mode: "light" },
  { id: "nord-aa", label: "Nord", mode: "dark" },
  { id: "nord", label: "Nord (exact)", mode: "dark" },
  { id: "nord-light-aa", label: "Nord Light", mode: "light" },
  { id: "nord-light", label: "Nord Light (exact)", mode: "light" },
  { id: "kanagawa-wave-aa", label: "Kanagawa Wave", mode: "dark" },
  { id: "kanagawa-wave", label: "Kanagawa Wave (exact)", mode: "dark" },
  { id: "kanagawa-dragon-aa", label: "Kanagawa Dragon", mode: "dark" },
  { id: "kanagawa-dragon", label: "Kanagawa Dragon (exact)", mode: "dark" },
  { id: "kanagawa-lotus-aa", label: "Kanagawa Lotus", mode: "light" },
  { id: "kanagawa-lotus", label: "Kanagawa Lotus (exact)", mode: "light" },
  { id: "everforest-dark-aa", label: "Everforest Dark", mode: "dark" },
  { id: "everforest-dark", label: "Everforest Dark (exact)", mode: "dark" },
  { id: "everforest-light-aa", label: "Everforest Light", mode: "light" },
  { id: "everforest-light", label: "Everforest Light (exact)", mode: "light" },
  { id: "dyslexia", label: "Dyslexia", mode: "light" },
  { id: "dyslexia-dark", label: "Dyslexia (dark)", mode: "dark" },
  { id: "protanomaly", label: "Protanomaly", mode: "light" },
  { id: "protanomaly-dark", label: "Protanomaly (dark)", mode: "dark" },
  { id: "deuteranomaly", label: "Deuteranomaly", mode: "light" },
  { id: "deuteranomaly-dark", label: "Deuteranomaly (dark)", mode: "dark" },
  { id: "tritanomaly", label: "Tritanomaly", mode: "light" },
  { id: "tritanomaly-dark", label: "Tritanomaly (dark)", mode: "dark" },
  { id: "dichromacy", label: "Dichromacy", mode: "light" },
  { id: "dichromacy-dark", label: "Dichromacy (dark)", mode: "dark" },
  { id: "monochromacy", label: "Monochromacy", mode: "light" },
  { id: "monochromacy-dark", label: "Monochromacy (dark)", mode: "dark" },
];

const IDS = new Set(THEMES.map((t) => t.id));

/** The theme id the server sent, when it is one the extension knows; "" otherwise (nothing chosen, or an unknown id). */
export function knownTheme(value) {
  return typeof value === "string" && IDS.has(value) ? value : "";
}

/** The theme to paint for a stored preference: System follows the device; nothing stored is the app's default. */
export function resolveTheme(pref) {
  const id = knownTheme(pref) || DEFAULT_THEME;
  if (id !== "system") return id;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "vanilla-dark-aa" : "vanilla-light-aa";
}

/** Paints `pref` on this page now. */
export function applyTheme(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
  document.documentElement.classList.remove("theme-pending");
}

/** What the Settings view says about the theme: its name, and where it comes from. */
export function describeTheme(pref) {
  const id = knownTheme(pref);
  if (!id) return `${THEMES.find((t) => t.id === DEFAULT_THEME).label} (JobHuntPA's default; choose one in JobHuntPA, Settings)`;
  const t = THEMES.find((x) => x.id === id);
  return `${t.label}${id === "system" ? " (light or dark, as this device)" : ""}, from your JobHuntPA account`;
}

/**
 * Keeps the page in step: the theme stored by another page of the extension (the options page while the popup is
 * open, or the other way round), and the device's light/dark switch while the theme is System.
 */
export function followTheme() {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) applyTheme(changes.theme.newValue);
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => {
    const { theme } = await ext.storage.local.get(["theme"]);
    if ((knownTheme(theme) || DEFAULT_THEME) === "system") applyTheme(theme);
  });
}
