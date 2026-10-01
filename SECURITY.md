# Security

OmaMap opens spatial data files that often come from somewhere else: an email attachment, a download, a colleague's share. This document describes what OmaMap assumes, what it defends against and how, what it does not protect against, and what leaves your machine.

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (<https://github.com/thebytorsnowdog/omamap/security/advisories/new>). Include the OmaMap version (`omamap --version`), what you did, and a sample file if one is involved. Please don't open a public issue for a vulnerability until a fix is released.

Fixes go into the next release. Only the latest release is supported.

## Threat model

**Trusted:** you, and everything that runs as your user account. Another program running as you can already read your files and drive your desktop, so OmaMap does not try to defend against it. This includes the Omarchy theme files, OmaMap's own settings and state files, and environment variables (`OMAMAP_*`, `QTWEBENGINE_*`).

**Untrusted:**

1. **Data files and profiles you open**: GeoJSON, KML, GPX, CSV, shapefiles, ZIPs, `.omamap` and WIMP `.sdv-profile.json` profiles. Everything in them, including file names, names inside ZIPs, attribute names and values, styles and map settings in profiles, is treated as hostile.
2. **Other local users** on a shared machine.
3. **The network.** Only the basemap tile servers are contacted, and their responses are treated as untrusted images.

The goals are that an untrusted file cannot run code, read or send other files, reach the network, change anything outside OmaMap, or deceive you through the interface; that at worst it fails to open or uses a bounded amount of memory and time; and that other local users cannot see or influence what you open.

## How OmaMap defends

### Parsing untrusted files

All parsing and validation is in `core/parse.js`, which descends from WIMP's security-reviewed import code. Parsing runs in a Web Worker that the **Cancel** button can stop. KML and GPX are the exception, as they need `DOMParser`, which workers lack.

- **Validation before display.** GeoJSON is checked structurally: geometry types, finite WGS84 coordinates, closed rings, and bounded GeometryCollection nesting. Features are rebuilt with only `type`, `geometry`, `properties` and `id`. Attribute values must be JSON values (string, number, boolean, null, array, plain object), and nesting is limited to 20 levels.
- **Prototype pollution.** Attribute and CSV header names `__proto__`, `prototype` and `constructor` are rejected at any depth. The interface reads attribute values only as an object's own properties, so a field called `toString` never shows `Object.prototype` members as values.
- **Resource limits.** 100 MiB per file. 500,000 features, 5 million coordinates, 1,000 distinct attribute names and 500 attributes per object per dataset. 10 million values per CSV or shapefile table. 100,000 characters per value. 50 datasets. Limits are enforced as early as possible:
  - CSV is parsed in 1 MiB chunks and stops one row past the limit.
  - Shapefile `.shp` record headers and `.dbf` headers are checked against the file size before the shapefile library reads them.
  - KML and GPX placemarks and tracks are counted in the text before a DOM is built.
  - Nested arrays of GeoJSON layers are depth-limited.
- **ZIP archives.** Archives may be at most 50 MiB, expand to at most 250 MiB with a compression ratio of at most 100, and hold at most 500 entries and 50 layers, with at most 1,000,000 features across all layers. Before anything is decompressed, the central directory and local headers must agree and entries must tile the archive exactly, with no overlaps or hidden data. Names must be safe: no absolute paths, `..`, backslashes or control characters. Encrypted, multi-disk and ZIP64 archives are refused, and data descriptors must match the central directory. Each entry is inflated once, in bounded steps, and its size and CRC-32 are checked. Nothing is ever written to disk.
- **XML.** KML and GPX with a `DOCTYPE` or `ENTITY` declaration are refused, so entity expansion and external entities are impossible. Chromium's `DOMParser` never fetches external resources.
- **Profiles.** Every dataset in a profile goes through the same validation. Colours must be `#rrggbb`, numbers are clamped to their ranges, and enumerations come from fixed lists. The basemap must be one OmaMap knows. The view must be finite and in range. Names are plain text of bounded length.

### Displaying untrusted data

- **No HTML from data.** Every value from a file is placed with `textContent` or as a DOM attribute value, never through `innerHTML`. This covers dataset and file names, attribute names and values, legend labels, table cells, tooltips, toasts and dialogs. The only HTML the app writes is the fixed basemap attribution.
- **Links.** An attribute value becomes a link only if it is an absolute `http:` or `https:` URL without a user name or password. It opens with `target="_blank" rel="noopener noreferrer"`, which the host hands to your default browser. `javascript:`, `data:`, `file:`, `omamap:` and other schemes are shown as text.
- **Content Security Policy**, in the page and sent by the host as a header:
  - `default-src 'none'`
  - Scripts, styles and workers only from the app itself, with no `unsafe-inline` or `unsafe-eval`
  - Images only from the app, `data:` and the five tile hosts
  - `connect-src 'self'`
  - No frames, objects, forms or `<base>`
  - `frame-ancestors 'none'`

  Injected markup could not run script, apply inline styles or contact another host.
- **Spreadsheet safety.** **Copy** prefixes values that start with `=`, `+`, `-` or `@` so a spreadsheet does not treat them as formulas.

### The desktop host (Qt WebEngine)

- **App scheme.** The web core is served from `omamap://app/`. Requests are confined to the core directory after resolving symlinks and `..`, and only `GET` on host `app` is allowed. A file you open is served at `omamap://app/file/<token>/<name>`, where the token is 128 random bits. Only requests made by the app's own page are served, as `application/octet-stream` with `nosniff` and a `sandbox` CSP. Every response from the web core carries the page CSP and `nosniff`.
- **Network filter.** A request interceptor mirrors the CSP. It allows only the app scheme, `data:`, `blob:`, and `https:` *image* requests to `tile.openstreetmap.org`, `server.arcgisonline.com` and `{a,b,c}.tile.opentopomap.org`, and blocks everything else.
- **Navigation.** The window only ever shows `omamap://app/index.html`. A link you click (`http`/`https`, no credentials) opens in your browser. Script-opened windows, other schemes, frames and dropped URLs go nowhere. Unknown URL schemes are never handed to the desktop.
- **Permissions.** Every permission request is denied and none is stored. This covers geolocation, notifications, camera, microphone, screen capture, clipboard reading, local fonts and pointer lock. File-system access, protocol-handler and full-screen requests are rejected.
- **Engine settings.** These are explicitly off: file URL access, insecure content, DNS prefetch, hyperlink auditing, navigate-on-drop, screen capture, full screen, plugins, the PDF viewer, script-opened windows and window activation from script. WebRTC is limited to public interfaces. Pages render in Chromium's renderer sandbox, using user namespaces and seccomp-bpf. Do not disable it with `QTWEBENGINE_DISABLE_SANDBOX`.
- **Downloads.** Only `blob:` downloads created by the app's own page (saving a profile) are accepted. They always go through a save dialog that confirms replacing an existing file. All other downloads are cancelled.
- **Script injection from the host.** Theme colours (validated `#rrggbb`), the font name, file names and paths are passed to the page as JSON, never spliced into code as raw text.

### Single instance (local IPC)

`omamap FILE` hands files to an already open window over a Unix socket at `$XDG_RUNTIME_DIR/omamap.sock`. That directory is private to your user (mode 0700), and the socket is also mode 0700. The server checks that the connecting process runs as your user (`SO_PEERCRED`). Each line of a message is a percent-encoded `file://` URL, so a file name containing a newline stays one path. Input is capped at 1 MiB pending and 1,000 paths per connection. A connecting process can only ask the window to open files and raise itself. Earlier versions used `/tmp/omamap-$USER`, which another local user could create first.

If no private runtime directory is available, every launch opens its own window.

### Files OmaMap writes

| File | Contents | Protection |
|---|---|---|
| `~/.local/state/omamap/recent.json` | Paths of the last 15 files opened and profiles saved (for the bar widget) | Written atomically, mode 0600 in a 0700 directory |
| `~/.config/omamap/omamap.conf` | Folder a profile was last saved to | Your config directory |
| `~/.local/share/omamap/` | Web storage: last map view, basemap, table height | Your data directory |
| `~/.cache/omamap/` | HTTP cache of viewed basemap tiles (up to 512 MiB) | Your cache directory |
| Profiles you save | A full copy of every open dataset | Where you choose |

No cookies are persisted. Opened files are never written or modified.

### The Omarchy bar widget

The widget (`omarchy-plugin/BarWidget.qml`) runs inside the Omarchy shell, without a sandbox. It reads `recent.json`, ignores any entry that is not an absolute path or that contains control characters, and opens files with an argument vector, `omamap -- <path>`. No shell is involved, so nothing in a file name (quotes, `$(…)`, backticks, leading dashes) is interpreted. `omarchy plugin add` clones the whole repository, but the shell loads only the entry point named in `manifest.json`. The `omarchy-plugin/` directory contains nothing else, and no other file in the repository runs on plugin load. Installing or updating the plugin means trusting this repository's code to run in your desktop shell, as with any Omarchy plugin.

### Supply chain and packaging

The five web libraries are vendored: Leaflet 1.9.4, shpjs 6.2.0 (with proj4 and but-unzip), fflate 0.8.3, PapaParse 5.4.1 and @tmcw/togeojson 5.1.2. Their SHA-256 hashes are pinned in `core/vendor/SHA256SUMS`, and they match WIMP's reviewed dependency lock. The test suite and the PKGBUILD's `check()` both verify them. The build downloads nothing. The PKGBUILD builds the working tree it sits in, including uncommitted changes.

## What leaves your machine

- **Basemap tile requests** to the provider of the basemap you choose, or none for **None**. Tile coordinates reveal the area and zoom you are viewing, and the provider sees your IP address and a User-Agent. That is `OmaMap/<version>` for OpenStreetMap and OpenTopoMap, and Qt WebEngine's default for Esri.
- **Links you click** open in your browser.
- Nothing else. Your data, file names and profiles never leave the machine. There is no telemetry, crash reporting or update check, and the window cannot contact any other host.

## Known limitations and residual risks

- **Resource use within the limits.** A file inside every limit can still be large: 500,000 features, 5 million coordinates, 100 MiB of input. Several such files, up to 50 datasets, can use gigabytes of memory. If the page runs out of memory it is restarted, with a notice, and unsaved work is lost. Within the limits, files that are slow to parse can take a while. The Cancel button stops worker parsing.
- **KML and GPX parse on the main thread** and can't be cancelled. A large file within the limits can freeze the window for some seconds.
- **Third-party parsers.** The shapefile reader (shpjs, with proj4 for `.prj` files), togeojson, fflate, PapaParse and Leaflet process untrusted input. OmaMap checks their inputs and outputs, but a bug in them could still crash parsing or the page. They are memory-safe JavaScript in a sandboxed renderer.
- **Qt WebEngine (Chromium)** decodes the tile images and renders the page. Its security fixes come from your distribution's `qt6-webengine` package, so keep the system updated. A compromised tile server could send malicious images to Chromium's image decoders.
- **Links.** A data file can contain an `https` link to any site, as any document can. The link text is the original value, so check where a link goes before you trust it: look-alike domains and invisible characters are possible.
- **Clipboard writing** is allowed so **Copy** works. Clipboard reading is denied.
- **WebRTC** cannot be turned off through Qt's settings. Without script injection, which the CSP prevents, nothing can use it.
- **Swapped files.** OmaMap checks that an opened path is a regular file when it is opened and again when it is served. If someone else can write to the folder, they could replace the file between those moments. The page then reads whatever you are allowed to read at that path, which stays inside OmaMap.
- **Profiles contain full copies of your data.** Share them with the same care as the data itself.
- **Local privacy.** The tile cache, the last map view and the recent-files list reveal what you looked at to anyone who can read your home directory. Clear `~/.cache/omamap`, `~/.local/share/omamap` and `~/.local/state/omamap` to remove them.
- **Developer hooks.** `OMAMAP_CORE_DIR`, `OMAMAP_SELFTEST_JS` and similar environment variables change what the app loads or runs. They are for development and tests. Anything that can set your environment is already trusted.
