# OmaMap architecture and development overview

## What it does

OmaMap is a desktop spatial-data viewer for Omarchy/Arch Linux. It opens GeoJSON, KML/KMZ, GPX, coordinate CSV/TSV/TXT and shapefiles; displays them over a selectable tile basemap; exposes feature attributes, spherical length/area measurements and thematic styling; and saves datasets, styles and map view as an `.omamap` profile. It is a viewer rather than a geometry editor, spatial database or general GIS analysis tool.

Spatial files are read locally. The app's routine remote requests are the selected basemap's image tiles, which disclose the viewed area to that provider. **None** disables basemap requests. Explicitly clicked HTTP(S) links open in the user's external browser. No account, API key, backend, database or telemetry service is required.

The application deliberately splits into a web mapping core and a small native host. The browser implementation supplies Leaflet-based rendering and most product logic, while the Qt 6 WebEngine host supplies desktop integration and a constrained origin (`omamap://app`). The repository is also an Omarchy bar-widget plugin which launches OmaMap and reads its recent-file list.

## Repository map

| Path | Responsibility |
|---|---|
| `core/index.html`, `core/styles.css` | Static application shell and presentation. The HTML also declares the page Content Security Policy. |
| `core/app.js` | Map lifecycle, dataset loading, selection, measurements, profile save/restore and keyboard/UI wiring. |
| `core/parse.js`, `core/parse-worker.js` | Format dispatch, input validation, resource budgets, archive inspection and off-main-thread parsing. KML/GPX conversion is time-sliced on the page because it requires `DOMParser`. |
| `core/style.js`, `core/table.js` | Thematic styling/legends and the virtualised attribute table. |
| `core/fastpoints.js`, `core/batchcanvas.js`, `core/spatial.js` | High-volume point rendering, tiny-vector batching and click-query spatial indexing. |
| `core/basemaps.js` | The authoritative UI basemap catalogue. Host and CSP allow-lists must remain in sync with it. |
| `core/vendor/` | Browser libraries committed at pinned hashes, with licence texts. |
| `host/` | C++17 Qt host: application scheme, request filtering, single-instance IPC, theme integration, profile downloads and recent-file persistence. |
| `omarchy-plugin/`, `manifest.json` | Omarchy bar widget and plugin metadata. |
| `packaging/` | Arch package, desktop/MIME integration, icon and vendored-dependency inventory. |
| `tests/` | Node unit/regression tests, Playwright browser flows, native C++ tests, performance probes and host smoke tests. |
| `.github/workflows/` | PR/push CI and the scheduled online vendored-library advisory check. |
| `scripts/check-vendor-advisories.py` | Compares vendor files with npm release archives and queries GitHub advisories; this is a separate online maintenance check. |

There is no JavaScript bundler or generated frontend. `index.html` loads ordinary scripts in a fixed order into a shared global scope: vendor libraries and renderer/parser helpers, then basemaps, style, table and app. `parse.js` also exports its API for the worker and Node tests. ESLint discovers shared top-level declarations so undefined-name checks remain useful across files. Changing script order or moving globals needs care.

## How data moves through the app

### Import and validation

1. A picker/drop supplies browser `File` objects. For command-line and file-manager opens, `Window::flush` registers readable files with `SchemeHandler` and passes names, sizes and one-use URLs to `OmaMap.openUrls`. The page fetches only those files through its own origin.
2. `handleFiles` queues import batches, groups loose shapefile parts by filename stem, and limits the batch to 100 files. `parseOne` checks size before reading bytes. Worker jobs transfer their buffers rather than copying them.
3. `parse.js` dispatches by format. GeoJSON is normalised; coordinate columns become CSV points; shapefiles use `shpjs` and optional `.prj`/`.cpg`; ZIPs are inspected and extracted in memory. ZIP members are never unpacked to disk. Stored/deflated entries, CRCs, sizes, names, header agreement, expansion ratio and aggregate budgets are checked.
4. Every resulting layer goes through `validateFeatureCollection`: geometry/coordinate checks, bounded JSON properties, complete field discovery and estimated size accounting. Accepted coordinates are WGS84 longitude/latitude. British National Grid CSV and explicitly declared EPSG:27700 GeoJSON use the built-in Helmert conversion; other shapefile projections use the bundled projection support.
5. `prepareDataset` checks the workspace budget and builds rendering objects in slices. `attachDataset` publishes a prepared dataset to the map and dataset list. A cancelled/failed dataset is not attached; datasets already added earlier in the same batch remain open.

