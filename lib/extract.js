// Turns what lib/capture.js read out of the page into the finished job that is sent to JobHuntPA (contract v3),
// and the job cards of a page of search results into the list that is sent (extractListing, buildListBody).
// Everything here runs on the user's own computer; nothing but the returned `job` or list leaves the browser.
// Pure functions (no extension APIs); the only DOM use is an inert DOMParser document for JSON-LD descriptions.

export const JOB_LIMITS = {
  title: 500,
  company: 500,
  location_text: 500,
  salary_text: 500,
  employment_type: 100,
  posted_at: 40,
  url: 2048,
  description: 100000,
};
export const BODY_SOFT_LIMIT = 400000; // bytes; the server refuses more than 512 KB
export const EDITABLE = ["title", "company", "location_text", "salary_text", "employment_type", "work_mode"];
const WORK_MODES = ["onsite", "hybrid", "remote", "unknown"];

const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const squash = (v) => str(v).replace(/[\s ]+/g, " ").trim();
const clip = (s, n) => {
  if (s.length <= n) return s;
  let cut = s.slice(0, n);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1); // never leave half of an emoji
  return cut.trimEnd();
};
const httpUrl = (u, max = JOB_LIMITS.url) => {
  const s = squash(u);
  return /^https?:\/\/\S+$/i.test(s) && s.length <= max ? s : "";
};

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// ---------- HTML -> plain text ----------

// Line breaks around block elements: how many newlines (1 = new line, 2 = blank line between paragraphs).
const GAP = {
  P: 2, UL: 2, OL: 2, H1: 2, H2: 2, H3: 2, H4: 2, H5: 2, H6: 2, TABLE: 2, BLOCKQUOTE: 2, PRE: 2, DL: 2,
  DIV: 1, LI: 1, TR: 1, SECTION: 1, ARTICLE: 1, HR: 1, DT: 1, DD: 1, HEADER: 1, FOOTER: 1, ASIDE: 1, NAV: 1, FIGURE: 1,
};
const SKIP = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "IFRAME", "OBJECT", "SVG"]);

