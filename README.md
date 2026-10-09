# JobHuntPA for Chrome

Browser extension for [JobHuntPA](https://github.com/florian3706/JobHuntPA), the self-hosted job-search
app. From any web page you can:

- **Add job**: send the page you are looking at to your JobHuntPA server. The server reads the posting
  (title, company, location, salary, work mode, description); you check or edit the fields and save. If
  the job is already there, the popup says so and lets you update it. Because the page is read in your own
  browser, postings behind a sign-in work too.
- **Add source**: add a careers page or job board as a company source that JobHuntPA's searches crawl, with
  an optional label and a "Test" that shows how many postings were found and a few samples.

Works with Chrome and other Chromium browsers (Edge, Brave, ...). Manifest V3, Chrome 111 or newer. A
Firefox version with identical code lives in `JobHuntPA-firefox-extension`.

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions`, switch on **Developer mode**, press **Load unpacked** and choose this folder.
3. The options page opens. Pin the extension (puzzle icon) to keep its button in the toolbar.

To build a zip for the Chrome Web Store: `scripts/package.sh` writes `dist/jobhuntpa-chrome-<version>.zip`
(upload it in the Developer Dashboard; bump `version` in `manifest.json` for every upload).

## Connect to JobHuntPA

1. In JobHuntPA open **Settings**, then **Browser extension**, then **Connect a browser extension**
   (needs a password entry from the last 15 minutes). Give it a name such as "Chrome on laptop".
2. Copy the **server address** and the **extension key** (shown once).
3. In the extension's options page paste both and press **Connect**. Chrome asks whether the extension may
   access your server; allow it. Pick a workspace if you have several.

The address can be `http://127.0.0.1:8000`, `http://raspberrypi.local:8000`, a LAN IP or an https name such
as a Tailscale one. Without a scheme, `https://` is assumed except for localhost, IP addresses and local names.
**Disconnect** deletes the key from the browser and withdraws the permission; revoke the key in JobHuntPA too
if the device is lost.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page in the current tab, only when you open the popup. |
| `scripting` | Run the small function that collects the page's URL, title, HTML, text and selection. |
| `storage` | Keep the server address, key and chosen workspace in `storage.local` (never synced). |
| optional hosts `http://*/*`, `https://*/*` | Requested at runtime for **your server's address only**, when you press Connect. Nothing else is ever requested. |

There is no `<all_urls>` host permission, no content script on every page, no remote code, no analytics.

## Privacy

The page you add (its URL, title, HTML, visible text and your text selection) is sent only to the JobHuntPA
server you configured, and only when you open the popup on that page and use it. Requests carry the
extension key as a bearer token; no cookies are sent. The extension talks to no other server and collects
no data. The key is stored locally in `storage.local` and never logged.

## Develop and test

No build step, no dependencies. The code is plain ES modules; `lib/api.js` implements the HTTP API, `lib/capture.js`
the page capture, `popup/` and `options/` the UI. End-to-end tests with a mock server (and how to run them
against a real server) are in `tests/README.md`. The Firefox repository has the same source except
`manifest.json`.
