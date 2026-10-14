import { ext } from "./ext.js";
import { OUTLINE_LIMITS, OUTLINE_ATTRIBUTES, OUTLINE_LEFT_OUT, OUTLINE_FORM_FIELDS } from "./mapping.js";

// What is read out of the page (lib/extract.js turns it into the job that is sent). The page's HTML is never sent.
export const LIMITS = {
  url: 2048,
  short: 1000, // page_title, meta values, h1, each "found" value
  description: 100000,
  selection: 100000,
  jsonldObjects: 10,
  jsonldChars: 200000,
  cards: 100, // job cards read from a page of search results
  cardPoints: 8, // bullet points kept per card
};

/**
 * Runs inside the page (serialised by scripting.executeScript): must not use anything outside itself.
 * Reads the job's raw ingredients out of the page the browser has already parsed: address, title, a few meta
 * values, the JobPosting objects from JSON-LD, site-specific fields, and the description text. On a page of search
 * results of a known job board it also reads the job cards (what each card shows, nothing else). Bounded walks only.
 */
function readPage(L) {
  const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) : typeof s === "string" ? s : "");
  const oneLine = (s, n) => cut(String(s || "").replace(/\s+/g, " ").trim(), n);
  const text = (node) => {
    try {
      return String((node && (node.innerText || node.textContent)) || "");
    } catch (e) {
      return "";
    }
  };
  const first = (selectors) => {
    for (const sel of selectors || []) {
      try {
        const node = document.querySelector(sel);
        if (node) {
          const t = text(node).trim();
          if (t) return node;
        }
      } catch (e) {
        /* an invalid selector yields nothing */
      }
    }
    return null;
  };
  const meta = (key) => {
    try {
      for (const m of document.querySelectorAll("meta[property], meta[name]")) {
        if ((m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase() === key) {
          const c = oneLine(m.getAttribute("content"), L.short);
          if (c) return c;
        }
      }
    } catch (e) {
      /* ignore */
    }
    return "";
  };
  const httpUrl = (u) => (/^https?:\/\//i.test(u || "") && u.length <= L.url ? u : "");

  // ---- canonical link ----
  let canonical = "";
  try {
    const link = document.querySelector('link[rel~="canonical"][href]');
    if (link) canonical = httpUrl(link.href); // .href is resolved against the page's base
  } catch (e) {
    /* ignore */
  }

  // ---- first visible h1 ----
  let h1 = "";
  try {
    let n = 0;
    for (const h of document.querySelectorAll("h1")) {
      if (++n > 20) break;
      if (h.getClientRects().length > 0 && getComputedStyle(h).visibility !== "hidden") {
        h1 = oneLine(text(h), L.short);
        if (h1) break;
      }
    }
  } catch (e) {
    /* ignore */
  }

  // ---- JSON-LD: only the JobPosting objects ----
  let jsonld = [];
  try {
    const isJob = (o) => {
      const t = o && o["@type"];
      return (Array.isArray(t) ? t : [t]).some((x) => typeof x === "string" && /(^|[/#:])JobPosting$/i.test(x));
    };
    let visited = 0;
    const walk = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 6 || ++visited > 5000 || jsonld.length >= 50) return;
      if (Array.isArray(v)) {
        for (const x of v) walk(x, depth + 1);
        return;
      }
      if (isJob(v)) jsonld.push(v);
      else if (v["@graph"]) walk(v["@graph"], depth + 1);
    };
    let scripts = 0;
    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
      if (++scripts > 30) break;
      try {
        const raw = sc.textContent || "";
        if (raw.length > 2000000) continue;
        walk(JSON.parse(raw), 0);
      } catch (e) {
        /* a script that is not valid JSON is skipped */
      }
    }
    let items = jsonld.slice(0, L.jsonldObjects).map((o) => ({ o, n: JSON.stringify(o).length }));
    let total = items.reduce((a, x) => a + x.n, 0);
    while (items.length && total > L.jsonldChars) {
      // too much: drop the largest one rather than send an over-limit payload
      let big = 0;
      items.forEach((x, i) => {
        if (x.n > items[big].n) big = i;
      });
      total -= items[big].n;
      items.splice(big, 1);
    }
    jsonld = items.map((x) => x.o);
  } catch (e) {
    jsonld = [];
  }

  // ---- site-specific reads (selectors that match nothing simply yield nothing) ----
  const SITES = [
    {
      // SEEK (Australia / New Zealand)
      host: /(^|\.)seek\.(com(\.au)?|co\.nz)$/i,
      title: ['[data-automation="job-detail-title"]'],
      company: ['[data-automation="advertiser-name"]'],
      location: ['[data-automation="job-detail-location"]'],
      salary: ['[data-automation="job-detail-salary"]'],
      type: ['[data-automation="job-detail-work-type"]'],
      description: ['[data-automation="jobAdDetails"]'],
    },
    {
      // LinkedIn: signed-in job view, then the public job page
      host: /(^|\.)linkedin\.com$/i,
      title: [".job-details-jobs-unified-top-card__job-title", ".top-card-layout__title", ".topcard__title"],
      company: [
        ".job-details-jobs-unified-top-card__company-name",
        ".topcard__org-name-link",
        ".top-card-layout__card .topcard__flavor:first-child",
      ],
      location: [".job-details-jobs-unified-top-card__bullet", ".topcard__flavor--bullet"],
      salary: [],
      type: [],
      description: [".jobs-description__content", "#job-details", ".show-more-less-html__markup", ".description__text"],
    },
    {
      // Indeed
      host: /(^|\.)indeed\.[a-z.]+$/i,
      title: ['[data-testid="jobsearch-JobInfoHeader-title"]', ".jobsearch-JobInfoHeader-title"],
      company: ['[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]'],
      location: ['[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]'],
      salary: ["#salaryInfoAndJobType"],
      type: [],
      description: ["#jobDescriptionText"],
    },
    {
      // Greenhouse: the newer job-boards pages, then the classic boards
      host: /(^|\.)greenhouse\.io$/i,
      title: [".job__title h1", "#header .app-title", "h1.section-header"],
      company: ["#header .company-name"],
      location: [".job__location", "#header .location"],
      salary: [],
      type: [],
      description: [".job__description", "#content"],
    },
    {
      // Lever
      host: /(^|\.)lever\.co$/i,
      title: [".posting-headline h2"],
      company: [],
      location: [".posting-categories .location"],
      salary: [],
      type: [".posting-categories .commitment"],
      description: ['[data-qa="job-description"]', ".section.page-centered"],
    },
    {
      // Workday (myworkdayjobs.com)
      host: /(^|\.)myworkdayjobs\.com$/i,
      title: ['[data-automation-id="jobPostingHeader"]'],
      company: [],
      location: ['[data-automation-id="locations"]'],
      salary: [],
      type: [],
      description: ['[data-automation-id="jobPostingDescription"]'],
    },
    {
      // SmartRecruiters
      host: /(^|\.)smartrecruiters\.com$/i,
      title: ["h1.job-title", '[itemprop="title"]'],
      company: [],
      location: ['[itemprop="jobLocation"]'],
      salary: [],
      type: [],
      description: ['[itemprop="description"]', ".job-sections"],
    },
    {
      // Ashby
      host: /(^|\.)ashbyhq\.com$/i,
      title: [],
      company: [],
      location: [],
      salary: [],
      type: [],
      description: ['[class*="_descriptionText_"]'],
    },
    {
      // Workable
      host: /(^|\.)workable\.com$/i,
      title: ['[data-ui="job-title"]'],
      company: [],
      location: ['[data-ui="job-location"]'],
      salary: [],
      type: [],
      description: ['[data-ui="job-description"]', '[data-ui="overview"]'],
    },
  ];
  const found = {};
  let siteDescription = null;
  try {
    const site = SITES.find((x) => x.host.test(location.hostname));
    if (site) {
      const pairs = [
        ["title", "title"],
        ["company", "company"],
        ["location_text", "location"],
        ["salary_text", "salary"],
        ["employment_type", "type"],
      ];
      for (const [key, prop] of pairs) {
        const node = first(site[prop]);
        const v = node ? oneLine(text(node), L.short) : "";
        if (v) found[key] = v;
      }
      if (found.title) found.title = found.title.replace(/\s+-\s+job post$/i, ""); // Indeed
      siteDescription = first(site.description);
    }
  } catch (e) {
    /* ignore */
  }

  // ---- the description text: site element, else the main content, else the body ----
  const lines = (s) =>
    s
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\u00a0]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  let description = "";
  let source = "";
  try {
    if (siteDescription) {
      description = lines(text(siteDescription));
      source = description ? "site" : "";
    }
    if (!description) {
      for (const sel of ["main", "article", '[role="main"]']) {
        const node = document.querySelector(sel);
        const t = node ? lines(text(node)) : "";
        if (t.length >= 100) {
          description = t;
          source = "main";
          break;
        }
      }
    }
    if (!description) {
      description = lines(text(document.body));
      source = description ? "body" : "";
    }
  } catch (e) {
    /* ignore */
  }

  let selection = "";
  try {
    selection = cut(String(window.getSelection ? window.getSelection() : "").trim(), L.selection);
  } catch (e) {
    /* ignore */
  }

  // ---- a page of search results: what each job card shows (known job boards only) ----
  const LISTS = [
    {
      // SEEK (Australia / New Zealand): one <article> per job, in every view and on every page of the results
      site: "seek",
      host: /(^|\.)seek\.(com(\.au)?|co\.nz)$/i,
      card: "article[data-job-id]",
      id: "data-job-id",
      link: '[data-automation="jobTitle"]',
      title: '[data-automation="jobTitle"]',
      company: '[data-automation="jobCompany"]',
      location: '[data-automation="jobLocation"]',
      arrangement: '[data-testid="work-arrangement"]',
      salary: '[data-automation="jobSalary"]',
      teaser: '[data-automation="jobShortDescription"]',
      points: "ul li",
      classification: '[data-automation="jobClassification"]',
      subclassification: '[data-automation="jobSubClassification"]',
      listed: '[data-automation="jobListingDate"]',
      isNew: '[data-automation="newToYouAdBadge"]',
      featured: '[data-automation="premiumJob"]', // the same job shown again above the results
      type: /^This is an? (.{2,40}) job$/i, // "This is a Full time job", for screen readers
    },
  ];
  let listing = null;
  try {
    const rules = LISTS.find((x) => x.host.test(location.hostname));
    if (rules) {
      const one = (card, sel) => {
        try {
          const node = sel ? card.querySelector(sel) : null;
          return node ? oneLine(text(node), L.short) : "";
        } catch (e) {
          return "";
        }
      };
      const many = (card, sel, max) => {
        const out = [];
        try {
          for (const node of card.querySelectorAll(sel)) {
            if (out.length >= max) break;
            const t = oneLine(text(node), L.short);
            if (t && !out.includes(t)) out.push(t);
          }
        } catch (e) {
          /* ignore */
        }
        return out;
      };
      const cards = [];
      let seen = 0;
      for (const card of document.querySelectorAll(rules.card)) {
        if (++seen > L.cards) break;
        let href = "";
        try {
          const a = card.querySelector(rules.link);
          href = a && a.href ? httpUrl(String(a.href)) : ""; // .href is resolved against the page's base
        } catch (e) {
          /* ignore */
        }
        let type = "";
        try {
          let leaves = 0;
          for (const node of card.querySelectorAll("p, span")) {
            if (++leaves > 400) break;
            const m = rules.type.exec(oneLine(node.textContent, 80));
            if (m && !/^featured$/i.test(m[1])) {
              type = m[1];
              break;
            }
          }
        } catch (e) {
          /* ignore */
        }
        let isNew = false;
        let featured = false;
        try {
          isNew = !!card.querySelector(rules.isNew);
          featured = card.matches(rules.featured);
        } catch (e) {
          /* ignore */
        }
        cards.push({
          id: oneLine(card.getAttribute(rules.id), 40),
          href,
          title: one(card, rules.title),
          company: one(card, rules.company),
          locations: many(card, rules.location, 10),
          arrangement: one(card, rules.arrangement),
          salary: one(card, rules.salary),
          teaser: one(card, rules.teaser),
          points: many(card, rules.points, L.cardPoints),
          classification: one(card, rules.classification),
          subclassification: one(card, rules.subclassification),
          listed: one(card, rules.listed),
          type,
          is_new: isNew,
          featured,
        });
      }
      if (cards.length) listing = { site: rules.site, cards };
    }
  } catch (e) {
    listing = null;
  }

  const out = {
    url: cut(location.href, L.url + 1), // one over so the caller can notice it was too long
    canonical_url: canonical,
    page_title: oneLine(document.title, L.short),
    meta: {
      og_title: meta("og:title"),
      og_site_name: meta("og:site_name"),
      description: meta("description") || meta("og:description"),
    },
    h1,
    jsonld,
    found,
    description: cut(description, L.description),
    description_source: source,
    selection,
    listing,
  };

  return out;
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


// ---------- AI mappings (JobHuntPA api 3): the page outline, and a mapping applied to the page ----------

/**
 * Runs inside the page (serialised by scripting.executeScript): must not use anything outside itself.
 * The trimmed outline of the page the person has open (Part 8, 8.6), built with DOM APIs from the page the browser
 * has already parsed: for each shown element of the body, its name, the listed attributes and a short sample of its
 * own text. Never a script, style, frame or anything of the page's head (left out with everything inside them), never
 * an SVG's insides, a shadow root or a frame's document, never the text of a form field (nor of anything the person
 * can type into), no comments, no hidden elements; capped as the contract says, in document order. No HTML of the
 * page is read or sent.
 * @returns {{outline: {title, root} (as JSON text with L.asJson), elements: number, cut: boolean} | null}
 */
function readOutline(L) {
  const TAG = /^[a-z][a-z0-9-]{0,39}$/;
  const LEFT_OUT = new Set(L.leftOut);
  const NO_TEXT = new Set(L.formFields);
  const NO_CHILDREN = new Set(["svg", "math", "select", "datalist"]); // what is inside isn't the page's layout
  const LOW = new Set(["nav", "footer", "aside", "menu"]); // navigation lists, footers, sidebars: their first few items only
  const LOW_ROLES = new Set(["navigation", "contentinfo", "complementary", "menu", "menubar", "banner"]);
  const MEANINGFUL = L.attributes.filter((a) => a !== "class" && a !== "role");
  const cut = (s, n) => {
    if (s.length <= n) return s;
    let c = s.slice(0, n);
    if (/[\ud800-\udbff]$/.test(c)) c = c.slice(0, -1); // never half of an emoji
    return c;
  };
  const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const utf8 = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3;
    }
    return n;
  };
  const shown = (el) => {
    try {
      if (el.hasAttribute("hidden")) return false;
      if (String(el.getAttribute("aria-hidden") || "").trim().toLowerCase() === "true") return false;
      const cs = getComputedStyle(el);
      if (cs && cs.display === "none") return false;
    } catch (e) {
      return false;
    }
    return true;
  };
  const attrsOf = (el) => {
    const out = {};
    let n = 0;
    for (const name of L.attributes) {
      if (n >= L.attrs) break;
      let v;
      try {
        if (!el.hasAttribute(name)) continue;
        v = el.getAttribute(name);
      } catch (e) {
        continue;
      }
      if (typeof v !== "string") continue;
      if (name === "href") {
        v = v.trim();
        if (!v || /^(javascript|data|vbscript|blob|file|mailto|tel):/i.test(v)) continue;
        v = v.split("#")[0].split("?")[0]; // the app drops a link's query and fragment, which may hold anything
        if (!v) continue;
      } else if (name === "class") {
        v = oneLine(v);
        if (!v) continue;
      }
      if (v.length > L.attrValue) {
        if (name === "class") {
          v = v.slice(0, L.attrValue + 1);
          const sp = v.lastIndexOf(" ");
          v = cut(sp > 0 ? v.slice(0, sp) : v, L.attrValue).trim(); // whole class names
        } else if (name === "href") v = cut(v, L.attrValue);
        else continue; // too long to be of use: left out
      }
      out[name] = v;
      n++;
    }
    return n ? out : null;
  };
  const ownText = (el) => {
    let t = "";
    try {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) {
          t += " " + c.nodeValue;
          if (t.length > 4 * L.text) break;
        }
      }
    } catch (e) {
      return "";
    }
    return cut(oneLine(t), L.text).trim();
  };

  let count = 0;
  let bytes = 0;
  let visited = 0;
  let full = false;
  const walk = (el, depth, low) => {
    if (full) return null;
    if (++visited > L.visit) {
      full = true;
      return null;
    }
    const tag = el.localName;
    if (typeof tag !== "string" || !TAG.test(tag) || LEFT_OUT.has(tag)) return null; // with everything inside it
    if (depth > 1 && !shown(el)) return null;
    const node = { tag };
    const attrs = attrsOf(el);
    if (attrs) node.attrs = attrs;
    if (!NO_TEXT.has(tag) && !el.isContentEditable) {
      const t = ownText(el);
      if (t) node.text = t;
    }
    const cost = utf8(JSON.stringify(node)) + 16; // its own part, with `,"children":[]` and a comma
    if (count + 1 > L.elements || bytes + cost > L.bytes) {
      full = true; // the caps: stop here, in document order
      return null;
    }
    count++;
    bytes += cost;
    const role = attrs && attrs.role ? attrs.role.toLowerCase() : "";
    const isLow = low || LOW.has(tag) || LOW_ROLES.has(role);
    if (depth < L.depth && !NO_CHILDREN.has(tag)) {
      const kids = [];
      const max = isLow ? L.lowChildren : L.children;
      const list = el.children || [];
      for (let i = 0; i < list.length && kids.length < max && !full; i++) {
        const k = walk(list[i], depth + 1, isLow);
        if (k) kids.push(k);
      }
      if (kids.length) node.children = kids;
    }
    // An element that holds nothing a job needs (an empty wrapper's leaf: no text, no children, no telling attribute)
    if (depth > 1 && !node.children && !node.text && !(attrs && MEANINGFUL.some((a) => a in attrs))) {
      count--;
      bytes -= cost;
      return null;
    }
    return node;
  };

  const body = document.body;
  if (!body) return null;
  const root = walk(body, 1, false);
  if (!root) return null;
  const outline = { title: cut(oneLine(document.title), L.title).trim(), root };
  // As JSON text: the browser hands a script's result over as a value only so many levels deep, and an outline of 60
  // levels nests deeper than that.
  return { outline: L.asJson ? JSON.stringify(outline) : outline, elements: count, cut: full };
}