function tidy(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ​]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", hellip: "…", bull: "•" };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Fallback without a DOM (used where there is no DOMParser, e.g. unit tests). */
function textFromHtmlNoDom(html) {
  const t = html
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|ul|ol|h[1-6]|table|blockquote|pre|dl)\b[^>]*>/gi, "\n\n")
    .replace(/<\/?(div|tr|section|article|dt|dd|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return tidy(decodeEntities(t));
}

/** Text of an inert DOMParser document: paragraphs, list items and line breaks kept, entities decoded. */
function textFromHtmlDom(html, Parser) {
  const doc = new Parser().parseFromString(html, "text/html");
  const out = [];
  let trail = 2; // newlines at the end of what has been written so far
  const ensure = (n) => {
    while (trail < n) {
      out.push("\n");
      trail++;
    }
  };
  const stack = [doc.body || doc.documentElement];
  let nodes = 0;
  while (stack.length && nodes++ < 200000) {
    const n = stack.pop();
    if (typeof n === "number") {
      ensure(n); // leaving a block element
    } else if (n.nodeType === 3) {
      const t = n.nodeValue;
      if (/^\s*$/.test(t)) {
        if (trail === 0 && out.length) {
          out.push(" ");
        }
      } else {
        out.push(t.replace(/\s+/g, " ")); // source line breaks inside a paragraph are just spaces
        trail = 0;
      }
    } else if (n.nodeType === 1) {
      const tag = n.tagName.toUpperCase();
      if (SKIP.has(tag)) continue;
      if (tag === "BR") {
        out.push("\n");
        trail++;
        continue;
      }
      const gap = GAP[tag] || 0;
      if (gap) {
        ensure(gap);
        stack.push(gap);
      }
      if (tag === "LI") {
        out.push("- ");
        trail = 0;
      }
      const kids = n.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  return tidy(out.join(""));
}

/**
 * Plain text of an HTML snippet (a JSON-LD description). Never inserts anything into a live page: DOMParser
 * documents are inert (no scripts run, nothing loads). `Parser` defaults to the browser's DOMParser.
 */
export function htmlToText(html, Parser = globalThis.DOMParser) {
  const src = str(html);
  if (!src) return "";
  const once = (s) => (Parser ? textFromHtmlDom(s, Parser) : textFromHtmlNoDom(s));
  let text = once(src);
  // Some sites entity-encode the markup (&lt;p&gt;…): what came out still looks like HTML, so convert it once more.
  if (/&lt;\/?[a-z]/i.test(src) && /<\/?[a-z][^>]*>/i.test(text)) text = once(text);
  return text;
}

// ---------- titles, work mode ----------

const nameKey = (s) => squash(s).toLowerCase();

/**
 * Removes site decorations from a title. "Title | Site" always loses the part after the pipe. For text such as
 * document.title (`aggressive`) any " - Site" / " – Site" part goes too; otherwise a dash part only goes when it
 * is a known name (company, site, host), because job titles may contain dashes ("Engineer - Backend").
 */
export function cleanTitle(title, { aggressive = false, names = [] } = {}) {
  let t = squash(title).replace(/\s+[-–—|]\s+job post$/i, "");
  if (!t) return "";
  const known = names.map(nameKey).filter((n) => n.length >= 2);
  const isKnown = (seg) => {
    const k = nameKey(seg).replace(/\s+(careers?|jobs?)$/, "");
    return known.some((n) => k === n || k.includes(n) || n.includes(k));
  };
  const first = t.split(/\s+[|·•]\s+/)[0];
  if (first) t = first;
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length > 1) {
    if (aggressive && parts[0].length >= 3) return parts[0].trim();
    const kept = [...parts];
    while (kept.length > 1 && isKnown(kept[kept.length - 1])) kept.pop();
    t = kept.join(" - ");
  }
  return t;
}

/** "remote" / "hybrid" only when the text says so plainly; else "unknown". */
export function workModeFromText(text, { loose = false } = {}) {
  const t = squash(text).toLowerCase();
  if (!t) return "unknown";
  if (loose) {
    // short texts (title, location): a bare word is enough
    if (/\bhybrid\b/.test(t)) return "hybrid";
    if (/\b(remote|work from home|wfh)\b/.test(t)) return "remote";
    return "unknown";
  }
  if (/\(hybrid\)|\bhybrid (role|work|working|position|model|schedule)\b|\b\d days? (in|at) the office\b/.test(t)) return "hybrid";
  if (/\bfully[- ]remote\b|\b100% remote\b|\bremote[- ](first|role|position|job)\b|\(remote\)/.test(t)) return "remote";
  return "unknown";
}

// ---------- JSON-LD JobPosting ----------

const EMPLOYMENT = {
  FULL_TIME: "Full time",
  PART_TIME: "Part time",
  CONTRACTOR: "Contract",
  CONTRACT: "Contract",
  TEMPORARY: "Temporary",
  INTERN: "Internship",
  VOLUNTEER: "Volunteer",
  PER_DIEM: "Per diem",
  OTHER: "Other",
};
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

function employmentText(v) {
  const out = [];
  for (const x of asList(v)) {
    const raw = squash(x);
    if (!raw) continue;
    const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
    const text = EMPLOYMENT[key] || (/^[A-Z_]+$/.test(raw) ? raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_/g, " ") : raw);
    if (!out.includes(text)) out.push(text);
  }
  return out.join(", ");
}

const nameOf = (v) => (v && typeof v === "object" ? squash(v.name) : squash(v));

function locationText(posting) {
  const places = [];
  for (const loc of asList(posting.jobLocation)) {
    if (!loc) continue;
    let text = "";
    const a = loc.address !== undefined ? loc.address : typeof loc === "string" ? loc : null;
    if (typeof a === "string") text = squash(a);
    else if (a && typeof a === "object") {
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry].map(nameOf).filter(Boolean);
      text = parts.filter((p, i) => parts.indexOf(p) === i).join(", ");
      if (!text) text = squash(a.streetAddress);
    }
    if (!text && typeof loc === "object") text = squash(loc.name);
    if (text && !places.includes(text)) places.push(text);
  }
  if (!places.length) {
    // no office: a remote job may name where it can be done from
    for (const r of asList(posting.applicantLocationRequirements)) {
      const n = nameOf(r);
      if (n && !places.includes(n)) places.push(n);
    }
  }
  return places.slice(0, 10).join("; ");
}

