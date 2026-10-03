# Security review — 2026-10-03

## Scope and method

This pass reviewed the first-party web core, Qt host, Omarchy widget, packaging, CI, npm development dependencies and vendored browser libraries. It also scanned the complete Git history reachable from the checkout at the start of the review: 47 commits and 242 distinct blobs, through `4531008`. The checkout was not shallow. This is a source review with regression tests, not a penetration test or a guarantee that no vulnerabilities exist.

The checks covered credential patterns and suspicious high-entropy strings; process launches; file, archive and profile validation; DOM and external-link handling; app-scheme confinement; opened-file capabilities; navigation, downloads and permissions; local IPC; written-file permissions; dependency provenance and current advisories. [`SECURITY.md`](../SECURITY.md) describes the product threat model and existing protections.

## Findings and fixes

| ID | Severity | Finding | Resolution |
|---|---|---|---|
| SR-01 | Medium, conditional on unsafe local permissions | The native host checked only the top-level `core/` directory. A group/other-writable script or nested directory inside an otherwise trusted core could still supply executable app code. | The startup trust check now walks the served core tree, checking ownership and write permissions for files, hidden files and directories. Canonical paths prevent following links outside the served tree; visited paths bound internal symlink cycles. Native regression tests cover these cases. |
| SR-02 | Low, availability | GeoJSON declaring British National Grid ran recursive GeometryCollection reprojection before the normal nesting guard. A 15,000-level input exhausted the JavaScript stack. | Reprojection now enforces the existing geometry-depth limit before descending. Tests cover hostile nesting and the accepted boundary, including altitude preservation. |
| SR-03 | Low, audit coverage | The advisory inventory omitted `mgrs` and `wkt-parser`, which are embedded transitively through shpjs's proj4 bundle. Their advisories would not be queried by the scheduled check. | Added both to the package-wide advisory checks for embedded libraries without reliable exact version metadata. No runtime library was replaced. |
| SR-04 | Low, data integrity | A truncated shapefile could be accepted as a partial layer because shpjs stopped after the last complete record. | Validate the declared file length/version and complete record spans before parsing. Loose-file and ZIP regressions cover truncated records, negative lengths and trailing partial headers. |
| SR-05 | Low, data integrity | Inconsistent DBF field widths or a row count different from its shapefile could silently misread, drop or invent empty feature attributes. | Validate descriptor boundaries/terminator, row width against field widths, and equality of SHP/DBF record counts before calling shpjs. Regression tests cover each malformed layout and mismatched table size. |
| SR-06 | Informational | No embedded secret or data-controlled shell command was found. | History and current-source findings are described below. |
| SR-07 | Informational | Fresh online dependency checks found no published advisories for the checked packages. | npm audit, official-release comparisons and GitHub advisory queries completed successfully; scope and limitations are below. |

The host fix deliberately refuses an installation whose served files can be modified by another local user. The parser fixes reject malformed or excessively nested inputs; valid data within the documented limits retains its behavior. Profile numeric defaults and other correctness changes in this PR are covered by regression tests but are not presented as security vulnerabilities.

## Secrets and process execution

Pattern scans of all 242 reachable blobs checked private-key markers, common GitHub/AWS/Google/Slack credential formats, credential assignments and URLs containing credentials. The only candidates were deliberate URL fixtures in four historical versions of `tests/security.cjs`. An additional entropy check over 222 non-vendor textual blobs and a credential-pattern check of commit messages found no candidates. The review also inspected current authentication references without displaying credential values.

This scope does **not** include unreachable objects, deleted remote refs, forks, GitHub issues/artifacts, or local credential stores. Pattern and entropy scans can miss unfamiliar secret formats. Keep GitHub secret scanning enabled; any future confirmed exposure requires revocation/rotation before considering history cleanup.

