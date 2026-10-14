# Other people's code

The JobHuntPA extension is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`); the
full text is in [`LICENSE`](LICENSE).

## What the extension ships

**No third-party code.** Everything in the extension (`manifest.json`, `background.js`, `lib/`, `popup/`,
`options/`, `css/`, `icons/`) was written for this project. It has no runtime dependencies, no bundled
libraries, no web fonts, and it loads nothing from the network: no remote scripts or stylesheets, no CDN.

The icons (`icons/icon-16.png` to `icons/icon-128.png`, a briefcase on a blue tile) are the project's own. They are
drawn pixel by pixel by [`scripts/make_icons.py`](scripts/make_icons.py), which is part of this repository and uses no
image, font or icon set made by anyone else.

## Tools used only to develop and test it

None of these are part of the extension or of the zip `scripts/package.sh` builds. You install them only if you
want to run the tests or the linter yourself.

| Tool | Used for | Licence |
| --- | --- | --- |
| [Playwright](https://playwright.dev) (`playwright`, `playwright-core`; version 1.64.0 when this was written) | The end-to-end tests (`tests/e2e.cjs`): drives Chromium with the unpacked extension loaded. Installed with `npm install playwright` in `tests/` (see [`tests/README.md`](tests/README.md)); not committed. | Apache-2.0 |
| Chromium or Chrome for Testing | The browser the end-to-end tests run in (your own build, or the one Playwright downloads). | BSD-3-Clause for Chromium's own code, plus the licences of its parts (see `chrome://credits` in that browser) |
| [web-ext](https://github.com/mozilla/web-ext) (version 8.10.0 when this was written) | Linting the Firefox build of the extension (`npx web-ext lint`). Not committed. | MPL-2.0 |
| Node.js | Running the unit tests (`node --test`) and the end-to-end tests. | MIT, plus the licences of its parts |
| Python 3 | `scripts/make_icons.py` (draws the icons) and `scripts/package.sh` (reads the version; builds the zip when `zip` isn't installed). Standard library only. | PSF-2.0 |

The licences above are taken from each package's own metadata (`license` in its `package.json`) or its project's
licence file.

## Test pages

The pages in `tests/pages/` are made up for the tests (made-up jobs, companies and people); they copy the *shape* of
some job sites' pages (such as SEEK's element names) but none of their content.