const UNITS = { YEAR: "year", MONTH: "month", WEEK: "week", DAY: "day", HOUR: "hour" };
const money = (n) => {
  const x = typeof n === "string" && n.trim() !== "" ? Number(n) : n;
  return typeof x === "number" && Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : squash(n);
};

function salaryText(bs) {
  if (bs == null) return "";
  if (typeof bs !== "object") return squash(bs);
  const v = bs.value;
  const q = v && typeof v === "object" ? v : { value: v };
  const cur = squash(bs.currency || q.currency);
  const min = q.minValue, max = q.maxValue;
  let amount = "";
  if (min != null && max != null && money(min) !== money(max)) amount = `${money(min)}–${money(max)}`;
  else if (q.value != null && q.value !== "") amount = money(q.value);
  else if (min != null || max != null) amount = money(min != null ? min : max);
  if (!amount) return "";
  const unit = squash(q.unitText || bs.unitText).toUpperCase();
  return [cur, amount].filter(Boolean).join(" ") + (UNITS[unit] ? ` per ${UNITS[unit]}` : "");
}

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * A date the server accepts (`YYYY-MM-DD`, optionally with `THH:MM[:SS[.fff]]` and `Z` / `+HH:MM`), or "".
 * Close forms are fixed (`2026-10-1`, `2026-10-01T9:00`, `+10`, lower-case `t` / `z`); a time zone without a time is dropped;
 * "October 1, 2026" becomes `2026-10-01`. Anything else (ambiguous `01/10/2026`, words) is left out rather than sent.
 */
export function isoDate(v) {
  const s = squash(v);
  if (!s) return "";
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(s);
  if (m) {
    const [y, mo, d] = [m[1], +m[2], +m[3]];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
    let out = `${y}-${pad2(mo)}-${pad2(d)}`;
    if (m[4] !== undefined) {
      const h = +m[4], mi = +m[5], se = m[6] === undefined ? null : +m[6];
      if (h > 23 || mi > 59 || (se !== null && se > 59)) return "";
      out += `T${pad2(h)}:${pad2(mi)}`;
      if (se !== null) out += `:${pad2(se)}${m[7] ? "." + m[7] : ""}`;
      let z = m[8] || "";
      if (z) z = /^[Zz]$/.test(z) ? "Z" : z.length === 3 ? `${z}:00` : z;
      out += z;
    }
    return clip(out, JOB_LIMITS.posted_at);
  }
  // "October 1, 2026", "1 Oct 2026", "Oct 1 2026 9:00 AM": only with a month name and a 4-digit year
  if (/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(s) && /\b(19|20)\d{2}\b/.test(s) && s.length <= 40) {
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
  }
  return "";
}

const dateText = isoDate;

// ---------- company from the address ----------

// Job boards that list many employers: the board's own name is never the employer.
const MULTI_EMPLOYER = new Set([
  "seek", "linkedin", "indeed", "glassdoor", "jora", "jobstreet", "ziprecruiter", "monster", "reed", "totaljobs", "adzuna",
  "careerone", "jooble", "simplyhired", "careerjet", "talent", "cv-library", "stepstone", "naukri", "workopolis", "trademe",
  "gumtree", "ycombinator", "wellfound", "otta", "welcometothejungle", "dice", "flexjobs",
  "remoteok", "weworkremotely", "builtin", "themuse", "snagajob", "usajobs",
]);
// Application-tracking systems that host many companies: the company is in the path or subdomain, never the system's name.
const ATS = new Set([
  "greenhouse", "lever", "workable", "ashbyhq", "smartrecruiters", "myworkdayjobs", "myworkdaysite", "bamboohr", "recruitee",
  "teamtailor", "applytojob", "jobvite", "icims", "taleo", "successfactors", "breezy", "pinpointhq", "personio", "jazzhr",
  "comeet", "dayforce", "oraclecloud", "workdayjobs", "rippling", "paylocity", "ultipro",
]);
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu", "ac", "or", "ne", "gv", "id", "nom"]);

