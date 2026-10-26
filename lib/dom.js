// Small DOM helpers. Text is always set with textContent / createTextNode, never as HTML,
// because everything coming from the server or the page is untrusted.
export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export function clear(node) {
  node.replaceChildren();
}

// A notification's icon (css/base.css .status): the kind's shape, never colour alone.
const ICON_PATHS = {
  ok: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M8 12.5l2.5 2.5L16 9.5"],
  warn: ["M12 3l10 18H2z", "M12 10v5M12 18v.5"],
  error: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M9 9l6 6M15 9l-6 6"],
  info: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 11v6M12 7.5v.5"],
};

function statusIcon(kind) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ class: "status__icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
  for (const d of ICON_PATHS[kind] || ICON_PATHS.info) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Empties a status box, gives it its kind ("" plain, "ok", "warn", "error", "info") and its icon (a spinner while
 * `busy`), and returns the body to put the message and the actions in.
 */
export function statusBody(box, kind = "", busy = false) {
  clear(box);
  box.className = "status" + (kind ? ` ${kind}` : "");
  box.append(busy ? el("span", { class: "spinner", "aria-hidden": "true" }) : statusIcon(kind));
  const body = el("div", { class: "status__body" });
  box.append(body);
  return body;
}
