// Unit tests for lib/extract.js (pure functions). Run: node --test tests/extract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { isoDate, companyFromUrl, htmlToText, cleanTitle, fromJsonLd, pickPosting, extractJob, buildBody, notesFor, workModeFromText } from "../lib/extract.js";
import { relativeDate, extractListing, buildListBody, listingNote, LIST_LIMITS } from "../lib/extract.js";

const NO_DOM = undefined; // node has no DOMParser: htmlToText uses its fallback; the browser path is covered by tests/e2e.cjs
const posting = {
  "@type": "JobPosting",
  title: "Senior Analyst",
  description: "<p>Analyse &amp; report.</p><ul><li>SQL</li><li>Python</li></ul><p>Line one<br>Line two</p><script>alert(1)</script>",
  hiringOrganization: { "@type": "Organization", name: "Example Corp" },
  jobLocation: [
    { address: { addressLocality: "Berlin", addressRegion: "BE", addressCountry: "DE" } },
    { address: { addressLocality: "Hamburg", addressCountry: { name: "Germany" } } },
  ],
  baseSalary: { currency: "EUR", value: { minValue: 60000, maxValue: 75000, unitText: "YEAR" } },
  employmentType: ["FULL_TIME", "CONTRACTOR"],
  jobLocationType: "TELECOMMUTE",
  datePosted: "2026-09-30",
  url: "https://example.com/careers/1",
};

test("htmlToText keeps paragraphs, list items and line breaks, decodes entities, drops scripts", () => {
  const t = htmlToText(posting.description, NO_DOM);
  assert.equal(t, "Analyse & report.\n\n- SQL\n- Python\n\nLine one\nLine two");
  assert.ok(!/[<>]/.test(t));
});

test("htmlToText converts entity-encoded markup too", () => {
  assert.equal(htmlToText("&lt;p&gt;Hello&lt;/p&gt;&lt;p&gt;World&lt;/p&gt;", NO_DOM), "Hello\n\nWorld");
  assert.equal(htmlToText("", NO_DOM), "");
  assert.equal(htmlToText(null, NO_DOM), "");
});

test("fromJsonLd: every field", () => {
  const j = fromJsonLd(posting, NO_DOM);
  assert.equal(j.title, "Senior Analyst");
  assert.equal(j.company, "Example Corp");
  assert.equal(j.location_text, "Berlin, BE, DE; Hamburg, Germany");
  assert.equal(j.salary_text, "EUR 60,000–75,000 per year");
  assert.equal(j.employment_type, "Full time, Contract");
  assert.equal(j.work_mode, "remote");
  assert.equal(j.posted_at, "2026-09-30");
  assert.equal(j.url, "https://example.com/careers/1");
});

test("fromJsonLd: odd shapes do not throw", () => {
  const j = fromJsonLd({ title: "X", hiringOrganization: "Acme", jobLocation: { address: "Paris, France" }, baseSalary: { currency: "USD", value: 50 }, employmentType: "PART_TIME", datePosted: "not a date" }, NO_DOM);
  assert.equal(j.company, "Acme");
  assert.equal(j.location_text, "Paris, France");
  assert.equal(j.salary_text, "USD 50");
  assert.equal(j.employment_type, "Part time");
  assert.equal(j.posted_at, "");
  assert.equal(j.work_mode, "unknown");
  assert.doesNotThrow(() => fromJsonLd({}, NO_DOM));
  assert.equal(fromJsonLd({ baseSalary: 1234 }, NO_DOM).salary_text, "1234");
});

test("work mode only when plain", () => {
  assert.equal(workModeFromText("Data Engineer (Hybrid)", { loose: true }), "hybrid");
  assert.equal(workModeFromText("Location: Hamburg (hybrid)"), "hybrid");
  assert.equal(workModeFromText("We hybridise cats"), "unknown");
  assert.equal(workModeFromText("You will remotely control nothing"), "unknown");
  assert.equal(workModeFromText("This is a fully remote role."), "remote");
});

test("cleanTitle", () => {
  assert.equal(cleanTitle("Senior Analyst | Example Corp Careers"), "Senior Analyst");
  assert.equal(cleanTitle("Data Engineer - Acme Ltd", { aggressive: true }), "Data Engineer");
  assert.equal(cleanTitle("Data Engineer - Acme Ltd", { names: ["Acme Ltd"] }), "Data Engineer");
  assert.equal(cleanTitle("Engineer - Backend", { names: ["Acme"] }), "Engineer - Backend");
  assert.equal(cleanTitle("Nurse - job post"), "Nurse");
  assert.equal(cleanTitle("   "), "");
});

test("pickPosting prefers the one whose url matches", () => {
  const a = { title: "A", url: "https://x.com/a" };
  const b = { title: "B", url: "https://x.com/b/" };
  assert.equal(pickPosting([a, b], ["https://x.com/b"]).title, "B");
  assert.equal(pickPosting([a, b], []).title, "A");
  assert.equal(pickPosting([], []), null);
});

const raw = (over = {}) => ({
  url: "https://example.com/careers/1",
  canonical_url: "",
  page_title: "Senior Analyst | Example Corp Careers",
  meta: { og_title: "", og_site_name: "", description: "" },
  h1: "Senior Analyst",
  jsonld: [],
  found: {},
  description: "Page text here.",
  description_source: "main",
  selection: "",
  ...over,
});

test("extractJob: JSON-LD wins, description from structured data", () => {
  const e = extractJob(raw({ jsonld: [posting], found: { title: "Other", company: "Other Co" } }), NO_DOM);
  assert.equal(e.job.title, "Senior Analyst");
  assert.equal(e.job.company, "Example Corp");
  assert.equal(e.job.method, "jsonld");
  assert.equal(e.job.description_from, "structured");
  assert.ok(e.job.description.startsWith("Analyse & report."));
});