/** "acme-corp" -> "Acme Corp"; a slug that already has capitals ("AcmeCorp") keeps them. */
function titleCase(slug) {
  let s = slug;
  try {
    s = decodeURIComponent(slug);
  } catch {
    /* keep as is */
  }
  s = squash(s.replace(/[-_+.]+/g, " "));
  if (!s) return "";
  if (s === s.toLowerCase() || s === s.toUpperCase()) s = s.toLowerCase();
  return s.replace(/(^|\s)(\p{L})/gu, (m, sp, c) => sp + c.toUpperCase());
}

/**
 * The employer's name from the page address, for when the page itself does not say. Known job boards give the company
 * from the path or subdomain; boards that list many employers give "" (not the board's name); any other site gives its own
 * name (`careers.acme.com.au` -> "Acme"). IPs and single-label hosts give "".
 */
export function companyFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return "";
  const labels = host.split(".");
  const tld = labels[labels.length - 1];
  const cc = tld.length === 2 && labels.length >= 3 && SECOND_LEVEL.has(labels[labels.length - 2]);
  const regIdx = labels.length - (cc ? 3 : 2);
  const reg = labels[regIdx];
  const sub = labels.slice(0, regIdx);
  const seg = u.pathname.split("/").filter(Boolean);
  const slug = (v) => (v && /^[\p{L}\p{N}][\p{L}\p{N}_.+%-]*$/u.test(v) ? titleCase(v) : "");

  if (MULTI_EMPLOYER.has(reg)) return "";
  if (ATS.has(reg)) {
    switch (reg) {
      case "greenhouse":
        return slug(sub[0] === "boards" || /^job-boards/.test(sub[0] || "") ? (seg[0] === "embed" ? u.searchParams.get("for") : seg[0]) : "");
      case "lever":
      case "ashbyhq":
      case "workable":
        return slug(seg[0]);
      case "smartrecruiters":
        return slug(seg[0]);
      case "myworkdayjobs":
        return sub.length >= 2 && /^wd\d+$/.test(sub[sub.length - 1]) ? slug(sub[0]) : "";
      case "bamboohr":
      case "recruitee":
      case "teamtailor":
      case "applytojob":
      case "breezy":
      case "jazzhr":
      case "pinpointhq":
      case "personio":
        return sub.length && !["www", "app", "jobs", "careers"].includes(sub[0]) ? slug(sub[0]) : "";
      default:
        return "";
    }
  }
  return slug(reg.length >= 2 ? reg : "");
}

/** Fields of one JSON-LD JobPosting object. */
export function fromJsonLd(posting, parser = globalThis.DOMParser) {
  const p = posting || {};
  const org = asList(p.hiringOrganization)[0];
  const title = squash(decodeEntities(str(p.title) || str(p.name)));
  const location = locationText(p);
  let work = "unknown";
  if (asList(p.jobLocationType).some((x) => /TELECOMMUTE/i.test(str(x)))) work = "remote";
  else work = workModeFromText(`${title} ${location}`, { loose: true });
  return {
    title,
    company: squash(decodeEntities(nameOf(org))),
    location_text: location,
    salary_text: salaryText(p.baseSalary),
    employment_type: employmentText(p.employmentType),
    work_mode: work,
    posted_at: dateText(p.datePosted),
    url: httpUrl(p.url),
    description: htmlToText(p.description, parser),
  };
}

