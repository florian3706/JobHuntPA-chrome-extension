import { ext } from "./ext.js";

// What is read out of the page (lib/extract.js turns it into the job that is sent). The page's HTML is never sent.
export const LIMITS = {
  url: 2048,
  short: 1000, // page_title, meta values, h1, each "found" value
  description: 100000,
  selection: 100000,
  jsonldObjects: 10,
  jsonldChars: 200000,
};

/**
 * Runs inside the page (serialised by scripting.executeScript): must not use anything outside itself.
 * Reads the job's raw ingredients out of the page the browser has already parsed: address, title, a few meta
 * values, the JobPosting objects from JSON-LD, site-specific fields, and the description text. Bounded walks only.
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