test("extractJob: site elements beat heuristics, then heuristics", () => {
  const s = extractJob(raw({ found: { title: "Site Title", company: "Site Co", location_text: "Sydney NSW" } }), NO_DOM);
  assert.deepEqual([s.job.title, s.job.company, s.job.location_text, s.job.method], ["Site Title", "Site Co", "Sydney NSW", "site"]);
  const p = extractJob(raw({ h1: "", meta: { og_title: "", og_site_name: "Acme", description: "" } }), NO_DOM);
  assert.equal(p.job.title, "Senior Analyst");
  assert.equal(p.job.company, "Acme");
  assert.equal(p.job.method, "page");
  assert.equal(p.job.description_from, "main");
  assert.equal(extractJob(raw({ url: "https://www.acme.com/j/1" }), NO_DOM).job.company, "Acme");
  assert.equal(extractJob(raw({ url: "http://127.0.0.1:8000/j/1" }), NO_DOM).job.company, "");
});

test("extractJob: selection beats everything for the description", () => {
  const e = extractJob(raw({ jsonld: [posting], selection: "Just this  sentence." }), NO_DOM);
  assert.equal(e.job.description, "Just this sentence.");
  assert.equal(e.job.description_from, "selection");
  assert.ok(notesFor(e.job).some((n) => /Selected text/.test(n)));
});

test("extractJob: nothing usable gives an empty title and a hint", () => {
  const e = extractJob(raw({ page_title: "", h1: "", description: "", description_source: "" }), NO_DOM);
  assert.equal(e.job.title, "");
  assert.ok(notesFor(e.job).some((n) => /No job title/.test(n)));
});

test("buildBody: edits win, empty values are left out, limits hold, no extra keys", () => {
  const e = extractJob(raw({ jsonld: [posting], canonical_url: "https://example.com/c/1" }), NO_DOM);
  const b = buildBody(e, { title: "Edited", company: "", work_mode: "hybrid", salary_text: "x".repeat(600) });
  assert.deepEqual(Object.keys(b), ["url", "canonical_url", "job"]);
  assert.equal(b.job.title, "Edited");
  assert.ok(!("company" in b.job));
  assert.equal(b.job.work_mode, "hybrid");
  assert.equal(b.job.salary_text.length, 500);
  assert.ok(!/<\/?[a-z]/i.test(b.job.description));
  const allowed = ["title", "company", "location_text", "salary_text", "employment_type", "work_mode", "posted_at", "url", "description", "description_from", "method"];
  assert.ok(Object.keys(b.job).every((k) => allowed.includes(k)));
  assert.ok(!("canonical_url" in buildBody(extractJob(raw(), NO_DOM))));
});

test("buildBody keeps a huge description under the body limit", () => {
  const e = extractJob(raw({ description: "é".repeat(100000) }), NO_DOM);
  const b = buildBody(e);
  assert.ok(new TextEncoder().encode(JSON.stringify(b)).length <= 400000);
});

test("isoDate: only dates the server accepts are returned; close forms are fixed", () => {
  const server = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)?$/;
  const cases = {
    "2026-10-01": "2026-10-01",
    "2026-10-01T09:00:00+10:00": "2026-10-01T09:00:00+10:00",
    "2026-10-01T09:00:00Z": "2026-10-01T09:00:00Z",
    "2026-10-01T09:00:00.123456Z": "2026-10-01T09:00:00.123456Z",
    "2026-10-01T09:00": "2026-10-01T09:00",
    "2026-10-1": "2026-10-01",
    "2026-1-5": "2026-01-05",
    "2026-10-01T9:00:00": "2026-10-01T09:00:00",
    "2026-10-01t09:00:00z": "2026-10-01T09:00:00Z",
    "2026-10-01T09:00:00+10": "2026-10-01T09:00:00+10:00",
    "2026-10-01T09:00:00+1000": "2026-10-01T09:00:00+1000",
    "2026-10-01 09:00:00": "2026-10-01 09:00:00".replace(" ", "T"),
    "2026-10-01T09:00:00,5Z": "2026-10-01T09:00:00.5Z",
    "  2026-10-01  ": "2026-10-01",
    "October 1, 2026": "2026-10-01",
    "1 Oct 2026": "2026-10-01",
    "01/10/2026": "",
    "2026-13-01": "",
    "2026-10-32": "",
    "2026-10-01T25:00:00Z": "",
    "2026-10-01Z": "",
    "yesterday": "",
    "Posted 3 days ago": "",
    "Job 1": "",
    "2026": "",
    "": "",
    null: "",
    1: "",
  };
  for (const [input, want] of Object.entries(cases)) {
    const got = isoDate(input === "null" ? null : input === "1" ? 1 : input);
    assert.equal(got, input === "2026-10-01Z" ? "" : want, JSON.stringify(input));
    if (got) assert.match(got, server, input);
  }
  assert.equal(isoDate("2026-10-01T09:00:00".padEnd(60, "0")), "");
});

test("JSON-LD datePosted odd forms go through isoDate; unusable ones are omitted from the body", () => {
  assert.equal(fromJsonLd({ title: "X", datePosted: "2026-10-1" }, NO_DOM).posted_at, "2026-10-01");
  assert.equal(fromJsonLd({ title: "X", datePosted: "2 days ago" }, NO_DOM).posted_at, "");
  const e = extractJob(raw({ jsonld: [{ ...posting, datePosted: "01/10/2026" }] }), NO_DOM);
  assert.ok(!("posted_at" in buildBody(e).job));
  e.job.posted_at = "junk";
  assert.ok(!("posted_at" in buildBody(e).job));
});

test("buildBody keeps every value inside the server's limits and lists", () => {
  const long = "é".repeat(700) + "😀".repeat(3);
  const e = extractJob(raw({ jsonld: [{ ...posting, title: "T".repeat(900), hiringOrganization: long, employmentType: "x".repeat(300), url: "javascript:alert(1)" }], canonical_url: "ftp://x/y" }), NO_DOM);
  e.job.work_mode = "sometimes";
  const b = buildBody(e, { location_text: "😀".repeat(400) });
  const limits = { title: 500, company: 500, location_text: 500, salary_text: 500, employment_type: 100, posted_at: 40, url: 2048, description: 100000 };
  for (const [k, n] of Object.entries(limits)) if (k in b.job) assert.ok(b.job[k].length <= n, k);
  assert.ok(!("work_mode" in b.job));
  assert.ok(!("url" in b.job));
  assert.ok(!("canonical_url" in b));
  assert.ok(!/[\ud800-\udbff]$/.test(b.job.location_text));
  assert.ok(["selection", "structured", "site", "main", "body", ""].includes(b.job.description_from ?? ""));
  assert.ok(["jsonld", "site", "page", ""].includes(b.job.method ?? ""));
});