const sameUrl = (a, b) => {
  const n = (u) => str(u).replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();
  return !!a && !!b && n(a) === n(b);
};

/** The JobPosting for this page: the one whose url matches the page, else the first. */
export function pickPosting(list, urls = []) {
  const postings = (Array.isArray(list) ? list : []).filter((x) => x && typeof x === "object" && !Array.isArray(x));
  return postings.find((x) => urls.some((u) => sameUrl(x.url, u))) || postings[0] || null;
}

// ---------- the whole job ----------

const SOURCES = ["site", "main", "body"];

/**
 * @param raw     what readPage (lib/capture.js) returned
 * @param parser  DOMParser constructor (default: the browser's)
 * @returns {{url, canonical_url, job}} the contract-v3 shape, within its limits, values by precedence:
 *   JSON-LD > site elements > page heuristics; description: selection > JSON-LD > description element > main > body.
 */
export function extractJob(raw, parser = globalThis.DOMParser) {
  const r = raw || {};
  const url = httpUrl(r.url, 100000);
  const canonical = httpUrl(r.canonical_url);
  const meta = r.meta || {};
  const found = r.found || {};
  const host = hostOf(url);
  const posting = pickPosting(r.jsonld, [url, canonical]);
  const L = posting ? fromJsonLd(posting, parser) : {};
  const labels = host.split(".");
  const names = [L.company, found.company, meta.og_site_name, labels.length > 1 ? labels[labels.length - 2] : ""];

  const title =
    squash(L.title) ||
    cleanTitle(found.title, { names }) ||
    cleanTitle(r.h1, { names }) ||
    cleanTitle(meta.og_title, { aggressive: true, names }) ||
    cleanTitle(r.page_title, { aggressive: true, names });
  const company = squash(L.company) || squash(found.company) || squash(meta.og_site_name) || companyFromUrl(url);

  const location_text = L.location_text || squash(found.location_text);
  const employment_type = L.employment_type || squash(found.employment_type);
  const selection = tidy(str(r.selection));
  let description = "";
  let description_from = "";
  if (selection) {
    description = selection;
    description_from = "selection";
  } else if (L.description) {
    description = L.description;
    description_from = "structured";
  } else if (str(r.description).trim()) {
    description = tidy(str(r.description));
    description_from = SOURCES.includes(r.description_source) ? r.description_source : "body";
  }

  let work_mode = L.work_mode && L.work_mode !== "unknown" ? L.work_mode : "unknown";
  if (work_mode === "unknown") work_mode = workModeFromText(`${title} ${location_text}`, { loose: true });
  if (work_mode === "unknown") work_mode = workModeFromText(description);

  const method = L.title ? "jsonld" : squash(found.title) ? "site" : "page";
  const job = {
    title: clip(title, JOB_LIMITS.title),
    company: clip(company, JOB_LIMITS.company),
    location_text: clip(location_text, JOB_LIMITS.location_text),
    salary_text: clip(L.salary_text || squash(found.salary_text), JOB_LIMITS.salary_text),
    employment_type: clip(employment_type, JOB_LIMITS.employment_type),
    work_mode,
    posted_at: L.posted_at || "",
    url: L.url || "",
    description: clip(description, JOB_LIMITS.description),
    description_from,
    method,
  };
  return { url, canonical_url: canonical, job };
}

/** Short sentences for the popup about how the values were found. */
export function notesFor(job) {
  const notes = [];
  if (job.description_from === "selection") notes.push("Selected text will be used as the description.");
  if (job.method === "page") notes.push("No structured job data found on this page; the values come from its headings and text, so check them.");
  if (!job.title) notes.push("No job title was found on this page. Type one in, then save.");
  return notes;
}

/**
 * The request body for preview and save: the extracted page plus the user's edits from the popup form
 * (`edits` wins; an emptied field is sent as nothing). Empty values are left out; the whole body is kept small.
 */
