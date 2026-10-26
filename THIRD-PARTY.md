# Other people's code

The JobHuntPA extension is licensed under the GNU General Public License, version 3 only (`GPL-3.0-only`); the
full text is in [`LICENSE`](LICENSE).

## What the extension ships

**No third-party code.** Everything in the extension (`manifest.json`, `background.js`, `lib/`, `popup/`,
`options/`, `css/`, `icons/`) was written for this project or copied from JobHuntPA itself (`css/themes.css`, the
app's themes). It has no runtime dependencies, no bundled libraries, and it loads nothing from the network: no remote
scripts, stylesheets or fonts, no CDN. The one thing it ships that isn't code is two font files (below).

## Fonts shipped with the extension

| What | Licence | Where it comes in |
| --- | --- | --- |
| [Ubuntu Sans](https://design.ubuntu.com/font) (variable, `UbuntuSans[wdth,wght].woff2`) and Ubuntu Sans Mono (`UbuntuSansMono[wght].woff2`) | [Ubuntu Font Licence 1.0](https://ubuntu.com/legal/font-licence) | `fonts/`, the same unmodified files JobHuntPA ships in its `frontend/fonts/` (Canonical's own variable WOFF2 builds), loaded by `css/themes.css` for every theme but the Dyslexia ones, since 1.4.0; the licence text is beside them as `fonts/UFL-1.0.txt` |

The Ubuntu Font Licence is not a GPL-compatible software licence, and that is fine here for the reason JobHuntPA's own
`THIRD-PARTY.md` gives: a font file is data the pages display, not code combined with the extension's; it ships
unmodified, under its own name, with its licence beside it, which is all the licence asks.

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