test("companyFromUrl: job boards give the company from the path or subdomain", () => {
  const c = companyFromUrl;
  assert.equal(c("https://boards.greenhouse.io/acme-corp/jobs/123"), "Acme Corp");
  assert.equal(c("https://job-boards.greenhouse.io/acme/jobs/1?gh_jid=1"), "Acme");
  assert.equal(c("https://job-boards.eu.greenhouse.io/acme/jobs/1"), "Acme");
  assert.equal(c("https://boards.greenhouse.io/embed/job_app?for=big-co&token=1"), "Big Co");
  assert.equal(c("https://boards.greenhouse.io/"), "");
  assert.equal(c("https://jobs.lever.co/acme-corp/abc-123"), "Acme Corp");
  assert.equal(c("https://apply.workable.com/acme-corp/j/ABC123/"), "Acme Corp");
  assert.equal(c("https://jobs.ashbyhq.com/acme/1b2c"), "Acme");
  assert.equal(c("https://jobs.smartrecruiters.com/AcmeCorp/743999-engineer"), "AcmeCorp");
  assert.equal(c("https://careers.smartrecruiters.com/acme-corp/x"), "Acme Corp");
  assert.equal(c("https://acme-corp.wd5.myworkdayjobs.com/en-US/External/job/Sydney/Dev_R1"), "Acme Corp");
  assert.equal(c("https://wd5.myworkdayjobs.com/x"), "");
  assert.equal(c("https://acme.bamboohr.com/careers/12"), "Acme");
  assert.equal(c("https://acme-corp.recruitee.com/o/dev"), "Acme Corp");
  assert.equal(c("https://acme.teamtailor.com/jobs/1-dev"), "Acme");
  assert.equal(c("https://acme.applytojob.com/apply/x"), "Acme");
});

test("companyFromUrl: multi-employer boards give nothing; other sites give their own name", () => {
  const c = companyFromUrl;
  for (const u of ["https://www.seek.com.au/job/1", "https://au.linkedin.com/jobs/view/1", "https://au.indeed.com/viewjob?jk=1", "https://www.glassdoor.com.au/job-listing/x", "https://www.reed.co.uk/jobs/1"]) assert.equal(c(u), "", u);
  assert.equal(c("https://careers.acme.com.au/jobs/1"), "Acme");
  assert.equal(c("https://www.acme.com/j/1"), "Acme");
  assert.equal(c("https://jobs.acme-corp.co.uk/x"), "Acme Corp");
  assert.equal(c("https://acme.io/careers"), "Acme");
  assert.equal(c("https://sub.deep.example.org/x"), "Example");
  assert.equal(c("http://127.0.0.1:8000/j/1"), "");
  assert.equal(c("http://localhost:3000/j/1"), "");
  assert.equal(c("http://[::1]:8000/"), "");
  assert.equal(c("not a url"), "");
  assert.equal(c("ftp://acme.com/x"), "");
});

test("extractJob: the address fallback is last, and a board never becomes the company", () => {
  assert.equal(extractJob(raw({ url: "https://boards.greenhouse.io/acme-corp/jobs/1" }), NO_DOM).job.company, "Acme Corp");
  assert.equal(extractJob(raw({ url: "https://www.seek.com.au/job/1" }), NO_DOM).job.company, "");
  assert.equal(extractJob(raw({ url: "https://boards.greenhouse.io/acme-corp/jobs/1", meta: { og_site_name: "Real Name" } }), NO_DOM).job.company, "Real Name");
  assert.equal(extractJob(raw({ url: "https://boards.greenhouse.io/acme-corp/jobs/1", found: { company: "Site Co" } }), NO_DOM).job.company, "Site Co");
});

// ---------- a page of search results ----------

const NOW = new Date(2026, 9, 12, 13, 0, 0); // 12 October 2026, 1 pm (local time, as the card's "3d ago" is)
const seekCard = (over = {}) => ({
  id: "70000001",
  href: "https://www.seek.com.au/job/70000001?type=standard&ref=search-standalone&origin=cardTitle",
  title: "Product  Manager",
  company: "Northwind Software",
  locations: ["North Sydney, Sydney NSW"],
  arrangement: "(Hybrid)",
  salary: "",
  teaser: "Own the roadmap of a planning product.",
  points: ["Flexible work", "Small team"],
  classification: "(Information & Communication Technology)",
  subclassification: "Product Management & Development",
  listed: "4d ago•Viewed",
  type: "Full time",
  is_new: false,
  featured: false,
  ...over,
});
const rawList = (cards, site = "seek", url = "https://www.seek.com.au/product-manager-jobs?tags=new") => ({ url, listing: { site, cards } });

test("relativeDate: minutes, hours and days ago as a local date; nothing for anything else", () => {
  assert.equal(relativeDate("4d ago", NOW), "2026-10-08");
  assert.equal(relativeDate("4d ago•Viewed", NOW), "2026-10-08");
  assert.equal(relativeDate("27d ago · Expiring", NOW), "2026-09-15");
  assert.equal(relativeDate("3h ago", NOW), "2026-10-12");
  assert.equal(relativeDate("14h ago", NOW), "2026-10-11");
  assert.equal(relativeDate("7m ago", NOW), "2026-10-12");
  assert.equal(relativeDate("7m ago", new Date(2026, 9, 12, 0, 3)), "2026-10-11");
  assert.equal(relativeDate("1D AGO", NOW), "2026-10-11");
  for (const t of ["Featured", "", null, undefined, "30d+ ago", "30+d ago", "3 days ago", "Posted yesterday", "1.5d ago", "4dago", "ago"]) {
    assert.equal(relativeDate(t, NOW), "", String(t));
  }
  assert.equal(relativeDate("4d ago", new Date(NaN)), "");
});

