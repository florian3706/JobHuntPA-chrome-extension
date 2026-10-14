# Privacy statement: the JobHuntPA browser extension

For the JobHuntPA extension for Chrome and for Firefox, version 1.3.0.

## In short

- The extension works only with **your own JobHuntPA**, the job-search app you run yourself. It sends what it reads
  **only to the JobHuntPA server address you entered**, and to nothing else.
- The developer runs no server and receives nothing: no account, no analytics, no telemetry, no crash reports, no
  ads, no third parties.
- It reads only the tab you open its popup on, in your own browser, and sends only when you open the popup or the
  options page or press one of their buttons. Opening the popup on a web page, whether or not it is a job ad (any page
  except a page of search results the extension recognises, which so far means SEEK's, that shows no job of its own,
  where what it read is sent only once you open the **Add job** tab; when a results page also shows one, such as a job
  open beside the list in SEEK's split view or a job in the page's job data, that job is sent at once as on any other
  page), sends what the extension read there to your JobHuntPA server at once, before you edit anything, to check
  whether the job is already saved: the page's address, the job's title and details, and a description that may be the
  visible text of the page's main part or of the whole page. Nothing is saved by that; **Save job** sends the job with
  your edits. It never sends the page's HTML, scripts or styles, cookies, or the values of the page's form fields (what
  you type into inputs, text areas and lists).
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
  `description`, `og:description`), its first visible main heading;
- the job data the page itself publishes for search engines (JSON-LD `JobPosting`), when it has any;
- on job sites the extension knows (SEEK, LinkedIn, Indeed, Greenhouse, Lever, Workday, SmartRecruiters, Ashby,
  Workable), the elements those sites use for the job's details;
- the job description's text: the page's own description element, or else the visible text of the page's main part,
  or else of the whole page; or the text you selected, which then replaces it;
- on a SEEK page of search results, what each job card shows;
- when JobHuntPA has a layout saved for the site, the values that layout points to;
- when you ask for it, the trimmed outline of the page (below).

From these the extension makes the job, in the popup; the meta values and the heading themselves are not sent. Opening
the popup sends the job as read (see *Opening the popup sends what it read*, below); you see it in a form, and nothing
is saved before you press **Save job**.

## What is sent, and when

Every request goes to your JobHuntPA server, carries your extension key (as `Authorization: Bearer ...`) and the
chosen workspace, and carries no cookies.

| When | What is sent |
| --- | --- |
| You open the popup or the options page, or press **Connect**, **Check connection** or **Read page again** | A status check (is the key still valid, which workspaces are there). |
| You open the popup on a web page (any page except a page of search results the extension recognises, which so far means SEEK's, that shows no job of its own, where what it read is sent only once you open the **Add job** tab; when a results page also shows one, such as a job open beside the list in SEEK's split view or a job in the page's job data, that job is sent at once as on any other page), whether or not it is a job ad | What the extension read there, as a job, to check whether JobHuntPA already has it: see *Opening the popup sends what it read*, below the table. Nothing is saved by this. |
| You open the **Add job** tab on a page of search results that shows no job of its own | What the extension read there, as a job, as when you open the popup on any other page: see *Opening the popup sends what it read*, below the table. Nothing is saved by this. |
| You open the popup, or press **Read page again**, on a page where the extension's own reading finds no job title or no job description (on any site, known or not, but not on a page of search results) | The site's name, such as `jobs.example.org`, to look up whether a layout is saved for it. |
| You press **Save job** | The same job, with your edits from the form. |
| You press **Add jobs** on a page of search results | The page's address and, for each job you ticked, its own address and what its card shows (title, company, location, salary, work type, work arrangement (on-site, hybrid, remote), classification, the date it was listed, the short summary and its bullet points). Which jobs the site marks as new to you, viewed or applied stays in the popup. On a results page that shows no job of its own, nothing about the page is sent until you press **Add jobs** or open the **Add job** tab, which sends what the extension read there as on any other page; when it also shows one, that job is sent as soon as the popup opens (see the rows above). |
| You press **Work out this site**, or **Add source** for the careers page you have open | The page's address and its **trimmed outline** (below). |
| You press **Use this layout** | The layout, for the page's site: CSS selectors and attribute names only, nothing of the page. |
| You press **Add source** or **Add as a source** | The address, the label you typed and, when JobHuntPA worked one out, the layout it found for that page. |
| You press **Test** | Which of your sources to test. |

**Opening the popup sends what it read.** When you open the popup on a web page, whether or not it is a job ad (any page
except a page of search results the extension recognises, which so far means SEEK's, that shows no job of its own, where
what it read is sent only once you open the **Add job** tab; when a results page also shows one, such as a job open
beside the list in SEEK's split view or a job in the page's job data, that job is sent at once as on any other page),
the extension sends what it read there to your JobHuntPA server at once, before you edit anything, to check whether the
job is already saved; nothing is saved by that. It sends the page's address and canonical address and the job as read:
title, company, location, salary, employment type, work mode, date posted, the job's own address from the page's job
data, where the title and description came from, and the description as plain text (at most 100,000 characters). The
description is the text you selected on the page, if any; otherwise the page's own job description (its job data, the
description element of a site the extension knows, or what a layout saved in JobHuntPA for the site points to);
otherwise the visible text of the page's main part, or of the whole page, which includes any text typed into an editable
part of the page (such as a rich-text box). The form shows you which. The same is sent again when you press **Read page
again** or pick another workspace. On a page of search results that shows no job of its own, it is sent only once you
open the **Add job** tab, and after that again when you press **Read page again** on that tab or pick another workspace.
**Save job** sends the job with your edits.

**The trimmed outline** is built in your browser from the page you have open: for each part of the page that is not
marked hidden, its element name (such as `div` or `h1`), a few of its attributes (`id`, `class`, `role`, `itemprop`,
`itemtype`, `itemscope`, `aria-label`, `href` without its query or fragment, `datetime`, `title` and the test names
`data-testid`, `data-test`, `data-qa`, `data-automation`, `data-cy`; each at most 200 characters) and a sample of its
own text (at most 100 characters), plus the page's title. It is capped at 2,000 parts, 60 levels and 200,000 bytes. It
never holds the page's HTML, scripts, styles, frames, comments, anything of the page's head, anything marked hidden (the
`hidden` attribute, `aria-hidden` or `display: none`), the insides of an SVG, or any text of form fields or editable
areas (input fields, text areas, lists to pick from).

**Never sent:** the page's HTML, its scripts, styles and script data, cookies or anything else the site stores in your
browser, the values of the page's form fields (what you type into inputs, text areas and lists), other tabs, your
browsing history, or anything at all while the popup is closed. The rest of a page's visible text, including text typed
into an editable part of the page, is sent only as the job description, when the page has no job description the
extension recognises (see *Opening the popup sends what it read*); selecting the ad's text before you open the popup, or
before **Read page again**, sends only that.

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

Use `http://127.0.0.1:8000` when JobHuntPA runs on the same computer as the browser. JobHuntPA listens only on its own
computer; other devices reach it through the `https://` address that Tailscale's `serve` or a reverse proxy on that
computer gives it, so what the extension sends is encrypted on the way. The key only lets the extension add jobs and
sources, list your workspaces and sources, test a source, have pages worked out, look up, list, save and forget site
layouts, and see whether a job is already saved (with its title and status); it can't read your jobs, documents or
settings.
To report a security problem, see *Reporting a security problem* in the extension's README.

## Changes

This statement describes the version above. If a later version sends anything else, this statement and the store
listing change with it, and the browser asks you for any new permission.
