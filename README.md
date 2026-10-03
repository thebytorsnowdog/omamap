# OmaMap

View spatial data on Omarchy. Drop in GeoJSON, KML, GPX, CSV or shapefiles, see them over street, topo or satellite maps, click any feature to read its attributes, browse each dataset as a table, and save the whole workspace as a profile.

OmaMap follows your Omarchy theme. Its colours, font and light/dark basemap change when you switch theme.

## Use

```sh
omamap                                   # open the viewer
omamap sites.geojson roads.zip walk.gpx  # open with data
```

Running `omamap file` again sends the file to the open window. You can also drag files onto the window or press <kbd>O</kbd>.

### Profiles

**Save** (<kbd>Ctrl+S</kbd>) writes a `.omamap` profile: every open dataset with its data, style, visibility, stacking order and any warnings shown for it (such as an assumed coordinate system), plus the map view and basemap. Open it like any other file, from the app, the file manager or `omamap work.omamap`, to pick up where you left off. If datasets are already open, OmaMap asks before replacing them.

A profile contains a full copy of the data, so share it with the same care as the data itself. Profiles exported from WIMP (`.sdv-profile.json`) open too.

Profiles are limited to 100 MiB so every completed export fits the reopening limit. Oversized exports show an error before writing a file; save smaller workspaces in that case. Replacing an existing profile uses a completed temporary download and an atomic replacement, preserving the previous file if saving fails.

| Key | Action |
|---|---|
| <kbd>O</kbd> | Open files or a profile |
| <kbd>Ctrl+S</kbd> | Save a profile |
| <kbd>1</kbd>–<kbd>6</kbd>, <kbd>B</kbd> / <kbd>Shift+B</kbd> | Choose / cycle basemap |
| <kbd>F</kbd> | Fit all datasets |
| click | Select the feature under the cursor |
| <kbd>[</kbd> <kbd>]</kbd> | Step through stacked features at the clicked spot |
| <kbd>Z</kbd> | Zoom to the selected feature |
| <kbd>T</kbd> | Open / close the attribute table |
| <kbd>L</kbd> | Collapse / expand the legend |
| <kbd>/</kbd> | Filter the selected feature's attributes |
| <kbd>Esc</kbd> | Leave the filter box, then clear the selection |

Clicking a feature opens its attributes in a panel that floats over the right side of the map, so the map itself never resizes or redraws. Close it with × or <kbd>Esc</kbd>, or by clicking an empty spot on the map. Zooming to a feature, fitting datasets and selecting a table row all keep the feature in the part of the map the panel doesn't cover. While the panel is open, the legend moves beside it (or is hidden when the map is too narrow for both).

### Styling datasets

Each dataset gets a colour from your theme. The ◐ button on a dataset opens its style settings: colour, opacity, line or outline width, point size and outline (same as fill, light, dark or none).

**Colour by** colours features by one of their fields, and a legend appears on the map:

- **Each value:** one colour per distinct value (up to 24; the rest are grouped as "Other"). Fields whose values all have an obvious meaning use your theme's green, yellow and red. Examples: Yes/No, Completed/Pending/Overdue, In service/Out of service/Planned. Small numeric codes, such as condition grades 1–5, use an ordered colour ramp.
- **Number ranges:** up to five ranges, each holding a similar number of features, for continuous numbers such as risk scores or lengths. The ramp can be reversed.

Empty values are counted separately as "Missing". Class colours follow your theme, so they change when you switch theme.

### Attribute table

▦ on a dataset (or <kbd>T</kbd>) opens its full table under the map. Drag the top edge to resize it.

- Click a column heading to sort (again to reverse, a third time to clear).
- Search across all values, or tick **In view only** to list just the features in the current map view.
- Click a row to select the feature and bring it into view. Double-click, or press <kbd>Enter</kbd>, to zoom to it. <kbd>↑</kbd> <kbd>↓</kbd> step through rows.
- Selecting a feature on the map highlights its row.

The table draws only the rows on screen, so it stays quick with large datasets.

Fields from every feature are included, even when they first appear late in a dataset. Large searches and sorts run in short batches so the window can respond while they finish.

### Formats

