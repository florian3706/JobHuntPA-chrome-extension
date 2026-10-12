# End-to-end tests

`e2e.cjs` loads the unpacked extension into real Chromium (Playwright, new headless mode), connects it
through the options page, and exercises: reading the job in the browser from a JSON-LD page (also inside `@graph`),
a SEEK-style `data-automation` page, a plain page, a 4 MB script-heavy page (the request must stay tiny and carry none of
it), a selection and a page without a title; that the request is only `{url, canonical_url, job}` with plain-text values
(the mock refuses anything else, as the v3 contract says); a page of search results in the shape of SEEK's
(`pages/results-seek.html`, made-up jobs: the list, the ticks, adding, adding again, an older server, an error;
the request is only `{url, jobs}` with the ticked jobs' card values, and nothing is sent before Add); preview ("already saved?"), edit,
save, update of an existing job, selected text, workspace switch, add source, test source, 409, restricted
pages, 401 / 423 / 429 (rate and "busy"), stale and vanished workspaces (popup and options notices), "saved but filtered out" note, bad key, the popup's Settings (what it is connected to, check connection, reconnect, reset with its question), reset on the options page and "server down".

Unit tests of the pure functions in `lib/extract.js` (JSON-LD to fields, HTML to text, titles, precedence, body
building, job cards to a list of jobs, "3d ago" to a date) need nothing installed: `node --test tests/extract.test.mjs`.

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
request headers) are skipped. The server's crawler may refuse a local address; then the source test shows
that error and the run still passes.

Headless Chromium cannot answer the browser's permission prompt, so the harness loads a temporary copy of the
extension whose manifest has `host_permissions` for the server host (the shipped manifest has none).
That also means `activeTab` is not what grants page access in this run; the popup is opened as a background tab
next to the page tab so `tabs.query({active: true, currentWindow: true})` finds the page tab.
