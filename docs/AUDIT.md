# Audit, 29 October 2026

This pass reviewed OmaMap at `486404e` on `main`. It is a source review of the desktop viewer: the web core, the Qt host, the Omarchy bar widget, packaging, and the development dependencies. It is not a penetration test. [SECURITY.md](../SECURITY.md) is the threat model. [SECURITY-REVIEW.md](SECURITY-REVIEW.md) is the review from 3 October 2026. The fixes below are separate pull requests, so this note can land if a fix is rejected.

## What I checked

There is no account or server session. The trust boundary is the user account, files and profiles the user opens, other local users, and the basemap tile servers. Data files are parsed in `core/parse.js` (a worker for most formats, the page for KML and GPX) and drawn by `core/app.js`. The host in `host/` serves that page on `omamap://app`, filters network requests, and accepts same-user file opens over a Unix socket.

I read the import, profile, table, style, spatial-index, and point-drawing paths, and the host scheme, request filter, download, IPC, recent-file, profile-save, theme, and core-directory checks. I read `omarchy-plugin/BarWidget.qml`, the Arch package recipe, the CI workflows, and `scripts/check-vendor-advisories.py`. I did not read every line of the vendored Leaflet, shpjs, fflate, Papa Parse, or togeojson builds. I read where OmaMap calls them and spot-checked loops in the bundled proj4 code.

First-party display code puts file values in text nodes or attributes. The fixed basemap attribution strings in `core/basemaps.js` are the HTML Leaflet inserts. A pattern search of the current text sources found no private-key block and no common GitHub, Slack, AWS, Stripe, or Google token marker. I did not repeat the October history scan of every blob, and a pattern search can miss an unfamiliar secret format.

`npm audit --json` on the lockfile reported zero vulnerabilities across 80 development dependencies. `python3 scripts/check-vendor-advisories.py` exited 0 on 29 October 2026. GitHub reported zero advisories for Leaflet 1.9.4, shpjs 6.2.0, fflate 0.8.3, Papa Parse 5.4.1, and `@tmcw/togeojson` 5.1.2, and zero package-wide advisories for embedded `proj4`, `parsedbf`, `but-unzip`, `mgrs`, and `wkt-parser`. That is a snapshot of published advisories. shpjs still does not record exact versions for those embedded libraries.

## Fixes opened

- [Cap opened-file reads at the import limit](https://github.com/thebytorsnowdog/omamap/pull/18). The page checked the size recorded when a path was queued. The host then streamed the file until EOF and did not set `Content-Length`. A file replaced or extended before the read could be larger than the import limit. The scheme handler now refuses files over the same 100 MiB and 50 MiB limits, and stops at the size observed when the response starts.
- [Yield spatial index construction during import](https://github.com/thebytorsnowdog/omamap/pull/19). `prepareDataset` yielded while building layers, then built the click index in one step, so Cancel could not stop that step. The index now yields every 512 features and every 8,192 positions. On this machine, one sample of 50,000 polygons with about four million positions took 738 ms before the change. That is one local sample, not a benchmark suite.
- [Copy retained ZIP entries once](https://github.com/thebytorsnowdog/omamap/pull/20). Inflation kept a slice of every chunk and then copied those slices into a second buffer. Retained entries are now copied once. A declared size past the expansion budget or the ratio cap is rejected before that buffer is allocated.
- [Speed up the CSV whitespace preflight](https://github.com/thebytorsnowdog/omamap/pull/21). The preflight called `/\s/.test` on every character. On this machine, an 8.3 million character sample took 137 ms that way and 26 ms with a character-code check for the same set of code points. Those two times are one local sample.

## Left alone

I did not restyle the interface, rename modules, or change vendored files. The vendored hashes match published releases, and the advisory check found nothing to upgrade. I did not add an iteration cap to `bngToWgs84`: a grid of 411 in-range easting and northing values, including the corners, all returned, and I have no input that fails to converge. I did not change `crossOrigin: true` on tile layers. That flag makes the image request send an `Origin` header. I could not run the Qt window here, so I did not check whether the tiles still load without it. The request filter already clears `Referer` and sets the User-Agent. I did not confirm whether Chromium still adds `Sec-CH-UA` client hints after that interceptor.

Numeric range classification still sorts its values in one step inside `buildRanges` in `core/style.js`. The table sort already yields. KML and GPX still call `DOMParser.parseFromString` in one step. Replacing that is a new parser, not a small patch. The 512 MiB workspace figure is still an estimate, not a process limit. Lowering it would change which files open.

## Remaining risks

- KML and GPX can still pause the window inside `DOMParser.parseFromString`. Counting placemarks and rejecting `DOCTYPE` and `ENTITY` run first. They do not cap the time or the DOM allocations of that call. Cancel cannot interrupt it.
- The workspace budget does not cap Chromium, GPU memory, or temporary copies inside shpjs and the page. A renderer crash still drops unsaved work.
- `bngToWgs84` has two loops with no iteration limit. I did not find an in-range input that fails to finish.
- Bundled proj4, in `core/vendor/shp.js`, has an unbounded Mollweide loop (`while (true)` in the forward path). I did not build a `.prj` that hits it. Cancel can terminate the worker. A hang there is still inside the worker, not a shell command.
- A swapped file can still change which bytes are served, up to the size captured when the response starts, if [pull request 18](https://github.com/thebytorsnowdog/omamap/pull/18) lands. Without that change, the host streams until EOF.
- Tile servers still see the viewed area, the client IP address, and the User-Agent. I am not sure whether client hints add a browser version on top of that.
- Qt WebEngine and its Chromium build come from the operating system. I did not compare that build with upstream advisories. Keep the system packages updated.
- `npm run serve` does not send the CSP header. `frame-ancestors` in the page meta tag is ignored by browsers. The Qt host sends the header. The development server is not the installed app.
- Clipboard writing stays enabled so Copy works. Clipboard reading is denied.

## What I ran

On the branches above, as relevant:

- `node --test tests/hosts.test.cjs`
- `node --test tests/spatial.test.cjs`
- `node --test tests/parse.test.cjs` (59 tests passed on the ZIP branch)
- `node --test --test-name-pattern CSV tests/parse.test.cjs` (14 tests passed on the CSV branch)
- `npx eslint` on the JavaScript files those branches changed
- `npm audit --json`
- `python3 scripts/check-vendor-advisories.py`

I did not run `npm run test:browser`, `ctest`, or `tests/host-smoke.sh`. This environment has a C++ compiler and no Qt packages, so the host was not compiled. I did not run `tests/bench.cjs` or `tests/perf.cjs`.