/**
 * Runs inside the page (serialised by scripting.executeScript): must not use anything outside itself.
 * Applies a job mapping (Part 8, 8.7) with the browser's own selector functions only: for each field,
 * `document.querySelector(selector)` (a selector the browser rejects is a field not found), then the element's
 * attribute (`getAttribute`) when one is named, else its text (`innerText` for the description, keeping its
 * paragraphs; `textContent`, whitespace collapsed, for the rest). Values are cut here already; lib/extract.js cuts them
 * to the job's limits. Nothing is run, inserted or changed on the page.
 * @param fields [{name, selector, attribute}] as lib/mapping.js jobMappingFields checked them
 */
function readMapped(fields, L) {
  const out = {};
  for (const f of fields || []) {
    let node = null;
    try {
      node = document.querySelector(String(f.selector));
    } catch (e) {
      node = null;
    }
    if (!node) continue;
    let v = "";
    try {
      if (f.attribute) v = node.getAttribute(String(f.attribute)) || "";
      else if (f.name === "description") v = String(node.innerText || node.textContent || "");
      else v = String(node.textContent || "");
    } catch (e) {
      v = "";
    }
    v = String(v);
    if (f.name === "description") v = v.slice(0, L.description).trim();
    else v = v.slice(0, 4 * L.short).replace(/\s+/g, " ").trim().slice(0, L.short);
    out[f.name] = v;
  }
  return out;
}

