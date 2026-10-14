# Privacy statement: the JobHuntPA browser extension

For the JobHuntPA extension for Chrome and for Firefox, version 1.3.0.

## In short

- The extension works only with **your own JobHuntPA**, the job-search app you run yourself. It sends what it reads
  **only to the JobHuntPA server address you entered**, and to nothing else.
- The developer runs no server and receives nothing: no account, no analytics, no telemetry, no crash reports, no
  ads, no third parties.
- It reads only the tab you open its popup on, in your own browser, and sends only when you open the popup and use
  it. It never sends the page's HTML, scripts or styles, cookies, or anything you typed into the page's forms.
- It holds no AI key and never talks to an AI service. Working a page out is done by your JobHuntPA (below).

## Who handles your data

JobHuntPA is free, open-source software that you install and run yourself, on your own computer or your own network.
The extension is its companion: you connect it to your JobHuntPA by entering that server's address and an extension
key made in JobHuntPA (Settings, Browser extension). Everything the extension sends goes to that address. The
browser lets the extension reach that one address only: the extension asks for it when you press **Connect**, and
asks for nothing else.

## What is read, and where

The extension reads a page only when you open its popup on it, and only that tab. The reading happens inside your
browser, with the browser's own functions: nothing is downloaded, and the page isn't changed or clicked. It reads:

- the page's address, its canonical address, its title, a few of its meta values (`og:title`, `og:site_name`,
  `description`), its first visible main heading;
- the job data the page itself publishes for search engines (JSON-LD `JobPosting`), when it has any;
- on job sites the extension knows (SEEK, LinkedIn, Indeed, Greenhouse, Lever, Workday, SmartRecruiters, Ashby,
  Workable), the elements those sites use for the job's details;
- the job description's text: the page's own description element, or else the visible text of the page's main part,
  or else of the whole page; or the text you selected, which then replaces it;
- on a SEEK page of search results, what each job card shows;
- when JobHuntPA has a layout saved for the site, the values that layout points to;
- when you ask for it, the trimmed outline of the page (below).

Most of this stays in the popup: you see the job in a form before anything is saved.

## What is sent, and when

Every request goes to your JobHuntPA server, carries your extension key (as `Authorization: Bearer ...`) and the
chosen workspace, and carries no cookies.

| When | What is sent |
| --- | --- |
| You open the popup | A status check (is the key still valid, which workspaces are there). |
| You open the popup on a job ad | The job the extension read, to check whether JobHuntPA already has it: the page's address and canonical address, and the job's title, company, location, salary, employment type, work mode, date posted, its own address from the page's job data, the description as plain text (at most 100,000 characters), and where the description and title came from. Nothing is saved by this. |
| The page's own reading found no job title or description (a site the extension doesn't know) | The site's name, such as `jobs.example.org`, to look up whether a layout is saved for it. |
| You press **Save job** | The same job, with your edits from the form. |
| You press **Add jobs** on a page of search results | The page's address and, for each job you ticked, its own address and what its card shows (title, company, location, salary, work type, classification, the date it was listed, the short summary). Which jobs the site marks as new to you, viewed or applied stays in the popup. On a results page nothing is sent about the page before you press Add. |
| You press **Work out this site**, or **Add source** for the careers page you have open | The page's address and its **trimmed outline** (below). |
| You press **Use this layout** | The layout, for the page's site: CSS selectors and attribute names only, nothing of the page. |
| You press **Add source** or **Add as a source** | The address, the label you typed and, when JobHuntPA worked one out, the layout it found for that page. |
| You press **Test** | Which of your sources to test. |

**The trimmed outline** is built in your browser from the page you have open: for each part of the page that is shown,
its element name (such as `div` or `h1`), a few of its attributes (`id`, `class`, `role`, `itemprop`, `itemtype`,
`itemscope`, `aria-label`, `href` without its query or fragment, `datetime`, `title` and the test names
`data-testid`, `data-test`, `data-qa`, `data-automation`, `data-cy`; each at most 200 characters) and a sample of its
own text (at most 100 characters), plus the page's title. It is capped at 2,000 parts, 60 levels and 200,000 bytes.
It never holds the page's HTML, scripts, styles, frames, comments, anything of the page's head, anything hidden,
the insides of an SVG, or any text of form fields or editable areas (input fields, text areas, lists to pick from).

**Never sent:** the page's HTML, its scripts, styles and script data, cookies or anything else the site stores in your
browser, what you type into the page's forms, other tabs, your browsing history, or anything at all while the popup
is closed. The rest of a page's text is sent only as the job description, when the page has no description element
the extension recognises; the form shows you that description (and where it came from) before you save, and
selecting the ad's text first sends only that.

## What your JobHuntPA does with it

JobHuntPA keeps what you save (jobs, sources, the layouts you accepted) in its own database on the computer it runs
on. The preview, the site lookup and the outline are not stored. When you ask it to work a page out, JobHuntPA sends
the page's address and outline to the AI provider **you** set up in JobHuntPA, with your own key for that provider;
that provider's terms apply to that request. JobHuntPA drops the outline with the request and doesn't log it. For a
careers page, JobHuntPA then reads the page itself, through its own crawling rules, to show you the jobs it finds.
See JobHuntPA's README (<https://github.com/florian3706/JobHuntPA>) for how it protects what it keeps.

## What is stored in the browser

In the browser's local extension storage (`storage.local`, never synced to other devices): your JobHuntPA server's
address, the extension key, the chosen workspace, your workspaces' names, and the key's name and expiry date.
Nothing about the pages you visit is kept. **Reset** (in the popup's Settings or on the options page) removes all of
it and withdraws the permission for your server; removing the extension does the same. The key itself keeps working
until you disconnect the extension in JobHuntPA (Settings, Browser extension), so do that too if a device is lost.

## Security

Use an `https://` address when JobHuntPA is reached over a network you don't control (a Tailscale name, a reverse
proxy); `http://` is meant for the same computer or your home network. The key only lets the extension add jobs and
sources, list your workspaces and sources, and have pages worked out; it can't read your jobs, documents or settings.
To report a security problem, see *Reporting a security problem* in the extension's README.

## Changes

This statement describes the version above. If a later version sends anything else, this statement and the store
listing change with it, and the browser asks you for any new permission.