test("extractListing: a SEEK card becomes a job under the job's own address, with a summary", () => {
  const { url, site, jobs } = extractListing(rawList([seekCard()]), NOW);
  assert.equal(url, "https://www.seek.com.au/product-manager-jobs?tags=new");
  assert.equal(site, "seek");
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.equal(j.url, "https://www.seek.com.au/job/70000001"); // from the job number, without the tracking parameters
  assert.equal(j.title, "Product Manager");
  assert.equal(j.company, "Northwind Software");
  assert.equal(j.location_text, "North Sydney, Sydney NSW");
  assert.equal(j.work_mode, "hybrid");
  assert.equal(j.employment_type, "Full time");
  assert.equal(j.posted_at, "2026-10-08");
  assert.equal(j.industry, "Product Management & Development");
  assert.equal(j.listed, "4d ago · Viewed");
  assert.deepEqual([j.is_new, j.viewed, j.applied], [false, true, false]);
  assert.equal(
    j.description,
    "Own the roadmap of a planning product.\n\n- Flexible work\n- Small team\n\nWork type: Full time\nClassification: Product Management & Development, Information & Communication Technology",
  );
});

test("extractListing: a job's address is on the page's own site (SEEK is at au.seek.com now)", () => {
  for (const [page, want] of [
    ["https://au.seek.com/product-manager-jobs?tags=new", "https://au.seek.com/job/70000001"],
    ["https://www.seek.com.au/product-manager-jobs", "https://www.seek.com.au/job/70000001"],
    ["https://nz.seek.com/jobs?page=2", "https://nz.seek.com/job/70000001"],
  ]) {
    assert.equal(extractListing(rawList([seekCard()], "seek", page), NOW).jobs[0].url, want);
  }
});

test("extractListing: work arrangement, several places, badges and missing values", () => {
  const { jobs } = extractListing(
    rawList([
      seekCard({ id: "1", arrangement: "(Remote)", listed: "1d ago•Applied", salary: "$125,000 – $145,000 per year" }),
      seekCard({ id: "2", arrangement: "( On-site )", locations: ["Hamburg", "Perth WA", "Hamburg"], is_new: true, listed: "7m ago" }),
      seekCard({ id: "3", arrangement: "", title: "Remote Product Lead", type: "Contract/Temp", points: [], teaser: "", classification: "", subclassification: "", listed: "30d+ ago" }),
      seekCard({ id: "4", arrangement: "", company: "", locations: [], points: null, listed: "" }),
    ]),
    NOW,
  );
  assert.deepEqual(jobs.map((j) => j.work_mode), ["remote", "onsite", "remote", "unknown"]);
  assert.deepEqual(jobs.map((j) => j.posted_at), ["2026-10-11", "2026-10-12", "", ""]);
  assert.deepEqual(jobs.map((j) => [j.is_new, j.viewed, j.applied]), [[false, false, true], [true, false, false], [false, false, false], [false, false, false]]);
  assert.equal(jobs[0].salary_text, "$125,000 – $145,000 per year");
  assert.equal(jobs[1].location_text, "Hamburg; Perth WA");
  assert.equal(jobs[2].description, "Work type: Contract/Temp");
  assert.equal(jobs[2].industry, "");
  assert.equal(jobs[3].company, "");
  assert.equal(jobs[3].location_text, "");
});

test("extractListing: a job shown twice (a featured copy) is one job, the dated card giving the date", () => {
  const featured = seekCard({ listed: "Featured", featured: true, salary: "", is_new: true });
  const normal = seekCard({ listed: "4d ago•Viewed", salary: "$150k + super" });
  for (const cards of [[featured, normal], [normal, featured]]) {
    const { jobs } = extractListing(rawList(cards), NOW);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].posted_at, "2026-10-08");
    assert.equal(jobs[0].listed, "4d ago · Viewed");
    assert.equal(jobs[0].salary_text, "$150k + super");
    assert.deepEqual([jobs[0].is_new, jobs[0].viewed], [true, true]);
  }
  const only = extractListing(rawList([featured]), NOW).jobs[0];
  assert.deepEqual([only.posted_at, only.listed], ["", "Featured"]);
});

test("extractListing: cards without a job number or a title are left out; odd input gives nothing", () => {
  const { jobs } = extractListing(
    rawList([seekCard({ id: "" }), seekCard({ id: "12a" }), seekCard({ id: "1".repeat(21) }), seekCard({ id: "5", title: "   " }), null, "x", 7, seekCard({ id: "6" })]),
    NOW,
  );
  assert.deepEqual(jobs.map((j) => j.url), ["https://www.seek.com.au/job/6"]);
  for (const raw of [null, {}, { url: "https://www.seek.com.au/jobs" }, { url: "https://www.seek.com.au/jobs", listing: null }, { url: "https://www.seek.com.au/jobs", listing: { site: "seek", cards: "x" } }, { url: "not a url", listing: { site: "seek", cards: [seekCard()] } }]) {
    assert.deepEqual(extractListing(raw, NOW).jobs, []);
  }
});

test("extractListing: another board's card keeps its own link only when it is on the page's site", () => {
  const page = "https://jobs.example.com/search?q=pm";
  const { jobs } = extractListing(
    rawList(
      [
        seekCard({ id: "", href: "https://jobs.example.com/roles/42?ref=list#top", title: "Kept" }),
        seekCard({ id: "9", href: "https://evil.example/roles/42", title: "Another site" }),
        seekCard({ id: "9", href: "", title: "No link" }),
        seekCard({ id: "9", href: "javascript:alert(1)", title: "Not a link" }),
      ],
      "other",
      page,
    ),
    NOW,
  );
  assert.deepEqual(jobs.map((j) => [j.title, j.url]), [["Kept", "https://jobs.example.com/roles/42?ref=list"]]);
});