export const OUTLINE_ARGS = {
  ...OUTLINE_LIMITS,
  bytes: OUTLINE_LIMITS.bytes - 6000, // the outline's own budget; the rest of the request (address, title) fits in what is left
  attributes: OUTLINE_ATTRIBUTES,
  leftOut: OUTLINE_LEFT_OUT,
  formFields: OUTLINE_FORM_FIELDS,
  asJson: true,
};

export { readOutline, readMapped }; // for the unit tests

async function inPage(tab, func, args) {
  if (!tab || tab.id == null || !isReadableUrl(tab.url)) {
    throw new CaptureError("The browser does not let extensions read this kind of page.");
  }
  let results;
  try {
    results = await ext.scripting.executeScript({ target: { tabId: tab.id }, func, args });
  } catch {
    throw new CaptureError("The browser would not let this extension read the page. Reload the page and open the extension again.");
  }
  return results && results[0] ? results[0].result : null;
}

/** The outline of the page in `tab` (see readOutline), or a CaptureError. */
export async function captureOutline(tab) {
  const r = await inPage(tab, readOutline, [OUTLINE_ARGS]);
  let outline = null;
  try {
    outline = r && typeof r.outline === "string" ? JSON.parse(r.outline) : null;
  } catch {
    outline = null;
  }
  if (!outline || !outline.root) throw new CaptureError("This page has nothing JobHuntPA could work out.");
  return { ...r, outline };
}

/** What a mapping's fields find on the page in `tab`: {field: value} for the fields whose element is there. */
export async function readMappedValues(tab, fields) {
  const r = await inPage(tab, readMapped, [fields, { short: LIMITS.short, description: LIMITS.description }]);
  return r && typeof r === "object" ? r : {};
}
