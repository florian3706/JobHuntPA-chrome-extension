// AI mappings (JobHuntPA api 3, Part 8 of the app's docs/design/open-source.md): the site of a page, the limits of
// the page outline the extension sends when it asks JobHuntPA to work a page out, and the checks a mapping passes
// before the extension applies it. Pure functions (no extension APIs, no DOM): lib/capture.js builds the outline and
// applies a mapping inside the page; lib/extract.js turns what a mapping found into the job.
//
// A mapping is data, never code: CSS selectors and attribute names. The extension only ever hands a selector to
// document.querySelector and an attribute name to getAttribute; nothing of it is evaluated, inserted as HTML or used
// as an address.

/** The outline's caps (Part 8, 8.6). The app refuses an outline outside them whole. */
export const OUTLINE_LIMITS = {
  bytes: 200000, // the whole work-out request, as sent (UTF-8)
  elements: 2000, // the root included
  depth: 60, // the root is level 1
  title: 300, // document.title
  text: 100, // an element's own text sample
  attrValue: 200, // one attribute's value
  attrs: 12, // attributes of one element
  children: 50, // child elements kept of one element (the rest are left out: they are more of the same)
  lowChildren: 5, // ... of one element inside a navigation list, header menu, footer or sidebar
  visit: 40000, // elements looked at in all (a bound on the time the page walk takes)
};

/** The attributes an outline may carry (Part 8, 8.6), in the order they are kept. */
export const OUTLINE_ATTRIBUTES = [
  "id", "class", "role", "itemprop", "itemtype", "itemscope", "aria-label", "href", "datetime", "title",
  "data-testid", "data-test", "data-qa", "data-automation", "data-cy",
];
/** Elements never in an outline (an outline holding one is refused), with everything inside them. */
export const OUTLINE_LEFT_OUT = [
  "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object", "embed", "link", "meta", "base", "head",
];
/** Form fields: sent without any text (no form values). */
export const OUTLINE_FORM_FIELDS = ["input", "textarea", "select", "option"];
export const OUTLINE_TAG = /^[a-z][a-z0-9-]{0,39}$/;

/** The fields of a job page's mapping, in the app's order, and what the popup calls them. */
export const JOB_FIELDS = ["title", "company", "location", "salary", "employment_type", "work_mode", "date", "description"];
export const FIELD_LABELS = {
  title: "Title",
  company: "Company",
  location: "Location",
  salary: "Salary",
  employment_type: "Employment type",
  work_mode: "Work mode",
  date: "Posted",
  description: "Description",
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The site of a page (Part 8, 8.8) from its `location.hostname`: lower case, no trailing dot, a leading `www.` taken
 * off; "" when it isn't a host name the app takes (an IPv6 address in brackets, a name with `_`, a non-ASCII name the
 * browser didn't turn into punycode). The popup offers to work a page out only when it has a site.
 */
export function siteOf(hostname) {
  let h = typeof hostname === "string" ? hostname.trim().toLowerCase() : "";
  h = h.replace(/\.$/, "");
  if (h.startsWith("www.")) h = h.slice(4);
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return "";
  return h.split(".").every((l) => LABEL.test(l)) ? h : "";
}

/** The site of an http(s) address, or "". */
export function siteOfUrl(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? siteOf(u.hostname) : "";
  } catch {
    return "";
  }
}

const SELECTOR_CHARS = /^[A-Za-z0-9 _#.:>+~*[\]=^$|"'(),/?&%-]+$/;
const FORBIDDEN = /javascript\s*:|vbscript\s*:|livescript\s*:|url\s*\(|expression\s*\(|@import|\/\*|\*\//i;
const ATTRIBUTE = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * The fields of a job mapping as `[{name, selector, attribute}]` (in the app's order), or null when it isn't one in
 * the shape of Part 8, 8.7. The app checks every mapping it answers with; this is the extension's own check before
 * anything of it reaches the page: known fields only, a title and a description, selectors of the allowed characters
 * and length, attribute names that are names (never an event handler).
 */
export function jobMappingFields(mapping) {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return null;
  if (mapping.kind !== "job" || (mapping.version !== undefined && mapping.version !== 1)) return null;
  const fields = mapping.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
  const out = [];
  for (const [name, spec] of Object.entries(fields)) {
    if (!JOB_FIELDS.includes(name)) return null;
    if (spec === null) continue;
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
    if (Object.keys(spec).some((k) => k !== "selector" && k !== "attribute")) return null;
    const selector = typeof spec.selector === "string" ? spec.selector.trim() : "";
    if (!selector || selector.length > 300 || !SELECTOR_CHARS.test(selector) || FORBIDDEN.test(selector)) return null;
    let attribute = null;
    if (spec.attribute !== undefined && spec.attribute !== null && spec.attribute !== "") {
      if (typeof spec.attribute !== "string") return null;
      attribute = spec.attribute.trim().toLowerCase();
      if (!ATTRIBUTE.test(attribute) || /^on[a-z]/.test(attribute)) return null;
    }
    out.push({ name, selector, attribute });
  }
  if (!out.some((f) => f.name === "title") || !out.some((f) => f.name === "description")) return null;
  return JOB_FIELDS.map((n) => out.find((f) => f.name === n)).filter(Boolean);
}

/** Bytes of a value as JSON, the way it is sent. */
export function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** The elements of an outline tree in document order (pre-order), each with its depth (the root is 1). */
function preorder(root) {
  const out = [];
  const stack = [[root, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    out.push([node, depth]);
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
  }
  return out;
}

/** A copy of the outline tree with only its first `keep` elements in document order (and none past `maxDepth`). */
export function truncateOutline(root, keep, maxDepth = OUTLINE_LIMITS.depth) {
  let left = keep;
  const copy = (node, depth) => {
    if (left <= 0 || depth > maxDepth) return null;
    left--;
    const out = {};
    for (const k of ["tag", "attrs", "text"]) if (node[k] !== undefined) out[k] = node[k];
    const kids = [];
    for (const c of Array.isArray(node.children) ? node.children : []) {
      const k = copy(c, depth + 1);
      if (!k) break;
      kids.push(k);
    }
    if (kids.length) out.children = kids;
    return out;
  };
  return copy(root, 1);
}

/** {elements, depth} of an outline tree. */
export function outlineStats(root) {
  const all = preorder(root);
  return { elements: all.length, depth: all.reduce((d, [, x]) => Math.max(d, x), 0) };
}

/**
 * The work-out request (`{kind, url, outline}`) within the caps of Part 8, 8.6: when the outline the page gave is over
 * a cap, its last elements in document order are left out until it fits. Null when even the root alone doesn't fit
 * (an address or a title too long).
 */
export function workOutRequest(kind, url, outline, limits = OUTLINE_LIMITS) {
  if (!outline || !outline.root || typeof outline.root.tag !== "string") return null;
  const title = typeof outline.title === "string" ? outline.title.slice(0, limits.title) : "";
  const make = (root) => ({ kind, url, outline: title ? { title, root } : { root } });
  const stats = outlineStats(outline.root);
  let keep = Math.min(stats.elements, limits.elements);
  let req = make(stats.elements > keep || stats.depth > limits.depth ? truncateOutline(outline.root, keep, limits.depth) : outline.root);
  for (let i = 0; i < 60 && jsonBytes(req) > limits.bytes; i++) {
    if (keep <= 1) return null;
    keep = Math.max(1, Math.floor(keep * 0.85));
    req = make(truncateOutline(outline.root, keep, limits.depth));
  }
  return jsonBytes(req) <= limits.bytes ? req : null;
}