- **GeoJSON** (`.geojson`, `.json`) in WGS84 longitude/latitude.
- **KML**, **KMZ** and **GPX**, also inside a ZIP alongside other layers.
- **CSV** with latitude/longitude columns (`lat`/`lon`, `latitude`/`longitude`), or British National Grid easting/northing (`easting`/`northing`, or `x`/`y` holding grid values). Cells stay as text.
- **Shapefiles**, either zipped or as loose `.shp` + `.dbf` (+ `.prj`, `.cpg`) files dropped together. A `.prj` file is used to reproject to WGS84. A ZIP with several layers opens as one dataset per layer.

British National Grid data (EPSG:27700) is converted to WGS84 automatically, to within about 5 m (the same 7-parameter method PROJ uses without grid files). That covers easting/northing CSV, GeoJSON that declares EPSG:27700 (as older QGIS exports do), and shapefiles with a BNG `.prj`. The dataset list notes when a conversion happened.

Imports are validated before anything reaches the map. Malformed geometry, unsafe property names, ZIP bombs, inconsistent archives and shapefile headers that don't fit their file are rejected with a reason. Parsing runs in a background worker so large files don't freeze the window. KML and GPX need the page's XML parser, so they are converted on the main thread in short slices: the window keeps painting and Cancel works, apart from one pause while the XML itself is read.

Limits: 100 MiB per file, 50 MiB per ZIP (250 MiB expanded, at most 50 layers and 1,000,000 features across them), 500,000 features, 5 million coordinates, 1,000 attribute names and 500 attributes per feature per dataset, 10 million values per CSV or shapefile table, and about 200 MiB of attribute data per dataset (attribute names count once per dataset, so a 200,000 × 20 CSV fits comfortably), 50 datasets.

The whole workspace is also limited to 1 million features, 10 million coordinates, and 512 MiB of estimated data and rendering structures. This estimate is an admission budget, not a limit on the process's actual memory use. The table's search-text cache is limited to 16 MiB per dataset.

Point datasets are drawn on the GPU (WebGL), so hundreds of thousands of points pan and zoom smoothly. Where WebGL isn't available, a 2D fallback is used. Lines and polygons use Leaflet's canvas renderer, which handles tens of thousands of shapes comfortably. In a dataset of 2,000 or more lines or polygons, any shape no more than 3 pixels across at the current zoom is drawn as a small solid rectangle. That covers the same area, in the outline colour, as Leaflet's round-cornered blob, and makes zoomed-out redraws of dense layers about four to six times faster. At that size the two look alike: zoom in and every shape is drawn in full. Smaller datasets, and the selected feature, are always drawn in full.

Single-point features keep the fast renderer in mixed datasets too. GPU point positions stay in reusable buffers during navigation, and a spatial index narrows click selection to nearby candidates. File imports build layers in batches; Cancel also stops that stage.

## What leaves your machine

Your data files never leave your machine. Only basemap tiles are fetched over the network:

