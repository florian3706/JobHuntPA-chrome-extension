# End-to-end tests

`e2e.cjs` loads the unpacked extension into real Chromium (Playwright, new headless mode), connects it
through the options page, and exercises: capture of a page with JSON-LD and one without, preview, edit,
save, update of an existing job, selected text, workspace switch, add source, test source, 409, restricted
pages, 401 / 423 / 429 (rate and "busy"), stale and vanished workspaces (popup and options notices), "saved but filtered out" note, bad key, disconnect and "server down".

Setup (once, outside the extension folder or here; `node_modules` is git-ignored):

```sh
cd tests && npm install playwright      # use the Chromium you already have, no need to run `playwright install`
```

Run against the bundled mock server (implements the API contract):

```sh
NODE_PATH=$PWD/tests/node_modules CHROME_BIN=/path/to/chrome node tests/e2e.cjs
```

`CHROME_BIN` is a full Chromium/Chrome binary (not the headless shell); omit it to use Playwright's own.
Screenshots land in `tests/out/`.

Run against a real JobHuntPA server:

1. In JobHuntPA: Settings, Browser extension, Connect a browser extension; copy the key.
2. `JHPA_SERVER=http://127.0.0.1:8000 JHPA_KEY=jhpa_... node tests/e2e.cjs`

Real mode serves `tests/pages/*.html` from a throw-away local server, saves two test jobs
("Senior Analyst", "Data Engineer") and adds/tests one source (`.../pages/careers.html`) in the account's
first workspace, so use a scratch account or delete them afterwards. Mock-only assertions (exact field values,
request headers) are skipped. The server's crawler may refuse a local address; then the source test shows
that error and the run still passes.

Headless Chromium cannot answer the browser's permission prompt, so the harness loads a temporary copy of the
extension whose manifest has `host_permissions` for the server host (the shipped manifest has none).
That also means `activeTab` is not what grants page access in this run; the popup is opened as a background tab
next to the page tab so `tabs.query({active: true, currentWindow: true})` finds the page tab.
