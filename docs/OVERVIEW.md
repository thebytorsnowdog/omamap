# OmaMap architecture and development overview

## What it does

OmaMap is a local-first desktop viewer for spatial data on Omarchy/Arch Linux. It opens GeoJSON, KML, GPX, CSV and shapefile data, validates and displays it over a selectable tile basemap, exposes feature attributes and measurements, and saves the complete workspace as an `.omamap` profile. Data stays in the process; the only routine network traffic is for the selected basemap's image tiles.

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

The ordinary data path is: a file picker/drop/native URL creates a browser `File`-like object; `app.js` transfers its bytes to `parse-worker.js`; `parse.js` validates and normalises one or more FeatureCollections; `app.js` admits them against the workspace budget and creates Leaflet or fast-point layers. The host never parses spatial formats. Profiles follow the same validation route as untrusted data files.

## Build and run

### Supported desktop build

OmaMap currently targets Linux with Qt 6.8 or newer (Core, Gui, Widgets, Network, WebEngineCore and WebEngineWidgets), CMake 3.21 or newer, and a C++17 compiler.

```sh
cmake -S host -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/omamap --new-window path/to/data.geojson
```

A developer build automatically serves `core/` from this checkout when the executable runs from its build directory. Distribution builds should pass `-DOMAMAP_DEV_CORE=OFF`; the provided `packaging/arch/PKGBUILD` does this. On Arch/Omarchy, `cd packaging/arch && makepkg -si` builds and installs the application and desktop integration.

### Web-core development

Node.js is needed only for development and tests. Use `npm ci` for the exact lockfile rather than `npm install` when reproducing CI.

```sh
npm ci --ignore-scripts
npm run serve                 # http://127.0.0.1:8765
npm run lint
npm test
```

The HTTP-server view is useful for UI work, but it is not an installed application and does not exercise the native scheme, request interceptor, download handling, single-instance behaviour or theme watcher.

### Full verification

```sh
npm run lint
npm test
CHROMIUM=/usr/bin/chromium npm run test:browser
cmake -S host -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
ctest --test-dir build --output-on-failure
QT_QPA_PLATFORM=xcb LIBGL_ALWAYS_SOFTWARE=1 \
  xvfb-run -a dbus-run-session -- tests/host-smoke.sh
```

Run the browser suite before `tests/host-smoke.sh`; the smoke test uses browser-test fixtures. CI's Arch container is the reference environment and installs Chromium, Qt WebEngine, Mesa, Xvfb and D-Bus before running this sequence.

For profiling rather than correctness checks, `node tests/bench.cjs` and `node tests/perf.cjs` drive a local Chromium. Their output is diagnostic and they are intentionally not part of `npm test`.

## Design and security invariants

* Treat every opened file, profile field and archive member as hostile. New format paths must end in `validateFeatureCollection`, preserve the limits in `OmaParse.LIMITS`, and avoid writing input to disk.
* Render data as text, not HTML. Fixed provider attribution is the sole deliberate HTML insertion.
* Keep `core/basemaps.js`, the CSP in `core/index.html`, `SchemeHandler::ContentSecurityPolicy`, and `RequestFilter` host names aligned; `tests/hosts.test.cjs` enforces this.
* Do not invoke a shell with file-controlled text. The native code uses argument arrays, as does the bar widget.
* Packaged builds must not trust a build-tree core. The host additionally rejects a core directory owned or writable by an untrusted local user.
* Vendored browser assets are part of the application attack surface. Update their inventory, licences and `SHA256SUMS` together.

`SECURITY.md` is the user-facing threat model. `docs/SECURITY-REVIEW.md` records the latest repository review and its residual findings.

## Rough edges and maintenance notes

* The supported native build is distribution-specific: Qt 6.8 is newer than the Qt available in some long-term-support distributions. CI uses a pinned Arch container, and no macOS or Windows host is maintained.
* The browser-only server cannot faithfully reproduce host security and desktop integration. Conversely, the host smoke suite needs Qt WebEngine, Chromium infrastructure, Xvfb, D-Bus and software GL, so it is heavier than the Node suite.
* KML/GPX XML construction uses the page's synchronous `DOMParser`. Counting and conversion are bounded/time-sliced, but the initial DOM parse can still pause the UI and cannot be interrupted mid-call.
* Resource budgets bound admitted input rather than process memory. Browser, transient parser and GPU allocations can exceed the estimates, and a renderer crash loses an unsaved workspace.
* Shapefile projection support depends on the `.prj` information understood by the vendored `shpjs`/`proj4`; absent `.prj` data is assumed to be WGS84 with a visible warning.
* The application has no end-user basemap configuration. Adding a provider requires coordinated code, policy, attribution, privacy and terms-of-use changes.
* Performance tests use generated data and wall-clock timings, so they are diagnostic benchmarks rather than deterministic CI gates.
