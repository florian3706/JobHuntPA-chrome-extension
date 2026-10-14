# JobHuntPA for Chrome

The browser extension for [JobHuntPA](https://github.com/florian3706/JobHuntPA), the free, open-source job-search
app you run yourself. It adds the page you are looking at to **your own** JobHuntPA: a job ad, the jobs of a page of
search results, or a company's careers page. It has no account, server or service of its own; it talks only to the
JobHuntPA server you connect it to.

Free software under the GNU General Public License, version 3 only (`GPL-3.0-only`): see [Licence](#licence).

## What it does

- **Add job**: the extension reads the posting in the page you are looking at (title, company, location,
  salary, work mode, description), right in your browser, and fills in the form; you check or edit the fields
  and save, and only the finished job is sent to your JobHuntPA server. If the job is already there, the popup
  says so and lets you update it. Because the page is read in your own browser, postings behind a sign-in work too.
  Select the ad's text first to use only that as the description.
- **Jobs on this page**: on a SEEK search results page (any view or page of it, such as *New to you* or sorted
  by date) the popup lists the jobs on the page with tick boxes and adds the ticked ones in one go, each from the
  summary on its card. Jobs SEEK marks as new to you are ticked to start with. Jobs JobHuntPA already has are left
  as they are, so going over a page twice does no harm. You turn the pages yourself: the extension reads only
  the page you have open, and never clicks, scrolls or opens anything on the site.
- **Work out a job site** (since 1.3.0): on a job site the extension doesn't know, where it finds no job title and
  description of its own, the popup offers to **work the site out**. Your JobHuntPA asks the AI provider you set up in
  it which parts of the page hold the title, company, location, salary, employment type, work mode, date and
  description, and the popup shows you the job that layout finds on the page, field by field. Only when you press
  **Use this layout** is it saved (in JobHuntPA, for that site), and from then on the popup reads that site's job pages
  with it by itself. When a site changes and the saved layout no longer finds a title, the popup offers to work it out
  again. You can forget a site's layout in JobHuntPA (Settings, Browser extension, *Job sites the AI worked out*).
- **Add source**: add a careers page or job board as a company source that JobHuntPA's searches crawl, with
  an optional label. For the page you have open, JobHuntPA first reads the page **itself** and shows you the jobs it
  found there (a few titles and places); when its usual ways find none, its AI works out where the page lists them
  and JobHuntPA reads the page again with that layout. Nothing is saved until you press **Add as a source** (the
  layout, when one was needed, is saved with the source). Another address is added as before. **Test** shows how many
  postings a source has and a few samples.
- **Settings** (the button at the top of the popup): shows the server the browser is connected to, the name
  of its key and how long the key works, with **Check connection**, **Reconnect** (opens the options page to
  connect again, with the saved key or a new one) and **Reset** (forgets the whole setup).

**The AI work is done by your JobHuntPA, never by the extension.** The extension holds no AI key and never talks to an
AI provider: it sends the page's outline to your own JobHuntPA server, which asks the AI it is set up with and checks
the answer. A layout (a *mapping*) is data, never code: CSS selectors and attribute names, checked by JobHuntPA and
by the extension, and applied by the extension only with the browser's own selector functions (`querySelector`,
`getAttribute`, `textContent`/`innerText`), each value cut to the length JobHuntPA takes. Nothing of a mapping or of
the page is ever run, inserted as HTML or used as an address. The extension never clicks, scrolls, turns pages or
fetches anything on a job site by itself.

## What you need

- **JobHuntPA**, installed and running on your computer or your network (Windows, macOS or Linux; see
  [its README](https://github.com/florian3706/JobHuntPA)). Working pages out needs a JobHuntPA whose extension
  contract is `"api": 3` (with an older one the popup simply doesn't offer it) and an AI provider set up in its
  Settings.
- **Chrome 111 or newer**, or another Chromium browser (Edge, Brave, ...). Manifest V3.

The Firefox version, with the same code, is
[JobHuntPA-firefox-extension](https://github.com/florian3706/JobHuntPA-firefox-extension). This is version 1.3.0.

## Install

**From the Chrome Web Store:** *coming soon* (link: `<Chrome Web Store link, once published>`).

**From source (unpacked)**, until then:

1. Download this repository (on GitHub: **Code**, **Download ZIP**, then unzip it) or clone it. Keep the folder: Chrome
   loads the extension from it.
2. Open `chrome://extensions`, switch on **Developer mode** (top right), press **Load unpacked** and choose the folder
   (the one with `manifest.json` in it).
3. The extension's options page opens. Pin the extension (the puzzle icon in the toolbar) to keep its button in view.

To update an unpacked install, replace the folder's files with the new version and press the reload arrow on the
extension's card in `chrome://extensions`.

## Connect to JobHuntPA

1. In JobHuntPA open **Settings**, then **Browser extension**, then **Connect a browser extension**
   (needs a password entry from the last 15 minutes). Give it a name such as "Chrome on laptop".
2. Copy the **server address** and the **extension key** (shown once). Keep the key secret: it opens your JobHuntPA
   for adding jobs and sources.
3. In the extension's options page paste both and press **Connect**. Chrome asks whether the extension may
   access your server; allow it. Pick a workspace if you have several.

The address can be `http://127.0.0.1:8000`, `http://raspberrypi.local:8000`, a LAN IP or an https name such
as a Tailscale one. Without a scheme, `https://` is assumed except for localhost, IP addresses and local names. Use
`https://` whenever JobHuntPA is reached over a network you don't control.

To connect again later (a new key, another address), open **Settings** in the popup and press **Reconnect**,
or open the options page: **Connect** with the key field left empty tries the saved key again.
**Reset** (in the popup's Settings or on the options page; it asks first) removes the server address, the key
and the chosen workspace from the browser and withdraws the permission. The key itself keeps working until you
disconnect the extension in JobHuntPA (Settings, Browser extension); do that too if the device is lost.

## What it sends

Everything goes **only to the JobHuntPA server you connected**, with the extension key as a bearer token and no
cookies. There are no analytics, no telemetry, no ads and no third parties; the extension talks to no other server.
The full statement, with every request, is [`store/privacy.md`](store/privacy.md). In short:

- **Opening the popup** checks the key. Opening it on a web page (any page except a page of search results it
  recognises, whether or not the page is a job ad) also sends what it read there to your JobHuntPA, to ask whether the
  job is already saved (nothing is saved by that): the page address, the job's title, company, location, salary,
  employment type, work mode and posting date, and the job description as plain text. The description is the page's own
  job description where the extension finds one (the page's job data, or the description element of a site it knows);
  otherwise it is the visible text of the page's main part, or of the whole page. The form shows you which. If you
  selected text on the page, that text is sent as the description instead. **Save job** sends the job with your edits.
- **On a page of search results** nothing about the page is sent until you press **Add jobs**; then it sends the
  page address and, for each job you ticked, its own address and what its card shows (title, company, location,
  salary, work type, classification, the date it was listed and the short summary). Whether the site marks a job as
  new to you, viewed or applied stays in the popup.
- **Working a page out.** When the page's own reading finds no job title and description, the popup asks your server
  whether a layout is saved for the page's site (the site's name, such as `jobs.example.org`, is all it sends for that).
  When you press **Work out this site**, or **Add source** on the careers page you have open, it sends the page's
  address and a **trimmed outline** of the page: for each part of the page that is shown, its element name (`div`, `h1`,
  ...), a few of its attributes (`id`, `class`, `role`, `itemprop`, `itemtype`, `itemscope`, `aria-label`, `href`
  without its query or fragment, `datetime`, `title` and the `data-testid` / `data-test` / `data-qa` / `data-automation`
  / `data-cy` test names, each at most 200 characters) and a sample of its own text (at most 100 characters), plus the
  page's title; at most 2,000 parts, 60 levels and 200,000 bytes. It never holds the page's HTML, scripts, styles,
  frames, comments, anything of the page's head, anything marked hidden (the `hidden` attribute, `aria-hidden` or
  `display: none`), the insides of an SVG, or the text of form fields and editable areas. **Use this layout** sends the
  layout (selectors and attribute names only). Your JobHuntPA sends the outline to the AI provider you set up in it and
  drops it with the request; it is never stored or logged.
- **Add source** sends the address, your label and, when JobHuntPA worked one out, its layout for the page.

**Never sent:** the page's HTML, its scripts, styles and script data, its cookies, what you type into its forms,
other tabs, your browsing history, or anything while the popup is closed.

**Kept in the browser** (`storage.local`, never synced): the server address, the key, the chosen workspace, your
workspaces' names, and the key's name and expiry date. Nothing about the pages you visit is kept.

## Permissions

| Permission | Why |
| --- | --- |
| `activeTab` | Read the page in the current tab, only when you open the popup. |
| `scripting` | Run the small functions that read the job out of the page in the current tab (its address, title, structured job data, the job description's text and your text selection; on a page of search results, what each job card shows), build the page's outline when you ask JobHuntPA to work a page out, and read the job with a site's saved layout. |
| `storage` | Keep the server address, key and chosen workspace in `storage.local` (never synced). |
| optional hosts `http://*/*`, `https://*/*` | Requested at runtime for **your server's address only**, when you press Connect. Nothing else is ever requested. |

There is no `<all_urls>` host permission, no content script on every page, no remote code, no analytics. Version 1.3.0
asks for no new permission: the outline and the saved layouts use the same `activeTab` and `scripting` as reading a
job. The reasons for each permission, as given to the Chrome Web Store, are in [`store/listing.md`](store/listing.md).

## Reporting a security problem

Please report a security problem privately, not in a public issue: use GitHub's **private vulnerability reporting**
on this repository (the **Security** tab, then **Report a vulnerability**), or email
**SECURITY-CONTACT@REPLACE-ME.invalid**. Say what you found, how to reproduce it, and the versions of the extension,
Chrome and JobHuntPA. You should get an answer within two weeks. There is no bug bounty. Other bugs and questions:
[the issue tracker](https://github.com/florian3706/JobHuntPA-chrome-extension/issues).

## Licence

Copyright the JobHuntPA authors. The JobHuntPA extension is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free Software Foundation, **version 3 only**
(`GPL-3.0-only`). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [`LICENSE`](LICENSE) for the full text.

The extension ships no one else's code; the tools used to develop and test it are listed in
[`THIRD-PARTY.md`](THIRD-PARTY.md). "JobHuntPA" is the project's name; a modified version you distribute should say
that it is modified.

## Develop and test

No build step, no dependencies. The code is plain ES modules; `lib/api.js` implements the HTTP API, `lib/capture.js`
the page capture (what is read out of the page, the job cards of a page of search results, the page's outline and a
layout applied to the page), `lib/extract.js` the turning of that into the job or the list of jobs that is sent,
`lib/mapping.js` the outline's caps, the site of a page and the check of a layout before it is applied or saved,
`popup/` and `options/` the UI. The contract with JobHuntPA is Part 8 of `docs/design/open-source.md` in the app's
repository.

- Unit tests: `node --test tests/extract.test.mjs` (nothing to install).
- End-to-end tests with a mock server, and how to run them against a real server: [`tests/README.md`](tests/README.md).
- A zip for the Chrome Web Store: `scripts/package.sh` writes `dist/jobhuntpa-chrome-<version>.zip` (the extension's
  files, `LICENSE` and `THIRD-PARTY.md`; upload it in the Developer Dashboard and bump `version` in `manifest.json`
  for every upload). The listing drafts are in [`store/`](store/).

The Firefox repository has the same code, `LICENSE` and `store/privacy.md`; its `manifest.json`, README,
`.gitignore`, `THIRD-PARTY.md` and `store/listing.md` (the AMO listing) are its own, and the tests live only here.