| Basemap | Provider |
|---|---|
| Streets | OpenStreetMap ([tile policy](https://operations.osmfoundation.org/policies/tiles/)) |
| Light, Dark | Esri World Light/Dark Gray Canvas |
| Topo | OpenTopoMap |
| Satellite | Esri World Imagery |
| None | Nothing is requested |

Tile requests reveal the area you are viewing to that provider. The window can't contact any other host. A Content Security Policy in the page and a request filter in the host both enforce this.

Viewed tiles are kept in an ordinary HTTP cache (`~/.cache/omamap`, up to 512 MiB) that follows each provider's caching headers. OmaMap never downloads areas in bulk or ahead of time. The last map view and basemap choice are remembered in `~/.local/share/omamap`, the folder you last saved a profile to in `~/.config/omamap`, and recently opened files (for the bar widget) in `~/.local/state/omamap/recent.json`, readable only by you.

There is no telemetry, crash reporting or update check. Links in your data (`http`/`https` only) open in your browser when you click them.

See [SECURITY.md](SECURITY.md) for the threat model, what OmaMap defends against, its known limits, and how to report a vulnerability. The latest repository audit is recorded in [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md).

### Map data terms

None of the basemaps needs an API key. That convenience comes with conditions set by each provider, which apply to you as the user:

- **OpenStreetMap** (Streets) is a volunteer-run service. Follow its [tile usage policy](https://operations.osmfoundation.org/policies/tiles/): normal interactive viewing only, with no bulk or offline downloading.
- **Esri** (Light, Dark, Satellite) is free for **non-commercial use** with attribution, under [Esri's terms](https://www.esri.com/en-us/legal/terms/web-site-service). For work or commercial use, use the Streets or Topo maps or a provider you have a licence for.
- **OpenTopoMap** (Topo) is CC-BY-SA and meant for light use.

Attribution for the active basemap is always shown on the map.

## Install

### Arch / Omarchy

```sh
git clone https://github.com/thebytorsnowdog/omamap.git
cd omamap/packaging/arch
makepkg -si
```

To update, run `git pull` in the clone and `makepkg -si` again. To uninstall, run `sudo pacman -R omamap`.

Requires `qt6-base` and `qt6-webengine` 6.8 or newer. Building also needs `cmake`.

### Omarchy bar widget

The repository is also an Omarchy shell plugin. It adds a map icon to the bar: left-click opens OmaMap, and right-click lists your recent profiles and files.

```sh
omarchy plugin add https://github.com/thebytorsnowdog/omamap.git --enable
```

The widget only launches the app, so install OmaMap first. Recent files are read from `~/.local/state/omamap/recent.json`; set `maxItems` in the widget's settings to change how many are listed.

### Optional: a key binding and window rule

Add to `~/.config/hypr/bindings.lua` (`SUPER + SHIFT + M` is already Music in Omarchy, so pick a free chord):

```lua
o.bind("SUPER + ALT + M", "OmaMap", "omamap")
```

OmaMap's window class is `omamap`.

## Develop

For a fuller architecture, data-flow and troubleshooting guide, see [docs/OVERVIEW.md](docs/OVERVIEW.md).

```text
core/      web app: index.html, app.js (map, datasets, inspector), batchcanvas.js (large-layer drawing),
           parse.js (validation and parsing), parse-worker.js, vendor/
host/      Qt 6 WebEngine shell: omamap:// scheme, theme watcher, single instance,
           profile save dialog, recent files
omarchy-plugin/  bar widget (manifest.json at the repository root)
packaging/ desktop entry, MIME types, icon, PKGBUILD
tests/     parser tests (Node), browser tests (Playwright), host smoke test
```

```sh
cmake -S host -B build && cmake --build build
./build/omamap --new-window some.geojson     # runs against core/ in this checkout

npm ci --ignore-scripts     # exact locked Playwright and ESLint versions
npm run lint                # ESLint over core/ and tests/ (catches undefined names across the core scripts)
npm test                    # parser, validation, bar widget, tile-host and vendor-hash tests
npm run test:browser        # drives core/ in Chromium, incl. hostile-input tests (CHROMIUM=/usr/bin/chromium)
ctest --test-dir build --output-on-failure # native profile-save and recent-list tests
tests/host-smoke.sh         # headless checks of the native host and its hardening (run test:browser first)
npm run serve               # core/ at http://127.0.0.1:8765 for quick UI work
```

`npm test` discovers every `tests/*.test.cjs` file. In particular, `tests/measure.test.cjs` covers the map's geodesic measurement logic (including wide polygons and holes), and `tests/style.test.cjs` covers semantic categories, category limits and numeric quantiles.

`OMAMAP_DEBUG=1` prints page console messages and app-scheme requests. Add `QT_FORCE_STDERR_LOGGING=1` when stderr isn't a terminal. `OMAMAP_CORE_DIR` and `OMAMAP_THEME_DIR` override where the web core and the Omarchy theme are read from. `OMAMAP_INSTANCE=name` uses a separate single-instance channel, so a test run never sends files to your open window. Packages should configure with `-DOMAMAP_DEV_CORE=OFF` so the installed binary never reads `core/` from the build tree.

### Origins

The parsing and validation code comes from WIMP, a browser GIS viewer whose import paths went through a security review. That's why its ZIP, XML, CSV and GeoJSON checks are stricter than usual.

## Licence

MIT. Bundled libraries: Leaflet (BSD-2-Clause), shpjs and its bundled proj4 (MIT), fflate (MIT), PapaParse (MIT), @tmcw/togeojson (BSD-2-Clause). Their licence texts are in `core/vendor/licences/`.