KML/GPX require `DOMParser`, which the worker lacks. Direct XML files are converted on the page; archives return XML text from the worker for the same conversion path. A generator yields between conversion batches so input and Cancel can run, but DOM creation and final validation contain synchronous work. If workers cannot run, parser libraries are loaded on the page as a fallback; responsiveness then depends on input size.

The main limits live in `OmaParse.LIMITS`: 100 MiB per ordinary file or profile, 50 MiB compressed / 250 MiB expanded ZIP, 500,000 features and 5 million coordinates per dataset, and 1 million features / 10 million coordinates / 512 MiB estimated storage per workspace. The UI admits at most 50 datasets. These are admission budgets, not an operating-system memory cap; the [README](../README.md#formats) lists the additional attribute limits.

### Rendering, styling and selection

Each dataset keeps its validated GeoJSON, fields, ordered feature/layer arrays, style and spatial index. Plain `Point` features use `FastPoints`, including points inside mixed datasets. WebGL is requested for at least 1,000 points while fewer than eight app WebGL layers are live; otherwise a 2D canvas is used. A lost GPU context falls back to 2D. MultiPoints, lines, polygons and geometry collections use Leaflet paths.

`batchcanvas.js` optimises tiny line/polygon shapes in large vector datasets (at least 2,000 non-Point features): shapes at most three pixels across become small filled rectangles, while selected and larger shapes retain full rendering. `SpatialIndex` uses an adaptive grid plus a list for wide geometries to narrow click candidates. Exact hit testing then uses the renderer's geometry checks, with results ordered from the last dataset/feature backwards so overlapping features can be cycled.

`style.js` builds categories or numeric quantile ranges and resolves class colours against the current theme. `table.js` searches/sorts cooperatively and virtualises both rows and columns, with a 16 MiB search-text cache per dataset. Revision counters stop an older asynchronous table computation from replacing newer results. The inspector floats above the map, so opening it does not resize the map canvas.

### Profiles and native integration

Profiles are versioned JSON containing full feature data, styles, warnings, visibility, stacking order, basemap preference and view. Import sanitises metadata and revalidates all datasets. WIMP profiles are accepted, but saved remote map services have no vector data to restore and are skipped with a note.

`restoreProfile` prepares every replacement dataset off-map before replacing the current workspace. Failed or cancelled restoration retains the old workspace. `profileBlob` serialises in bounded batches and rejects exports larger than the same 100 MiB UTF-8 reopening limit. The Qt host intercepts the blob download, asks for a destination, stages the completed file in a private directory on that filesystem, and commits it with an atomic replacement. Browser-only development uses the browser's download mechanism instead.

The host's page bridge is `window.OmaMap`: `applyTheme`, `openUrls`, `setHost` and `profileSaved`. It passes structured values using JSON; there is no general-purpose command-execution bridge. Host responsibilities also include same-user single-instance IPC, desktop links, a recent-file list, denial of unneeded browser permissions, request filtering and bounded renderer-crash recovery. A normal second invocation forwards paths to the first window; `--new-window` opens an independent window.

## Build and run

### Supported desktop build

OmaMap targets Linux with Qt 6.8 or newer (Core, Gui, Widgets, Network, WebEngineCore and WebEngineWidgets), CMake 3.21 or newer, and a C++17 compiler. Arch package installation is documented in the [README](../README.md#install). On another Linux distribution, install matching Qt development packages and the compiler toolchain before configuring; older LTS distributions may not provide a recent enough Qt.

```sh
cmake -S host -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
./build/omamap --new-window path/to/data.geojson
```

A developer binary located in its configured build directory automatically serves `core/` from this checkout, regardless of the shell's working directory. Distribution builds should pass `-DOMAMAP_DEV_CORE=OFF`; the provided `packaging/arch/PKGBUILD` does this.

Run the desktop app as a normal user. It needs a working Wayland or X11 session and Qt WebEngine's graphics/runtime dependencies. Two build jobs are a conservative default for smaller machines; increase parallelism when memory permits. The build compiles the small host against system Qt; it does not compile Chromium or bundle JavaScript.

### Web-core development

Node.js is needed for tests and lint, not the installed application. Node 24 LTS is recommended; the locked ESLint supports `^20.19.0 || ^22.13.0 || >=24`. Use `npm ci --ignore-scripts` for the exact development lockfile. Python 3 provides the optional local server.

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run serve                 # http://127.0.0.1:8765; runs until stopped
```

The HTTP-server view is useful for UI work, but it is not an installed application and does not exercise the native scheme, request interceptor, download handling, single-instance behaviour or theme watcher.

### Full verification

Install system Chromium for Playwright (`playwright-core` deliberately does not install a browser), plus Xvfb, `xauth`, D-Bus, Mesa, `jq` and a font for the native headless checks. On Arch, the complete test/build dependency list is in [CI](../.github/workflows/ci.yml).

```sh
npm run lint
npm test
CHROMIUM=/usr/bin/chromium npm run test:browser
cmake -S host -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel 2
ctest --test-dir build --output-on-failure
QT_QPA_PLATFORM=xcb LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a dbus-run-session -- tests/host-smoke.sh
```

Run the browser suite before `tests/host-smoke.sh`; the smoke test uses browser-test fixtures. Browser tests start their own loopback servers and stub remote tile traffic. Generated fixtures, screenshots and benchmark output live under ignored `tests/output/`. To test a binary elsewhere, pass its path to `tests/host-smoke.sh`.

| Check | What it verifies | Needed for |
|---|---|---|
| `npm run lint` | First-party JS/shared globals and test code | Every change to JS or tooling |
| `npm test` | Parser limits, profiles, classification, measurement, spatial queries, rendering helpers, keyboard handling, plugin launches, tile policy and vendor hashes | Fast local regression loop |
| `npm run test:browser` | File loading, rendering, tables, styling, profiles, cancellation and hostile input in real Chromium | Web behaviour and the full PR gate |
| CMake build + `ctest` | Native compilation and profile-save, recent-list and core-directory trust regressions | Native changes and the full PR gate |
| `tests/host-smoke.sh` | Native scheme, file handoff, theme, downloads and host hardening under Qt WebEngine | Desktop integration and the full PR gate |
| `scripts/check-vendor-advisories.py` | Vendor release provenance and current GitHub advisory queries | Online dependency maintenance |

CI runs lint/unit tests on Node 24 first, then browser, native build/CTest and smoke checks in an Arch container for every PR, pushes to `main`, and manual dispatches. Failed integration jobs upload `tests/output/` and CTest diagnostics. The Arch base image is pinned by digest, but the job deliberately upgrades distribution packages; system Qt/Chromium versions therefore move with Arch. The disposable container's root-only sandbox exception is not an application setting. The separate vendor advisory workflow runs weekly, manually, and on PRs changing its script, workflow or dependency inputs.

For profiling rather than correctness checks, `node tests/bench.cjs` and `node tests/perf.cjs` drive a local Chromium. Their output is diagnostic and they are intentionally not part of `npm test`.

## Local configuration and state

There is no `.env` file or required secret. These native overrides are useful for development and tests:

| Variable | Purpose |
|---|---|
| `OMAMAP_CORE_DIR` | Explicit web-core directory; it is a developer trust override, so use only code you trust. |
| `OMAMAP_THEME_DIR` | Theme directory containing `colors.toml`; the default is `$XDG_STATE_HOME/omarchy/current/theme`. |
| `OMAMAP_INSTANCE` | Separate single-instance socket name for an independent development/test channel. |
| `OMAMAP_DEBUG` | Log page console messages, app-scheme requests and host events; logs can contain opened paths/URLs. |
| `QT_FORCE_STDERR_LOGGING=1` | Keep Qt diagnostics visible when stderr is not a terminal. |
| `CHROMIUM` | Executable path used by browser tests and benchmarks; defaults to `/usr/bin/chromium`. |

`OMAMAP_SELFTEST*` and `OMAMAP_SAVE_PATH` are test hooks used by the native smoke suite, not end-user configuration. Without an Omarchy theme the app uses bundled fallback colours. The UI font is queried from `omarchy-font-current` at startup; restart after changing the font independently.

Under standard Linux XDG paths, Qt keeps its web profile/local storage under `~/.local/share/omamap`, tile HTTP cache under `~/.cache/omamap`, and native settings under `~/.config/omamap`. `recent.json` lives at `~/.local/state/omamap/recent.json` (or `$XDG_STATE_HOME/omamap/recent.json`) and stores at most 15 files with owner-only permissions. Local storage remembers basemap choice, map view and table height; a profile save writes wherever the user chooses. Open datasets are not automatically persisted.

The HTTP tile cache has a configured 512 MiB maximum and respects provider caching headers. It is not an offline map pack: there is no bulk download or offline coverage guarantee. See the [README](../README.md#map-data-terms) for provider terms and attribution.

For setup failures, check the missing prerequisite first: CMake reports the required Qt version; browser tests need an executable at `CHROMIUM`; native headless checks need Xvfb with `QT_QPA_PLATFORM=xcb` and software GL. A missing web core means the binary is outside its developer build directory without an installed core, or the directory failed the host's trust check. Use a proper install or an explicit trusted `OMAMAP_CORE_DIR`.

## Design and security invariants

* Treat every opened file, profile field and archive member as hostile. New format paths must end in `validateFeatureCollection`, preserve the limits in `OmaParse.LIMITS`, and avoid writing input to disk.
* Render data as text, not HTML. Fixed provider attribution is the sole deliberate HTML insertion.
* Keep `core/basemaps.js`, the CSP in `core/index.html`, `SchemeHandler::ContentSecurityPolicy`, and `RequestFilter` host names aligned; `tests/hosts.test.cjs` enforces this.
* Do not invoke a shell with file-controlled text. The native code uses argument arrays, as does the bar widget.
* Packaged builds must not trust a build-tree core. The host additionally checks ownership and write permissions of the core directory and the entries it can serve; `OMAMAP_CORE_DIR` is an explicit trust override.
* Vendored browser assets are part of the application attack surface. Update their inventory, licences and `SHA256SUMS` together.

`SECURITY.md` is the user-facing threat model. `docs/SECURITY-REVIEW.md` records the latest repository review and its residual findings.

## Rough edges and maintenance notes

* The native build needs recent system Qt and Linux/POSIX APIs. Qt 6.8 is newer than the Qt available in some long-term-support distributions; no macOS or Windows host is maintained. The Omarchy QML widget's JavaScript logic is tested in Node, but full desktop-shell interaction still needs manual validation on Omarchy.
* The browser-only server cannot faithfully reproduce host security and desktop integration. Conversely, the host smoke suite needs Qt WebEngine, Chromium infrastructure, Xvfb, D-Bus and software GL, so it is heavier than the Node suite.
* KML/GPX XML construction uses the page's synchronous `DOMParser`. Counting and conversion are bounded/time-sliced, but the initial DOM parse can still pause the UI and cannot be interrupted mid-call.
* Resource budgets bound admitted input rather than process memory. Browser, transient parser and GPU allocations can exceed the estimates, and a renderer crash loses an unsaved workspace.
* Shapefile projection support depends on the `.prj` information understood by the vendored `shpjs`/`proj4`; absent `.prj` data is assumed to be WGS84 with a visible warning. The recent-file widget remembers only `.shp`, so reopening a loose shapefile from it does not restore its companions. Prefer a ZIP/profile or explicitly open all parts together.
* Blank numeric DBF cells become non-finite numbers in the vendored parser and currently reject the whole import. Re-export with explicit missing-value handling; a future fix needs to distinguish missing cells from malformed numeric text.
* Shapefile attributes require the ordinary dBASE layout of 32-byte field descriptors and a header terminator. Extended/padded DBF headers are rejected; the vendored parser does not correctly decode those variants.
* Geometry validation deliberately rejects empty datasets, null geometries and unclosed polygon rings. KML/GPX skip placemarks without geometry. ZIP64, encrypted archives and several nonstandard ZIP forms are unsupported. Re-export unusual inputs with a GIS tool if a required format is rejected.
* Length/area values are spherical estimates using horizontal coordinates, and the built-in BNG conversion is approximate (about 5 m). Polygon areas do not infer an antimeridian crossing: split such geometries before relying on their area. This is not survey-grade measurement.
* Numeric-field detection samples the first 5,000 features. A field populated only later may be offered as categories even though table/schema discovery includes all fields. Classification and some validation/index-building work remain synchronous and can pause large workloads.
* Separate point and vector canvases constrain stacking across mixed datasets. Translucent coincident points can also composite differently in Canvas and WebGL; addressing these differences needs rendering and performance decisions.
* The application has no end-user basemap configuration. Adding a provider requires coordinated code, policy, attribution, privacy and terms-of-use changes.
* Performance tests use generated data and wall-clock timings, so they are diagnostic benchmarks rather than deterministic CI gates.
* The installed Qt/WebEngine version is supplied by the OS, and `npm audit` covers only development tools. Shipped browser libraries need their separate inventory/advisory check; some dependencies embedded in `shpjs` do not publish exact versions. See the current [security review](SECURITY-REVIEW.md) for confirmed findings and audit limits.