export function buildBody(extracted, edits) {
  const job = { ...extracted.job };
  if (edits) for (const k of EDITABLE) if (k in edits) job[k] = squash(edits[k]);
  if (!WORK_MODES.includes(job.work_mode)) job.work_mode = "";
  job.posted_at = isoDate(job.posted_at); // the server refuses anything that is not an ISO date
  job.url = httpUrl(job.url);
  for (const k of Object.keys(job)) {
    if (typeof job[k] !== "string") delete job[k];
    else if (k in JOB_LIMITS) job[k] = clip(job[k], JOB_LIMITS[k]);
    if (job[k] === "") delete job[k];
  }
  const body = { url: extracted.url };
  if (extracted.canonical_url) body.canonical_url = extracted.canonical_url;
  body.job = job;
  const size = () => new TextEncoder().encode(JSON.stringify(body)).length;
  for (let i = 0; i < 20 && job.description && size() > BODY_SOFT_LIMIT; i++) {
    job.description = job.description.slice(0, Math.floor(job.description.length / 2));
  }
  return body;
}

// ---------- a page of search results ----------

export const LIST_LIMITS = {
  jobs: 50, // jobs in one request (the server refuses more)
  industry: 200,
  description: 5000, // a card's summary
};

/**
 * The date a results card means by "3d ago", "5h ago" or "7m ago" (days, hours, minutes before `now`), as the
 * local `YYYY-MM-DD`; "" for anything else ("Featured", "30d+ ago": no date can be told from those).
 */
export function relativeDate(text, now = new Date()) {
  const m = /(?:^|[^\d+.])(\d{1,3})\s?(m|h|d)\s+ago\b/i.exec(squash(text));
  if (!m || !(now instanceof Date) || Number.isNaN(now.getTime())) return "";
  const ms = { m: 60000, h: 3600000, d: 86400000 }[m[2].toLowerCase()];
  const t = new Date(now.getTime() - Number(m[1]) * ms);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
}

const ARRANGEMENT = [
  [/\bhybrid\b/i, "hybrid"],
  [/\bremote\b|work from home/i, "remote"],
  [/\bon-?\s?site\b/i, "onsite"],
];
const unparen = (v) => squash(v).replace(/^\((.*)\)$/, "$1").trim();
const texts = (v, max) => (Array.isArray(v) ? v : []).map(squash).filter(Boolean).slice(0, max);

/** A card's summary as plain text: the teaser, its points as a list, then the work type and classification. */
function cardSummary(card, type, classes) {
  const parts = [];
  const teaser = squash(card.teaser);
  if (teaser) parts.push(teaser);
  const points = texts(card.points, 8);
  if (points.length) parts.push(points.map((x) => `- ${x}`).join("\n"));
  const facts = [];
  if (type) facts.push(`Work type: ${type}`);
  if (classes.length) facts.push(`Classification: ${classes.join(", ")}`);
  if (facts.length) parts.push(facts.join("\n"));
  return clip(parts.join("\n\n"), LIST_LIMITS.description);
}

/**
 * The jobs of a page of search results, from the cards lib/capture.js read (`raw.listing`).
 * @returns {{url, site, jobs}} each job: { key, url, title, company, location_text, salary_text, employment_type,
 *   work_mode, posted_at, industry, description, listed, is_new, viewed, applied }. `url` is the job's own address
 *   on the page's site; cards without one or without a title are left out; a job shown twice (a featured copy
 *   above the results) is one job. `listed`, `is_new`, `viewed` and `applied` are for the popup only.
 */
