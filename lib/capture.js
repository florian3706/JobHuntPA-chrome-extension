import { ext } from "./ext.js";

export const LIMITS = { url: 2048, page_title: 1000, html: 3000000, text: 300000, selection: 100000 };

/** Runs inside the page (serialised by scripting.executeScript): must not use anything outside itself. */
function readPage(limits) {
  const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) : s || "");
  let html = document.documentElement ? document.documentElement.outerHTML : "";
  if (html.length > limits.html) {
    // Too big: drop what never holds a posting (styles, drawings, scripts other than data blocks).
    try {
      const copy = document.documentElement.cloneNode(true);
      for (const n of copy.querySelectorAll("style, svg, noscript, link, script")) {
        const type = (n.getAttribute("type") || "").toLowerCase();
        const keep = n.tagName === "SCRIPT" && (type.includes("json") || n.id === "__NEXT_DATA__");
        if (!keep) n.remove();
      }
      html = copy.outerHTML;
    } catch (e) {
      /* keep the original */
    }
  }
  return {
    url: cut(location.href, limits.url + 1), // one over so the caller can notice it was too long
    page_title: cut(document.title, limits.page_title),
    html: cut(html, limits.html),
    text: cut(document.body ? document.body.innerText : "", limits.text),
    selection: cut(String(window.getSelection ? window.getSelection() : ""), limits.selection),
  };
}

export class CaptureError extends Error {}

export function isReadableUrl(url) {
  return /^https?:\/\//i.test(url || "");
}

export async function activeTab() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

export async function capturePage(tab) {
  if (!tab || tab.id == null) throw new CaptureError("There is no page to read in this window.");
  if (!isReadableUrl(tab.url)) {
    throw new CaptureError(
      "The browser does not let extensions read this kind of page (browser pages, add-on stores, new tabs, local files). Open a normal web page and try again.",
    );
  }
  let results;
  try {
    results = await ext.scripting.executeScript({ target: { tabId: tab.id }, func: readPage, args: [LIMITS] });
  } catch {
    throw new CaptureError(
      "The browser would not let this extension read the page (for example a PDF viewer, a store page or a page still loading). Reload the page and open the extension again.",
    );
  }
  const page = results && results[0] && results[0].result;
  if (!page || !page.url) throw new CaptureError("The page could not be read. Reload it and try again.");
  if (page.url.length > LIMITS.url) throw new CaptureError("This page's address is too long for JobHuntPA (over 2048 characters).");
  return page;
}
