// Unit tests for lib/extract.js (pure functions). Run: node --test tests/extract.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText, cleanTitle, fromJsonLd, pickPosting, extractJob, buildBody, notesFor, workModeFromText } from "../lib/extract.js";

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
  assert.equal(extractJob(raw({ url: "https://www.acme.com/j/1" }), NO_DOM).job.company, "acme.com");
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
