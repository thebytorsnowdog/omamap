# OmaMap

View spatial data on Omarchy. Drop in GeoJSON, KML, GPX, CSV or shapefiles, see them over street, topo or satellite maps, click any feature to read its attributes, and browse each dataset as a table.

OmaMap follows your Omarchy theme. Its colours, font and light/dark basemap change when you switch theme.

## Use

```sh
omamap                                   # open the viewer
omamap sites.geojson roads.zip walk.gpx  # open with data
```

Running `omamap file` again sends the file to the open window. You can also drag files onto the window or press <kbd>O</kbd>.

| Key | Action |
|---|---|
| <kbd>O</kbd> | Open files |
| <kbd>1</kbd>–<kbd>6</kbd>, <kbd>B</kbd> / <kbd>Shift+B</kbd> | Choose / cycle basemap |
| <kbd>F</kbd> | Fit all datasets |
| click | Select the feature under the cursor |
| <kbd>[</kbd> <kbd>]</kbd> | Step through stacked features at the clicked spot |
| <kbd>Z</kbd> | Zoom to the selected feature |
| <kbd>T</kbd> | Open / close the attribute table |
| <kbd>L</kbd> | Collapse / expand the legend |
| <kbd>/</kbd> | Filter the selected feature's attributes |
| <kbd>Esc</kbd> | Leave the filter box, then clear the selection |

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

### Formats

- **GeoJSON** (`.geojson`, `.json`) in WGS84 longitude/latitude.
- **KML** and **GPX**.
- **CSV** with latitude/longitude columns (`lat`/`lon`, `latitude`/`longitude`, `x`/`y`…). Cells stay as text. Easting/northing CSV is not supported yet.
- **Shapefiles**, either zipped or as loose `.shp` + `.dbf` (+ `.prj`, `.cpg`) files dropped together. A `.prj` file is used to reproject to WGS84. A ZIP with several layers opens as one dataset per layer.

Imports are validated before anything reaches the map. Malformed geometry, unsafe property names, ZIP bombs and inconsistent archives are rejected with a reason. Parsing runs in a background worker so large files don't freeze the window.

Limits: 100 MiB per file, 50 MiB per ZIP (250 MiB expanded), 500,000 features and 5 million coordinates per dataset, 50 datasets.

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

Viewed tiles are kept in an ordinary HTTP cache (`~/.cache/omamap`, up to 512 MiB) that follows each provider's caching headers. OmaMap never downloads areas in bulk or ahead of time. The last map view and basemap choice are remembered in `~/.local/share/omamap`.

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

Requires `qt6-base` and `qt6-webengine`. Building also needs `cmake`.

### Optional: a key binding and window rule

Add to `~/.config/hypr/bindings.lua` (`SUPER + SHIFT + M` is already Music in Omarchy, so pick a free chord):

```lua
o.bind("SUPER + ALT + M", "OmaMap", "omamap")
```

OmaMap's window class is `omamap`.

## Develop

```text
core/      web app: index.html, app.js (map, datasets, inspector),
           parse.js (validation and parsing), parse-worker.js, vendor/
host/      Qt 6 WebEngine shell: omamap:// scheme, theme watcher, single instance
packaging/ desktop entry, MIME types, icon, PKGBUILD
tests/     parser tests (Node), browser tests (Playwright), host smoke test
```

```sh
cmake -S host -B build && cmake --build build
./build/omamap --new-window some.geojson     # runs against core/ in this checkout

npm install                 # playwright-core, for the browser tests
npm test                    # parser and validation tests
npm run test:browser        # drives core/ in Chromium (CHROMIUM=/usr/bin/chromium)
tests/host-smoke.sh         # headless checks of the native host (run test:browser first)
npm run serve               # core/ at http://127.0.0.1:8765 for quick UI work
```

`OMAMAP_DEBUG=1` prints page console messages and app-scheme requests. Add `QT_FORCE_STDERR_LOGGING=1` when stderr isn't a terminal. `OMAMAP_CORE_DIR` and `OMAMAP_THEME_DIR` override where the web core and the Omarchy theme are read from. `OMAMAP_INSTANCE=name` uses a separate single-instance channel, so a test run never sends files to your open window.

### Origins

The parsing and validation code comes from WIMP, a browser GIS viewer whose import paths went through a security review. That's why its ZIP, XML, CSV and GeoJSON checks are stricter than usual.

## Licence

MIT. Bundled libraries: Leaflet (BSD-2-Clause), shpjs and its bundled proj4 (MIT), fflate (MIT), PapaParse (MIT), @tmcw/togeojson (BSD-2-Clause). Their licence texts are in `core/vendor/licences/`.