test("buildListBody: only the values the server takes, empty ones left out, at most 50 jobs", () => {
  const listing = extractListing(rawList([seekCard(), seekCard({ id: "2", arrangement: "", salary: "", company: "", listed: "Featured", is_new: true })]), NOW);
  const body = buildListBody(listing, listing.jobs);
  assert.deepEqual(Object.keys(body), ["url", "jobs"]);
  assert.equal(body.url, "https://www.seek.com.au/product-manager-jobs?tags=new");
  assert.deepEqual(Object.keys(body.jobs[0]), ["url", "title", "company", "location_text", "employment_type", "work_mode", "posted_at", "industry", "description"]);
  assert.deepEqual(Object.keys(body.jobs[1]), ["url", "title", "location_text", "employment_type", "industry", "description"]); // unknown work mode and no date: not sent
  assert.ok(!JSON.stringify(body).includes("is_new") && !JSON.stringify(body).includes("listed") && !JSON.stringify(body).includes("origin=cardTitle"));
  assert.deepEqual(buildListBody(listing, [listing.jobs[1]]).jobs.map((j) => j.url), ["https://www.seek.com.au/job/2"]); // only the picked ones
  const many = extractListing(rawList(Array.from({ length: 80 }, (_, i) => seekCard({ id: String(1000 + i) }))), NOW);
  assert.equal(many.jobs.length, 80);
  assert.equal(buildListBody(many, many.jobs).jobs.length, LIST_LIMITS.jobs);
  assert.equal(LIST_LIMITS.jobs, 50);
});

test("buildListBody: values are cut to the server's limits and stay plain", () => {
  const long = extractListing(rawList([seekCard({ teaser: "t".repeat(9000), title: "T".repeat(700), subclassification: "s".repeat(300), points: ["p".repeat(2000)] })]), NOW);
  const job = buildListBody(long, long.jobs).jobs[0];
  assert.equal(job.title.length, 500);
  assert.equal(job.industry.length, 200);
  assert.ok(job.description.length <= LIST_LIMITS.description);
  const odd = buildListBody({ url: "https://www.seek.com.au/jobs" }, [{ url: "https://www.seek.com.au/job/1", title: "A", work_mode: "moon", posted_at: "3d ago", description: 5, company: null }, { title: "no address" }, { url: "https://www.seek.com.au/job/2" }]);
  assert.deepEqual(odd.jobs, [{ url: "https://www.seek.com.au/job/1", title: "A" }]);
  assert.deepEqual(buildListBody({ url: "https://www.seek.com.au/jobs" }, null).jobs, []);
});

test("listingNote: how many jobs, and how many the board marks as new to you", () => {
  const job = (is_new) => ({ is_new });
  assert.equal(listingNote([job(false)]), "1 job found on this page.");
  assert.equal(listingNote([job(false), job(false)]), "2 jobs found on this page.");
  assert.equal(listingNote([job(true), job(false), job(true)]), "3 jobs found on this page. 2 are marked \u201cNew to you\u201d.");
  assert.equal(listingNote([job(true), job(false)]), "2 jobs found on this page. 1 is marked \u201cNew to you\u201d.");
  assert.equal(listingNote([job(true), job(true)]), "2 jobs found on this page. All are marked \u201cNew to you\u201d.");
  assert.equal(listingNote([job(true)]), "1 job found on this page. It is marked \u201cNew to you\u201d.");
});


// ---------- AI mappings (api 3): the outline, the site, a mapping applied ----------

import { createRequire } from "node:module";
import { siteOf, siteOfUrl, jobMappingFields, jobMappingOf, workOutRequest, truncateOutline, outlineStats, jsonBytes, OUTLINE_LIMITS } from "../lib/mapping.js";
import { readOutline, readMapped, OUTLINE_ARGS as PAGE_ARGS, LIMITS } from "../lib/capture.js";
const OUTLINE_ARGS = { ...PAGE_ARGS, asJson: false };
import { needsMapping, applyMappedValues, mappedWorkMode, mappedPreview } from "../lib/extract.js";
const { checkOutline, checkMapping } = createRequire(import.meta.url)("./mock-server.cjs");

// A small stand-in for the page's DOM: what readOutline and readMapped use of it, nothing more.
class FakeText {
  constructor(v) {
    this.nodeType = 3;
    this.nodeValue = v;
  }
}
class FakeEl {
  constructor(tag, attrs = {}, kids = []) {
    this.nodeType = 1;
    this.localName = tag;
    this._a = { ...attrs };
    this.display = this._a.__display || "block";
    this.isContentEditable = this._a.contenteditable === "true";
    delete this._a.__display;
    this.childNodes = kids.map((k) => (typeof k === "string" ? new FakeText(k) : k));
    this.children = this.childNodes.filter((k) => k.nodeType === 1);
    for (const c of this.children) if (this.isContentEditable) c.isContentEditable = true;
  }
  hasAttribute(n) {
    return n in this._a;
  }
  getAttribute(n) {
    return n in this._a ? this._a[n] : null;
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
  }
  get innerText() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.localName === "p" ? `\n${c.innerText}\n` : c.innerText)).join("");
  }
}
const h = (tag, attrs, ...kids) => new FakeEl(tag, attrs || {}, kids);
function withPage(body, title, fn, querySelector) {
  const saved = [globalThis.document, globalThis.getComputedStyle];
  globalThis.document = { body, title, querySelector };
  globalThis.getComputedStyle = (el) => ({ display: el.display });
  try {
    return fn();
  } finally {
    [globalThis.document, globalThis.getComputedStyle] = saved;
  }
}
const allNodes = (root) => {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children || []) walk(c);
  };
  walk(root);
  return out;
};