export function extractListing(raw, now = new Date()) {
  const r = raw || {};
  const url = httpUrl(r.url, 100000);
  const listing = r.listing && typeof r.listing === "object" ? r.listing : {};
  const cards = Array.isArray(listing.cards) ? listing.cards : [];
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    return { url, site: "", jobs: [] };
  }
  const byUrl = new Map();
  for (const c of cards) {
    if (!c || typeof c !== "object") continue;
    const id = /^\d{1,20}$/.test(str(c.id)) ? str(c.id) : "";
    let jobUrl = "";
    if (listing.site === "seek") jobUrl = id ? `${origin}/job/${id}` : "";
    else {
      try {
        const u = new URL(httpUrl(c.href));
        if (u.origin === origin) jobUrl = u.origin + u.pathname + u.search;
      } catch {
        /* no address: left out */
      }
    }
    const title = clip(squash(c.title), JOB_LIMITS.title);
    if (!jobUrl || jobUrl.length > JOB_LIMITS.url || !title) continue;
    const listed = squash(c.listed);
    const arrangement = squash(c.arrangement);
    const type = squash(c.type);
    const classes = [unparen(c.subclassification), unparen(c.classification)].filter((x, i, a) => x && a.indexOf(x) === i);
    const locations = texts(c.locations, 10);
    let work_mode = (ARRANGEMENT.find(([re]) => re.test(arrangement)) || [])[1] || "unknown";
    if (work_mode === "unknown") work_mode = workModeFromText(`${title} ${locations.join(" ")}`, { loose: true });
    const job = {
      key: jobUrl,
      url: jobUrl,
      title,
      company: clip(squash(c.company), JOB_LIMITS.company),
      location_text: clip(locations.filter((x, i, a) => a.indexOf(x) === i).join("; "), JOB_LIMITS.location_text),
      salary_text: clip(squash(c.salary), JOB_LIMITS.salary_text),
      employment_type: clip(type, JOB_LIMITS.employment_type),
      work_mode,
      posted_at: relativeDate(listed, now),
      industry: clip(classes[0] || "", LIST_LIMITS.industry),
      description: cardSummary(c, type, classes),
      listed: clip(listed.replace(/\s*•\s*/g, " · "), 60),
      is_new: c.is_new === true,
      viewed: /\bviewed\b/i.test(listed),
      applied: /\bapplied\b/i.test(listed),
    };
    const had = byUrl.get(jobUrl);
    if (!had) {
      byUrl.set(jobUrl, job);
      continue;
    }
    // The same job again (the featured copy above the results has no date): the card that tells the date gives the
    // date line; every other value comes from whichever card has it, the first winning.
    if (!had.posted_at && job.posted_at) {
      had.posted_at = job.posted_at;
      had.listed = job.listed;
    }
    for (const k of Object.keys(job)) {
      if (k === "posted_at" || k === "listed") continue;
      if (typeof job[k] === "boolean") had[k] = had[k] || job[k];
      else if (k === "work_mode") had[k] = had[k] === "unknown" ? job[k] : had[k];
      else if (!had[k]) had[k] = job[k];
    }
    if (!had.listed) had.listed = job.listed;
  }
  return { url, site: squash(listing.site), jobs: [...byUrl.values()] };
}

const LISTED_FIELDS = ["url", "title", "company", "location_text", "salary_text", "employment_type", "work_mode", "posted_at", "industry", "description"];

/**
 * The request body for "add the jobs on this page": the page's address and the picked jobs, each with only the
 * values the server takes (empty ones left out). At most LIST_LIMITS.jobs jobs: the caller sends more in parts.
 */
export function buildListBody(listing, jobs) {
  const out = [];
  for (const j of (Array.isArray(jobs) ? jobs : []).slice(0, LIST_LIMITS.jobs)) {
    const job = {};
    for (const k of LISTED_FIELDS) {
      let v = typeof j[k] === "string" ? j[k] : "";
      if (k === "posted_at") v = isoDate(v);
      else if (k === "work_mode") v = WORK_MODES.includes(v) && v !== "unknown" ? v : "";
      else if (k === "description") v = clip(tidy(v), LIST_LIMITS.description);
      else if (k === "industry") v = clip(squash(v), LIST_LIMITS.industry);
      else if (k in JOB_LIMITS) v = clip(k === "url" ? v.trim() : squash(v), JOB_LIMITS[k]);
      if (v) job[k] = v;
    }
    if (job.url && job.title) out.push(job);
  }
  const body = { url: listing.url, jobs: out };
  const size = () => new TextEncoder().encode(JSON.stringify(body)).length;
  for (let i = 0; i < 20 && size() > BODY_SOFT_LIMIT; i++) {
    for (const job of out) if (job.description) job.description = job.description.slice(0, Math.floor(job.description.length / 2));
  }
  return body;
}

