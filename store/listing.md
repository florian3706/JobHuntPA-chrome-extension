# Chrome Web Store listing (draft)

The draft for the Chrome Web Store; the Firefox add-on's listing (AMO) is in the Firefox repository (see *Firefox*
below). Publishing is the maintainer's step; copy the parts below into the store's form. The privacy statement is in
[`privacy.md`](privacy.md): host it (for example as this file on GitHub) and give its address as the privacy policy
link.

Everything here describes version 1.4.0. Check it again when the permissions or what the extension sends change.

## Name

JobHuntPA

## Short description

At most 132 characters (this is also the manifest's `description`):

> Add the page you are viewing to your own JobHuntPA server: a job, a page of search results, or a company source.

## Category

*Productivity* (or *Tools*).

## Long description

> **JobHuntPA for your browser** is the companion extension of [JobHuntPA](https://github.com/florian3706/JobHuntPA),
> a free, open-source job-search app that you run yourself, on your own computer or your own network. The extension
> only works with your own JobHuntPA: it has no account, no server and no service of its own.
>
> From the page you have open you can:
>
> - **Add a job.** The extension reads the job ad in your own browser (title, company, location, salary, employment
>   type, work mode, the date and the description) and fills in a form. You check or correct it and save it to your
>   JobHuntPA. Because the page is read where you are already signed in, ads behind a sign-in work too. If the job is
>   already saved, the popup says so and lets you update it.
> - **Add the jobs on a page of search results** (SEEK for now). The popup lists the jobs on the page with tick boxes
>   and adds the ones you tick, each from what its card shows. You turn the pages yourself: the extension never
>   clicks, scrolls or opens anything on a job site.
> - **Have a job site worked out.** On a job site the extension doesn't know, your JobHuntPA can ask the AI provider
>   you set up in it which parts of the page hold the job's details. The popup shows you the job that layout finds,
>   field by field, and saves the layout only when you press *Use this layout*. The AI work happens in your
>   JobHuntPA; the extension holds no AI key and talks to no AI service.
> - **Add a careers page as a source** that JobHuntPA's searches read. JobHuntPA first reads the page itself and shows
>   you the jobs it finds there before anything is saved.
>
> The popup looks like your JobHuntPA: it paints the theme you chose in the app, light or dark.
>
> **Your data stays yours.** The extension sends what it reads only to the JobHuntPA server address you enter, and only
> when you open its popup or options page or press one of their buttons or pick another workspace in the popup. Opening
> the popup on a web page, whether or not it is a job ad (any page except a page of search results the extension
> recognises, which so far means SEEK's, that shows no job of its own, where what it read is sent only once you open the
> **Add job** tab; when a results page also shows one, such as a job open beside the list in SEEK's split view or a job
> in the page's job data, that job is sent at once as on any other page), sends what the extension read there to your
> JobHuntPA server at once, before you edit anything, to check whether the job is already saved: the page's address, the
> job's title and details, and a description that may be the visible text of the page's main part or of the whole page.
> Nothing is saved by that; **Save job** sends the job with your edits. It never sends the page's HTML, scripts, styles
> or the values of the page's form fields (what you type into inputs, text areas and lists). There are no analytics, no
> ads, no tracking and no third parties. The full privacy statement is at <privacy statement link>.
>
> **You need JobHuntPA** (free, open source, for Windows, macOS and Linux): install it, then in JobHuntPA open
> Settings, Browser extension, Connect a browser extension, and paste the server address and key it shows into the
> extension's options page.
>
> Open source under the GNU General Public License, version 3 (GPL-3.0-only). Source code:
> https://github.com/florian3706/JobHuntPA-chrome-extension (Chrome) and
> https://github.com/florian3706/JobHuntPA-firefox-extension (Firefox).

## Single purpose (Chrome Web Store)

> Saves job ads, pages of job search results and company careers pages from the open tab to the user's own,
> self-hosted JobHuntPA server.

## Permissions, and why each is needed

The manifest asks for `activeTab`, `scripting` and `storage`, and for the optional host permissions `http://*/*` and
`https://*/*`. There is no `<all_urls>` or other host permission granted at install, no content script on every page,
no background work on pages and no remote code. 1.3.0 and 1.4.0 ask for nothing that 1.2.0 didn't.

| Permission | What it is used for |
| --- | --- |
| `activeTab` | Gives the extension the page in the current tab, only when you open the popup on it. Used to read the job (or a results page's job cards) from that page, to build the page's trimmed outline when you ask JobHuntPA to work the page out, and to read the job with a site's saved layout. No other tab is ever read. |
| `scripting` | Runs three small functions of the extension in that tab (`scripting.executeScript`): `readPage` (the page's address, title, a few meta values, structured job data, the job description's text, your text selection; on a results page, what each job card shows), `readOutline` (the trimmed outline, built with DOM functions; no HTML is read out) and `readMapped` (a saved layout applied with `querySelector`, `getAttribute` and `textContent`/`innerText` only). Nothing is ever injected into a page you didn't open the popup on, and nothing changes the page. |
| `storage` | Keeps the setup in `storage.local` on this device (never synced): your JobHuntPA server's address, the extension key, the chosen workspace, the list of your workspaces' names, and the key's name and expiry date. Site layouts are not kept in the browser: they live in JobHuntPA. |
| Optional host permissions `http://*/*`, `https://*/*` | Lets the extension call your JobHuntPA server's API. The extension asks the browser for the **one origin you enter** (for example `http://127.0.0.1:8000/*`) when you press *Connect*; the browser shows the question and you allow it or not. Nothing else is ever requested. Since the address is yours (`http://127.0.0.1:8000` on the same computer, or the `https://` address that Tailscale's `serve` or a reverse proxy on JobHuntPA's computer gives it for your other devices), it can't be listed in the manifest in advance. *Reset*, or connecting to another address, withdraws the permission again. |

### Chrome Web Store form: permission justifications

- **activeTab:** Reads the job ad in the current tab when the user opens the popup, so the user can save it to their
  own JobHuntPA server.
- **scripting:** Runs the extension's own read-only functions in the current tab (after the user opened the popup)
  to read the job ad, the job cards of a results page, or a trimmed outline of the page.
- **storage:** Stores the setup locally (`storage.local`, never synced): the user's JobHuntPA server address, the
  extension key, the chosen workspace, the user's workspaces' names, and the key's name and expiry date.
- **Host permission (optional):** Requested at runtime only for the address of the user's own JobHuntPA server, to
  call its API. The address differs for every user, so it can't be listed in the manifest.
- **Remote code:** No. All code is in the package; nothing is downloaded or evaluated.

### Chrome Web Store form: data usage

What the extension sends goes only to the user's own JobHuntPA server (see [`privacy.md`](privacy.md)); the developer
receives nothing. Tick:

- **Website content**: the job read from a page you open the popup on, sent as soon as the popup opens (on a page of
  search results that shows no job of its own, when you open the Add job tab, and again when you open that tab after
  Read page again, which goes back to the list of jobs; its description may be the visible text of the page's main part
  or whole page), the job cards of a results page, the text you selected, the trimmed outline of a page you ask
  JobHuntPA to work out.
- **Web history**: the addresses (and a site's name) of the pages you open the popup on, add or have worked out.
- **Authentication information**: the extension key you paste, sent only to the server that issued it, as the
  credential for its API.

Leave the others unticked (personally identifiable, health, financial, personal communications, location, user
activity). Certify all three: the data is not sold to third parties; it is not used or transferred for purposes
unrelated to the item's single purpose; it is not used to determine creditworthiness or for lending.

## Firefox

The Firefox add-on has the same code and the same privacy statement. Its AMO listing is `store/listing.md` in the
Firefox repository (<https://github.com/florian3706/JobHuntPA-firefox-extension>). Its manifest already declares the
data it sends, as AMO requires: `"data_collection_permissions": { "required": ["websiteContent", "browsingActivity",
"authenticationInfo"] }`, the same three kinds as the data-usage answers above (website content, web history,
authentication information).

## Screenshots

`tests/e2e.cjs` writes the popup's screens to `tests/out/` (the job form, a results page, the layout review, the
careers page check, the options page). They show made-up test pages and a test server, so they can be used as store
screenshots as they are. Chrome wants 1280x800 or 640x400; place the popup on a plain background at that size.

## Support and security links

- Support / homepage: https://github.com/florian3706/JobHuntPA
- Security problems: see *Reporting a security problem* in the [README](../README.md).