function trapPage() {
  return h("body", { class: "page", "data-session": "SECRET-DATA-ATTRIBUTE", onload: "SECRET-HANDLER" },
    h("script", {}, "SECRET-SCRIPT"),
    h("style", {}, "SECRET-STYLE"),
    h("nav", { "aria-label": "Main" }, h("ul", {}, ...["a", "b", "c", "d", "e", "f", "g"].map((x) => h("li", {}, h("a", { href: `/${x}?session=SECRET-QUERY#frag` }, `nav ${x}`))))),
    h("main", { class: "jt-main" },
      h("div", { class: "crumbs" }, h("span", { class: "ico" }), h("span", { class: "ico" })),
      h("h1", { class: "jt-title", onclick: "SECRET-HANDLER", style: "color:red" }, "  Customer\n  Success   Lead "),
      h("time", { class: "posted", datetime: "2026-10-01" }),
      h("div", { id: "jt-body" }, h("p", {}, "Look after our customers."), h("p", {}, "Second paragraph.")),
      h("input", { value: "secret-input-value", id: "n" }),
      h("textarea", { id: "t" }, "secret textarea text"),
      h("select", { id: "s" }, h("option", {}, "secret option")),
      h("div", { contenteditable: "true", class: "editor" }, "SECRET-TYPED", h("p", {}, "SECRET-TYPED-TOO")),
      h("div", { __display: "none" }, "HIDDEN-DISPLAY-NONE"),
      h("div", { hidden: "" }, "HIDDEN-ATTRIBUTE"),
      h("div", { "aria-hidden": "true" }, "HIDDEN-ARIA"),
      h("noscript", {}, "SECRET-NOSCRIPT"),
      h("template", {}, "SECRET-TEMPLATE"),
      h("iframe", { src: "/x" }),
      h("svg", { "aria-label": "Logo" }, h("linearGradient", {}, "SECRET-SVG")),
      h("my_widget", {}, "SECRET-BAD-TAG", h("p", {}, "inside")),
      h("o:p", {}, "SECRET-WORD-TAG"),
      h("p", { id: "x".repeat(201), class: Array.from({ length: 60 }, (_, i) => `c${i}`).join(" "), "data-qa": "long-text" }, "word ".repeat(40)),
      h("a", { href: "javascript:alert('SECRET-JS')" }, "a link that runs code"),
    ),
  );
}