Native process launches use `QProcess` argument lists. The bar widget opens paths with `execDetached(["omamap", "--", path])`; its shell command is the fixed installation probe `command -v omamap >/dev/null`. File-controlled text is not interpolated into shell commands. Host-to-page values are serialized as JSON, and untrusted displayed values use text nodes or attribute values. The app accepts only credential-free HTTP(S) attribute links and opens them in the external browser.

The basemap providers use public tile URLs; the app needs no service API secret. `GH_TOKEN` in the advisory workflow is supplied at runtime by GitHub Actions. The workflow grants only `contents: read` and does not persist checkout credentials.

## Dependency evidence

The following fresh network checks succeeded on 2026-10-03:

| Check | Result |
|---|---|
| `npm audit --json` | Zero reported vulnerabilities across 80 development dependencies. |
| `node --test tests/vendor.test.cjs` | Both tests pass: committed SHA-256 pins match all six browser asset files and no additional unpinned vendor file is present. |
| Official npm archives | All six files match the published releases for Leaflet 1.9.4, shpjs 6.2.0, fflate 0.8.3, PapaParse 5.4.1 and `@tmcw/togeojson` 5.1.2. The independent comparison also verified each downloaded archive against npm's integrity/shasum metadata. |
| npm bulk advisory API | No findings for the five pinned runtime library versions. |
| `python3 scripts/check-vendor-advisories.py` | Exit 0: official-release byte comparisons pass; GitHub reports zero advisories for the five pinned libraries and package-wide queries for `proj4`, `parsedbf`, `but-unzip`, `mgrs` and `wkt-parser`. |

The GitHub advisory endpoint initially returned a network-proxy HTTP 403. After the environment network configuration was updated, the official script was rerun and passed. There is no outstanding online-audit blocker from that initial failure.

The shipped browser runtime uses committed vendor files, not `node_modules`. npm's audit therefore cannot replace the separate vendor check. shpjs's archive does not publish a dependency lockfile and its bundled proj4 version is a placeholder; exact embedded versions remain unknown. Package-wide queries conservatively report any advisory for those packages, requiring a maintainer to assess applicability. A zero result is a snapshot of published advisories, not proof that the libraries are bug-free.

Qt WebEngine and other native libraries come from distribution packages. The native host was built and exercised with those packages during environment validation, but this pass did not independently match the distribution's Chromium/Qt patches against every upstream advisory. Keep the operating system and Qt packages updated.

Actions are pinned to commit hashes, the CI Arch image is pinned by digest, npm dependencies have a lockfile, and vendored files have hashes and licences. Dependabot covers npm and Actions; the weekly `vendor-security.yml` workflow handles vendor provenance and advisories. Investigate failures of that workflow rather than treating a failed query as an empty advisory result.

## Remaining limitations and owner decisions

1. **XML responsiveness:** KML/GPX conversion yields between features, but the initial `DOMParser.parseFromString` call is synchronous. File-size and feature-count prechecks, including rejection of `DOCTYPE`/`ENTITY`, reduce exposure but do not strictly bound parsing time or DOM allocations. Decide whether a future worker-compatible streaming XML parser is worth the additional dependency and design review.
2. **Memory envelope:** The 512 MiB workspace estimate is an admission budget, not a hard process/GPU cap. Large valid files can exceed comfortable memory on small systems; a renderer restart loses unsaved work. A lower-memory mode would change which inputs are accepted and should be a separate product decision.
3. **Local installation trust:** Core permissions are checked at startup. They are not a race-proof guarantee against later filesystem replacement or permission changes. Keep installation/checkout parent directories under trusted control. `OMAMAP_CORE_DIR` deliberately remains a developer override; the threat model trusts the user's environment and processes running as that user.
4. **Third-party and native code:** Continue vendor advisory monitoring and distribution updates. Updating vendored parsers requires provenance, hashes/licences and format/security regressions. The sandbox is disabled only for disposable container tests (CI runs as root); that configuration must not be copied into a normal desktop launch.

No critical issue was identified. The conditional local-code trust defect and the smaller validation/monitoring defects above have narrow fixes; the remaining items require ongoing maintenance or larger architectural decisions.