/** One line for the popup's summary of what a page of results holds. */
export function listingNote(jobs) {
  const n = jobs.length;
  const fresh = jobs.filter((j) => j.is_new).length;
  const found = `${n} job${n === 1 ? "" : "s"} found on this page.`;
  if (!fresh) return found;
  return `${found} ${fresh === n ? (n === 1 ? "It is" : "All are") : `${fresh} ${fresh === 1 ? "is" : "are"}`} marked \u201cNew to you\u201d.`;
}

// ---------- a job read with a mapping (JobHuntPA api 3, Part 8, 8.7) ----------

/**
 * True when the page's own reading (JSON-LD, the sites the extension knows) found no title or no description: the
 * values in the form are then guesses from the page's headings and text, and a mapping JobHuntPA worked out for the
 * site (saved, or worked out now) is worth applying.
 */
export function needsMapping(extracted) {
  const j = (extracted && extracted.job) || {};
  const titled = !!j.title && (j.method === "jsonld" || j.method === "site");
  const described = !!j.description && ["structured", "site", "selection"].includes(j.description_from);
  return !titled || !described;
}

/** A work mode in the contract's words from what the page shows ("Hybrid", "Work from home", "On-site"), or "". */
export function mappedWorkMode(text) {
  const t = squash(text).toLowerCase();
  if (!t) return "";
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\bremote\b|work(ing)? from home|\bwfh\b|\bremote-first\b|\banywhere\b/.test(t)) return "remote";
  if (/\bon-?\s?site\b|\bin[- ]office\b|\boffice[- ]based\b|\bin[- ]person\b/.test(t)) return "onsite";
  return "";
}

/**
 * The job of the page read with a mapping: `values` is what lib/capture.js readMapped found ({field: text}). Each value
 * fills its field of the job (location -> location_text, salary -> salary_text, date -> posted_at when it is a date,
 * work_mode in the contract's words), cut to the job's limits; a field the mapping didn't find keeps what the page's
 * own reading gave. `method` and `description_from` say `site`; the person's selected text still wins as the
 * description. Null when the mapping finds no title: it doesn't work on this page.
 */
export function applyMappedValues(extracted, values) {
  const v = values && typeof values === "object" ? values : {};
  const title = clip(squash(v.title), JOB_LIMITS.title);
  if (!title || !extracted) return null;
  const job = { ...extracted.job, title };
  for (const [field, key] of [["company", "company"], ["location", "location_text"], ["salary", "salary_text"], ["employment_type", "employment_type"]]) {
    const x = clip(squash(v[field]), JOB_LIMITS[key]);
    if (x) job[key] = x;
  }
  const mode = mappedWorkMode(v.work_mode);
  if (mode) job.work_mode = mode;
  const date = isoDate(v.date);
  if (date) job.posted_at = date;
  const description = clip(tidy(str(v.description)), JOB_LIMITS.description);
  if (description && job.description_from !== "selection") {
    job.description = description;
    job.description_from = "site";
  }
  job.method = "site";
  return { ...extracted, job };
}

/** The values a mapping found, as the popup shows them before the person accepts it: [{field, value}] in the app's order. */
export function mappedPreview(fields, values) {
  const v = values && typeof values === "object" ? values : {};
  return (fields || []).map((f) => {
    let value = f.name === "description" ? tidy(str(v[f.name])) : squash(v[f.name]);
    if (f.name === "date") value = isoDate(value) || value;
    if (f.name === "work_mode") value = { onsite: "On-site", hybrid: "Hybrid", remote: "Remote" }[mappedWorkMode(value)] || value;
    if (f.name !== "description") value = clip(value, 500);
    return { field: f.name, value };
  });
}