test("readOutline: names, kept attributes and own text only; nothing hidden, no script, style, frame or form value", () => {
  const r = withPage(trapPage(), "Customer Success Lead | Northwind", () => readOutline(OUTLINE_ARGS));
  const json = JSON.stringify(r.outline);
  assert.equal(checkOutline(r.outline).bad, null, JSON.stringify(checkOutline(r.outline).bad));
  assert.equal(r.outline.title, "Customer Success Lead | Northwind");
  assert.ok(!/SECRET|secret|HIDDEN/.test(json), json);
  const nodes = allNodes(r.outline.root);
  assert.equal(r.elements, nodes.length);
  const tags = new Set(nodes.map((n) => n.tag));
  for (const t of ["script", "style", "noscript", "template", "iframe", "my_widget", "o:p", "linearGradient", "option"]) assert.ok(!tags.has(t), t);
  for (const n of nodes) for (const k of Object.keys(n.attrs || {})) assert.ok(OUTLINE_ARGS.attributes.includes(k), k);
  const h1 = nodes.find((n) => n.tag === "h1");
  assert.deepEqual(h1, { tag: "h1", attrs: { class: "jt-title" }, text: "Customer Success Lead" });
  assert.deepEqual(nodes.find((n) => n.tag === "time"), { tag: "time", attrs: { class: "posted", datetime: "2026-10-01" } });
  assert.deepEqual(nodes.find((n) => n.tag === "input"), { tag: "input", attrs: { id: "n" } });
  assert.deepEqual(nodes.find((n) => n.tag === "textarea"), { tag: "textarea", attrs: { id: "t" } });
  assert.deepEqual(nodes.find((n) => n.tag === "select"), { tag: "select", attrs: { id: "s" } }, "a list's options are left out");
  assert.deepEqual(nodes.find((n) => n.tag === "svg"), { tag: "svg", attrs: { "aria-label": "Logo" } }, "an svg goes without its insides");
  const editor = nodes.find((n) => n.attrs && n.attrs.class === "editor");
  assert.ok(!editor, "an editable area with no telling attribute holds no text, so it is left out");
  assert.ok(!nodes.some((n) => n.attrs && n.attrs.class === "ico"), "empty leaves are left out");
  const links = nodes.filter((n) => n.tag === "a");
  assert.equal(links.filter((n) => n.attrs && n.attrs.href).length, 5, "a navigation list: its first few items only");
  assert.ok(links.every((n) => !n.attrs || !/[?#]/.test(n.attrs.href || "")), "no query or fragment of a link");
  assert.ok(links.some((n) => n.text === "a link that runs code" && !n.attrs), "a javascript: link loses its href");
  const long = nodes.find((n) => n.attrs && n.attrs["data-qa"] === "long-text");
  assert.ok(!("id" in long.attrs), "an id over 200 characters is left out");
  assert.ok(long.attrs.class.length <= 200 && /^c0 c1 .* c\d+$/.test(long.attrs.class), long.attrs.class);
  assert.ok(long.text.length <= 100 && long.text.startsWith("word word"), long.text);
});

test("readOutline: stops at the caps, in document order (elements, depth, bytes)", () => {
  // 120 levels deep, then 5,000 more elements
  let deep = h("div", { class: "bottom" }, "the bottom");
  for (let i = 0; i < 120; i++) deep = h("div", { class: `l${i}` }, `level ${i}`, deep);
  const many = h("section", { id: "many" }, ...Array.from({ length: 100 }, (_, i) => h("ul", { class: "g" }, ...Array.from({ length: 50 }, (_, j) => h("li", {}, `Item ${i}.${j}`)))));
  let r = withPage(h("body", {}, h("main", {}, deep), many), "Deep", () => readOutline(OUTLINE_ARGS));
  let st = outlineStats(r.outline.root);
  assert.ok(st.depth <= 60 && st.elements <= 2000 && st.elements > 1900, JSON.stringify(st));
  assert.equal(checkOutline(r.outline).bad, null);
  assert.ok(r.cut);
  // long attributes and multi-byte texts: the byte cap first
  const names = ["id", "class", "role", "itemprop", "itemtype", "aria-label", "datetime", "title", "data-testid", "data-test", "data-qa", "data-automation", "data-cy"];
  const fat = () => h("p", Object.fromEntries(names.map((n) => [n, "ä".repeat(199)])), "😀 Umlaute äöü ".repeat(10));
  r = withPage(h("body", {}, ...Array.from({ length: 1000 }, fat)), "Wide", () => readOutline(OUTLINE_ARGS));
  const req = workOutRequest("job", "https://jobs.example.org/role/1", r.outline);
  assert.equal(checkOutline(req.outline).bad, null);
  assert.ok(jsonBytes(req) <= 200000 && jsonBytes(req) > 150000, String(jsonBytes(req)));
  for (const n of allNodes(req.outline.root).slice(1)) {
    assert.equal(Object.keys(n.attrs).length, 12);
    assert.ok(n.text.length <= 100 && !/[\ud800-\udbff]$/.test(n.text), "no half of an emoji at the cut");
  }
});

test("readOutline: no body, or a body that isn't an element's name, gives nothing", () => {
  assert.equal(withPage(null, "", () => readOutline(OUTLINE_ARGS)), null);
  assert.equal(withPage(h("frameset", {}), "", () => readOutline(OUTLINE_ARGS)), null);
});

test("workOutRequest: an outline over a cap is cut to fit, in document order; the request's shape", () => {
  const big = { title: "t".repeat(400), root: h2o(3000) };
  const req = workOutRequest("careers", "https://careers.acme.example/jobs", big);
  assert.deepEqual(Object.keys(req), ["kind", "url", "outline"]);
  assert.equal(req.outline.title.length, 300);
  const st = outlineStats(req.outline.root);
  assert.equal(st.elements, 2000);
  assert.equal(checkOutline(req.outline).bad, null);
  // too many bytes
  const fat = { root: { tag: "body", children: Array.from({ length: 1500 }, () => ({ tag: "p", text: "中".repeat(100), attrs: { title: "中".repeat(200) } })) } };
  const r2 = workOutRequest("job", "https://x.example/1", fat);
  assert.ok(jsonBytes(r2) <= OUTLINE_LIMITS.bytes && outlineStats(r2.outline.root).elements > 50, String(jsonBytes(r2)));
  // too deep
  let deep = { tag: "div" };
  for (let i = 0; i < 80; i++) deep = { tag: "div", children: [deep] };
  assert.equal(outlineStats(workOutRequest("job", "https://x.example/1", { root: deep }).outline.root).depth, 60);
  // no title key when there is none; nothing without a root
  assert.deepEqual(workOutRequest("job", "https://x.example/1", { title: "", root: { tag: "body" } }), { kind: "job", url: "https://x.example/1", outline: { root: { tag: "body" } } });
  assert.equal(workOutRequest("job", "https://x.example/1", null), null);
  assert.equal(workOutRequest("job", "https://x.example/1", { title: "", root: { tag: "body", text: "x".repeat(300000) } }), null);
  // truncateOutline keeps the first elements in document order
  const t = truncateOutline({ tag: "a", children: [{ tag: "b", children: [{ tag: "c" }] }, { tag: "d" }] }, 3);
  assert.deepEqual(t, { tag: "a", children: [{ tag: "b", children: [{ tag: "c" }] }] });
});
function h2o(n) {
  return { tag: "body", children: Array.from({ length: n }, (_, i) => ({ tag: "li", text: `Job ${i}` })) };
}

test("siteOf: the site of a page (Part 8, 8.8), or nothing for addresses the app can't take", () => {
  assert.equal(siteOf("WWW.Seek.com.au"), "seek.com.au");
  assert.equal(siteOf("jobs.example.org."), "jobs.example.org");
  assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
  assert.equal(siteOf("localhost"), "localhost");
  assert.equal(siteOf("xn--bcher-kva.example"), "xn--bcher-kva.example");
  for (const bad of ["[::1]", "my_host.example", "a..b", "-a.example", "a-.example", "", null, "bücher.example", "x".repeat(254)]) assert.equal(siteOf(bad), "", String(bad));
  assert.equal(siteOfUrl("https://www.jobs.example.org:8443/role/77?x=1"), "jobs.example.org");
  assert.equal(siteOfUrl("ftp://jobs.example.org/"), "");
  assert.equal(siteOfUrl("http://[::1]:8000/"), "");
});

const JOB_MAPPING = { version: 1, kind: "job", fields: { title: { selector: "h1.jt-title" }, date: { selector: "time.posted", attribute: "datetime" }, description: { selector: "#jt-body" }, company: null } };

test("jobMappingFields: a job mapping's fields, in the app's order; anything outside the shape of 8.7 is no mapping", () => {
  assert.deepEqual(jobMappingFields(JOB_MAPPING), [
    { name: "title", selector: "h1.jt-title", attribute: null },
    { name: "date", selector: "time.posted", attribute: "datetime" },
    { name: "description", selector: "#jt-body", attribute: null },
  ]);
  assert.ok(checkMapping(JOB_MAPPING, "job"), "the mock takes it as the app does");
  const bad = (fields, extra = {}) => jobMappingFields({ kind: "job", fields, ...extra });
  const ok = { title: { selector: "h1" }, description: { selector: "main" } };
  assert.ok(bad(ok));
  assert.equal(bad({ title: { selector: "h1" } }), null, "no description");
  assert.equal(bad({ ...ok, list: { selector: "li" } }), null, "a careers field");
  assert.equal(bad({ ...ok, company: { selector: "a", attribute: "onclick" } }), null, "an event handler");
  assert.equal(bad({ ...ok, company: { selector: "a", attribute: "1x" } }), null);
  assert.equal(bad({ ...ok, company: { selector: "a", code: "x" } }), null, "another key");
  for (const sel of ["h1{}", "a[href^=javascript:x]", "div/* x */", "p\\31", "a<b", "", " ", "x".repeat(301), "@import x"]) {
    assert.equal(bad({ ...ok, company: { selector: sel } }), null, sel);
  }
  assert.equal(bad(ok, { kind: "careers" }), null);
  assert.equal(bad(ok, { version: 2 }), null);
  assert.equal(jobMappingFields(null), null);
  assert.equal(jobMappingFields({ kind: "job", fields: [] }), null);
  assert.deepEqual(bad({ ...ok, company: { selector: "a", attribute: "Content" } })[1], { name: "company", selector: "a", attribute: "content" });
  assert.equal(bad(ok, { evil: "x" }), null, "a top-level key other than version, kind and fields");
  assert.ok(bad(ok, { version: 1 }));
});

test("jobMappingOf: the checked fields rebuilt as the mapping that is saved (PUT), in the app's shape", () => {
  const fields = jobMappingFields({ kind: "job", fields: { description: { selector: " #jt-body " }, date: { selector: "time.posted", attribute: " DateTime " }, title: { selector: "h1.jt-title", attribute: null }, company: null } });
  const m = jobMappingOf(fields);
  assert.deepEqual(m, { version: 1, kind: "job", fields: { title: { selector: "h1.jt-title" }, date: { selector: "time.posted", attribute: "datetime" }, description: { selector: "#jt-body" } } });
  assert.deepEqual(Object.keys(m.fields), ["title", "date", "description"], "the app's field order");
  assert.deepEqual(checkMapping(m, "job"), m, "the mock (the app's check) takes it unchanged");
  assert.deepEqual(jobMappingFields(m), fields, "a round trip");
});

test("readMapped: the browser's selector functions only; a selector the browser rejects is a field not found; values cut", () => {
  const body = h("body", {},
    h("h1", { class: "t" }, "  Lead\n  Engineer "),
    h("time", { datetime: "2026-10-01" }, "1 Oct"),
    h("div", { id: "d" }, h("p", {}, "One."), h("p", {}, "Two.")),
    h("span", { class: "huge" }, "x".repeat(9000)),
  );
  const index = { "h1.t": body.children[0], time: body.children[1], "#d": body.children[2], ".huge": body.children[3] };
  const qs = (sel) => {
    if (sel === "div:bogus(") throw new SyntaxError("not a valid selector");
    return index[sel] || null;
  };
  const fields = [
    { name: "title", selector: "h1.t", attribute: null },
    { name: "company", selector: "div:bogus(", attribute: null },
    { name: "location", selector: ".nowhere", attribute: null },
    { name: "salary", selector: ".huge", attribute: null },
    { name: "date", selector: "time", attribute: "datetime" },
    { name: "description", selector: "#d", attribute: null },
  ];
  const v = withPage(body, "", () => readMapped(fields, { short: LIMITS.short, description: 20 }), qs);
  assert.deepEqual(v, { title: "Lead Engineer", salary: "x".repeat(LIMITS.short), date: "2026-10-01", description: "One.\n\nTwo.".slice(0, 20).trim() });
});

test("needsMapping: only when the page's own reading found no title or no description", () => {
  assert.equal(needsMapping({ job: { title: "A", method: "jsonld", description: "d", description_from: "structured" } }), false);
  assert.equal(needsMapping({ job: { title: "A", method: "site", description: "d", description_from: "site" } }), false);
  assert.equal(needsMapping({ job: { title: "A", method: "site", description: "d", description_from: "selection" } }), false);
  assert.equal(needsMapping({ job: { title: "A", method: "page", description: "d", description_from: "body" } }), true);
  assert.equal(needsMapping({ job: { title: "A", method: "jsonld", description: "d", description_from: "main" } }), true);
  assert.equal(needsMapping({ job: { title: "", method: "page", description: "", description_from: "" } }), true);
});

test("applyMappedValues: what the mapping found fills the job, cut to its limits; no title is no use", () => {
  const page = extractJob({ url: "https://jobs.example.org/role/77", page_title: "Lead | Northwind", h1: "Lead", description: "Body text of the whole page.", description_source: "body" }, NO_DOM);
  const got = applyMappedValues(page, {
    title: "T".repeat(700),
    company: "Northwind Traders",
    location: " Melbourne\n VIC ",
    salary: "$95,000",
    employment_type: "E".repeat(150),
    work_mode: "Hybrid (3 days in the office)",
    date: "2026-10-01",
    description: "One.\r\n\r\n\r\nTwo.  ",
  });
  assert.equal(got.url, page.url);
  const j = got.job;
  assert.equal(j.title.length, 500);
  assert.equal(j.company, "Northwind Traders");
  assert.equal(j.location_text, "Melbourne VIC");
  assert.equal(j.employment_type.length, 100);
  assert.equal(j.work_mode, "hybrid");
  assert.equal(j.posted_at, "2026-10-01");
  assert.equal(j.description, "One.\n\nTwo.");
  assert.equal(j.description_from, "site");
  assert.equal(j.method, "site");
  const body = buildBody(got);
  assert.equal(body.job.method, "site");
  assert.equal(body.job.posted_at, "2026-10-01");
  // a date that isn't one is left out; a field the mapping didn't find keeps the page's own value; selection wins
  const sel = { ...page, job: { ...page.job, description: "Picked.", description_from: "selection" } };
  const j2 = applyMappedValues(sel, { title: "Lead", date: "last week", description: "From the layout" }).job;
  assert.equal(j2.posted_at, "");
  assert.equal(j2.company, page.job.company);
  assert.equal(j2.description, "Picked.");
  assert.equal(applyMappedValues(page, { title: "  ", description: "x" }), null);
  assert.equal(applyMappedValues(page, {}), null);
  assert.equal(applyMappedValues(page, { title: "Lead", description: "x".repeat(200000) }).job.description.length, 100000);
});

test("mappedWorkMode and mappedPreview", () => {
  assert.equal(mappedWorkMode("Remote"), "remote");
  assert.equal(mappedWorkMode("Work from home"), "remote");
  assert.equal(mappedWorkMode("On-site"), "onsite");
  assert.equal(mappedWorkMode("In office"), "onsite");
  assert.equal(mappedWorkMode("Hybrid / remote"), "hybrid");
  assert.equal(mappedWorkMode("Flexible"), "");
  const p = mappedPreview(jobMappingFields(JOB_MAPPING), { title: " Lead ", date: "2026-10-01T09:00:00+10:00" });
  assert.deepEqual(p, [{ field: "title", value: "Lead" }, { field: "date", value: "2026-10-01T09:00:00+10:00" }, { field: "description", value: "" }]);
});
