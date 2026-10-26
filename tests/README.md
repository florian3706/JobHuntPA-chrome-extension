# End-to-end tests

`e2e.cjs` loads the unpacked extension into real Chromium (Playwright, new headless mode), connects it
through the options page, and exercises: reading the job in the browser from a JSON-LD page (also inside `@graph`),
a SEEK-style `data-automation` page, a plain page, a 4 MB script-heavy page (the request must stay tiny and carry none of
it), a selection and a page without a title; that the request is only `{url, canonical_url, job}` with plain-text values
(the mock refuses anything else, as the contract says); a page of search results in the shape of SEEK's
(`pages/results-seek.html`, made-up jobs: the list, the ticks, adding, adding again, an older server, an error;
the request is only `{url, jobs}` with the ticked jobs' card values, and nothing about the page is sent before Add jobs
or before the Add job tab is opened); preview ("already saved?"), edit, save, update of an existing job, selected text,
workspace switch, add source, test source, 409, restricted pages, 401 / 423 / 429 (rate and "busy"), stale and vanished
workspaces (popup and options notices), "saved but filtered out" note, bad key, the popup's Settings (what it is
connected to, check connection, reconnect; no Reset there), reset on the options page (with its question) and "server down".

The preview the run checks is the one the README and `store/privacy.md` describe. Opening the popup on a web page,
whether or not it is a job ad (any page except a page of search results the extension recognises, which so far means
SEEK's, that shows no job of its own, where what it read is sent only once you open the **Add job** tab; when a results
page also shows one, such as a job open beside the list in SEEK's split view or a job in the page's job data, that job
is sent at once as on any other page), sends what the extension read there to your JobHuntPA server at once, before you
edit anything, to check whether the job is already saved: the page's address, the job's title and details, and a
description that may be the visible text of the page's main part or of the whole page. Nothing is saved by that; **Save
job** sends the job with your edits. The run checks that the preview's body is only `{url, canonical_url, job}` with
plain-text values, that it is sent again when the workspace changes, and that, on a page of search results that shows no
job of its own, it is sent only when the **Add job** tab is opened (`pages/results-seek.html` shows none; a results page
that also shows a job, which sends that job at once, is not one of the run's pages).

AI mappings (api 3, Part 8 of the app's `docs/design/open-source.md`): a job site the extension doesn't know
(`pages/job-mapped.html`, served for `https://jobs.example.org/role/77`): the offer, the work-out request (only
`{kind, url, outline}`; the outline holds none of the page's scripts, styles, comments, form values, hidden parts,
event handlers, bad element names, SVG insides or link queries, and the mock checks it as strictly as the app does),
the job the layout finds shown field by field, nothing saved before **Use this layout**, a 409 `too_many_mappings`
(the app's detail shown, nothing saved), the PUT (the checked layout, rebuilt, at the page's own site unless the
answer's site is a valid site name), the job saved with method `site`; the saved layout used the next time without a work-out; a changed page (`job-mapped-changed.html`,
`/role/78`) where it no longer finds a title, offered again; the work-out's errors (AI not set up, busy, not worked
out, AI failed, timed out, an answer with a mapping outside the shape of 8.7), a slow answer, an answer that finds no title, an older server (nothing looked up); a
mapping in the page (an event-handler attribute refused, a selector the browser rejects is a field not found, values
cut to the limits) and two pages over the caps (`outline-deep.html`: 120 levels, 20,000 more elements;
`outline-wide.html`: long attributes and texts) whose outlines are cut to fit. "Add as a source" on the open careers
page: the jobs the app found shown before anything is saved, Add, 409, Cancel, another address added directly; a page
the AI works out (`careers-acme.html` for `https://careers.acme.example/jobs`: the source saved with the app's
mapping, then 200 `updated`), one where the layout finds none, AI not set up (add it anyway), busy, a refused
address and an older server.

Unit tests of the pure functions in `lib/extract.js` and `lib/mapping.js` (JSON-LD to fields, HTML to text, titles,
precedence, body building, job cards to a list of jobs, "3d ago" to a date, the site of a page, a layout's check, the
outline cut to the caps, a layout's values made into the job) and of the in-page outline builder and layout reader of
`lib/capture.js` (on a small stand-in for the page's DOM, checked with the mock's copy of the app's outline check) need
nothing installed: `node --test tests/extract.test.mjs`.

Setup (once, outside the extension folder or here; `node_modules` is git-ignored):

```sh
cd tests && npm install playwright      # use the Chromium you already have, no need to run `playwright install`
```

Run against the bundled mock server (implements the API contract):

```sh
NODE_PATH=$PWD/tests/node_modules CHROME_BIN=/path/to/chrome node tests/e2e.cjs
```

`CHROME_BIN` is a full Chromium or Chrome for Testing binary (not the headless shell); omit it to use Playwright's own.
Google Chrome itself no longer loads unpacked extensions from the command line (`--load-extension`), so the run
waits for the extension and times out with it.
Screenshots land in `tests/out/`.

Run against a real JobHuntPA server:

1. In JobHuntPA: Settings, Browser extension, Connect a browser extension; copy the key.
2. `JHPA_SERVER=http://127.0.0.1:8000 JHPA_KEY=jhpa_... node tests/e2e.cjs`

Add `JHPA_EMAIL` and `JHPA_PASSWORD` (a throw-away account) and the run also signs in with a cookie session to read back
what was saved (`GET /api/jobs?include=excluded,hidden`, `GET /api/jobs/{id}`: title, company, location, salary, stored
address, `source: "browser:single:<site>"` (`browser:bulk:seek.com.au` for the results page's jobs), plain-text description), and to make and revoke a key (revoked key message) and to try
a workspace the server does not know. It also checks the POST bodies seen on the wire (only `url`, `canonical_url`, `job`; small).

Real mode serves `tests/pages/*.html` from a throw-away local server, saves the test pages' jobs
("Senior Analyst", "Data Engineer", ...), the six made-up jobs of the results page (opened at `au.seek.com`,
where SEEK lives; stored under `https://www.seek.com.au/job/7000000N`, the address JobHuntPA's searches use) and adds/tests one source (`.../pages/careers.html`) in the account's
first workspace, so use a scratch account or delete them afterwards. Mock-only assertions (exact field values,
request headers) are skipped. A real server refuses a careers page on this computer as a source (`refused_address`),
which the run checks; it adds `https://careers.acme.example/jobs` instead (the server can't read that made-up page,
so it is added "anyway", without a layout). For the AI mappings the run expects the AI **not** to be set up: each
work-out (the job site, the two pages over the caps) must answer "AI not set up", which shows the outline passed the
server's checks; the saved-mapping endpoints are exercised with the key (PUT new and replaced, GET, the list, refusals,
DELETE, 404 `not_found`) and the popup reads `https://jobs.example.org/role/77` with the layout PUT for
`jobs.example.org`, saves that job and is offered a new work-out on `/role/78`.

Headless Chromium cannot answer the browser's permission prompt, so the harness loads a temporary copy of the
extension whose manifest has `host_permissions` for the server host (the shipped manifest has none).
That also means `activeTab` is not what grants page access in this run; the popup is opened as a background tab
next to the page tab so `tabs.query({active: true, currentWindow: true})` finds the page tab.
