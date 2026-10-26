// Runs first in the popup's and the options page's <head> (a plain script, not a module, so nothing is painted
// before it): paints the theme stored by lib/theme.js, then lets the page show (css/base.css hides the body while
// <html> carries theme-pending). Nothing stored, or storage unavailable: the app's default, Vanilla Dark. The same
// rules as lib/theme.js resolveTheme, kept tiny here on purpose.
(function () {
  var DEFAULT = "vanilla-dark-aa";
  var root = document.documentElement;
  function show(pref) {
    var id = typeof pref === "string" && /^[a-z-]{1,40}$/.test(pref) ? pref : DEFAULT;
    if (id === "system") id = window.matchMedia("(prefers-color-scheme: dark)").matches ? "vanilla-dark-aa" : "vanilla-light-aa";
    root.setAttribute("data-theme", id);
    root.classList.remove("theme-pending");
  }
  var api = globalThis.browser || globalThis.chrome;
  try {
    api.storage.local.get(["theme"]).then(function (c) { show(c && c.theme); }, function () { show(); });
  } catch (e) {
    show();
  }
  // A storage call that never answers must not leave the page blank.
  setTimeout(function () { root.classList.remove("theme-pending"); }, 300);
})();
