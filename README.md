# JobHuntPA for Chrome

Browser extension for [JobHuntPA](https://github.com/florian3706/JobHuntPA), the self-hosted job-search
app. From any web page you can:

- **Add job**: the extension reads the posting in the page you are looking at (title, company, location,
  salary, work mode, description), right in your browser, and fills in the form; you check or edit the fields
  and save, and only the finished job is sent to your JobHuntPA server. If the job is already there, the popup
  says so and lets you update it. Because the page is read in your own browser, postings behind a sign-in work too.
- **Jobs on this page**: on a SEEK search results page (any view or page of it, such as *New to you* or sorted
  by date) the popup lists the jobs on the page with tick boxes and adds the ticked ones in one go, each from the
  summary on its card. Jobs SEEK marks as new to you are ticked to start with. Jobs JobHuntPA already has are left
  as they are, so going over a page twice does no harm. You turn the pages yourself: the extension reads only
  the page you have open, and never clicks, scrolls or opens anything on the site.
- **Add source**: add a careers page or job board as a company source that JobHuntPA's searches crawl, with
  an optional label and a "Test" that shows how many postings were found and a few samples.
- **Settings** (the button at the top of the popup): shows the server the browser is connected to, the name
  of its key and how long the key works, with **Check connection**, **Reconnect** (opens the options page to
  connect again, with the saved key or a new one) and **Reset** (forgets the whole setup).

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
To connect again later (a new key, another address), open **Settings** in the popup and press **Reconnect**,
or open the options page: **Connect** with the key field left empty tries the saved key again.
**Reset** (in the popup's Settings or on the options page; it asks first) removes the server address, the key
and the chosen workspace from the browser and withdraws the permission. The key itself keeps working until you
disconnect the extension in JobHuntPA (Settings, Browser extension); do that too if the device is lost.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page in the current tab, only when you open the popup. |
| `scripting` | Run the small function that reads the job out of the page in the current tab (its address, title, structured job data, the job description's text and your text selection; on a page of search results, what each job card shows). |
| `storage` | Keep the server address, key and chosen workspace in `storage.local` (never synced). |
| optional hosts `http://*/*`, `https://*/*` | Requested at runtime for **your server's address only**, when you press Connect. Nothing else is ever requested. |

There is no `<all_urls>` host permission, no content script on every page, no remote code, no analytics.

## Privacy

The page is read on your own computer. What is sent to the JobHuntPA server you configured is the job the
extension found: the page address, the job's title, company, location, salary, work mode and posting date, the
job description as plain text, and, if you selected text on the page, that selected text instead of the
description. From a page of search results, what is sent is the page address and, for each job you ticked, its
own address and what its card shows (title, company, location, salary, work type, classification, the date it was
listed and the short summary); whether the site marks a job as new to you, viewed or applied stays in the popup.
The page's HTML, its scripts and data, and the rest of the page's text are never sent. Sending
happens only when you open the popup on a page and use it (to check whether the job is already saved, and
when you press Save or Add). On a page of search results nothing about the page is sent until you press Add. Requests carry the extension key as a bearer token; no cookies are sent. The
extension talks to no other server and collects no data. The key is stored locally in `storage.local` and never logged.

## Develop and test

No build step, no dependencies. The code is plain ES modules; `lib/api.js` implements the HTTP API, `lib/capture.js`
the page capture (what is read out of the page, and the job cards of a page of search results), `lib/extract.js` the turning of that into the job or the list of jobs that is sent, `popup/` and `options/` the UI. Unit tests: `node --test tests/extract.test.mjs`. End-to-end tests with a mock server (and how to run them
against a real server) are in `tests/README.md`. The Firefox repository has the same source except
`manifest.json`.
