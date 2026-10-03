# Security review — 2026-10-03

## Scope and method

This review covered the first-party web core, Qt host, Omarchy widget, packaging and CI definitions, committed browser dependencies, npm lockfile, and the complete reachable Git history. It is a source review and regression-test pass, not a formal penetration test or third-party audit.

Checks performed:

* searched the working tree and Git patches for credential/private-key patterns;
* reviewed every process launch and the QML launcher for shell interpolation;
* traced untrusted inputs through file-size checks, parsers, GeoJSON/property validation, DOM rendering, external-link handling and profile saving;
* reviewed ZIP path/structure/expansion checks and aggregate workspace budgets;
* compared the basemap list with both CSP copies and the native request allow-list;
* reviewed app-scheme confinement, one-use file capabilities, navigation/download policy, permissions, IPC peer checks and written-file permissions;
* verified vendored hashes and reviewed dependency pinning/automation;
* ran the available lint and automated security/regression tests.

The detailed product threat model and defence design remain in [`SECURITY.md`](../SECURITY.md).

## Findings summary

| ID | Severity | Area | Result |
|---|---:|---|---|
| SR-01 | Informational | Secrets | No embedded credential, private key or service API key was found in the current tree or reachable Git patches. Matches were documentation/test strings and the Actions-provided `github.token`. |
| SR-02 | Informational | Process execution | No file-controlled shell command was found. Native launches use `QProcess` argument lists. The widget uses `execDetached([...])`; its only shell is the fixed installation probe `command -v omamap >/dev/null`. |
| SR-03 | Informational | Input handling | Existing validation is unusually comprehensive: strict geometry/property validation, early tabular checks, archive consistency/CRC/path checks, file/dataset/workspace limits, XML declaration rejection and text-only rendering. Regression tests exercise hostile cases. |
| SR-04 | Informational | Host boundary | Scheme paths are canonicalised beneath the trusted core, opened-file URLs use single-use random capabilities, requests and navigation are allow-listed, renderer permissions are denied, and local IPC checks peer ownership. No low-risk host fix was identified. |
| SR-05 | Informational | Supply chain | npm development dependencies are exactly locked; GitHub Actions and the Arch container use immutable hashes/digests; browser libraries have committed hashes/licences and a weekly provenance/advisory workflow. Local hash tests passed. |
| SR-06 | Low / residual | XML availability | KML/GPX's initial `DOMParser.parseFromString` is synchronous. Preflight limits bound input and reject entity declarations, but a pathological in-limit document can pause the UI until that call returns. This is documented rather than changed because eliminating it requires a different XML parser or architecture. |
| SR-07 | Low / residual | Memory availability | Limits are admission estimates, not a hard process/GPU cap. Valid worst-case data can exceed comfortable memory on a small system, and a renderer restart loses unsaved work. Existing limits, cancellation and crash recovery reduce impact. |
| SR-08 | Low / residual | Third-party code | Leaflet, shpjs/proj4, fflate, PapaParse, togeojson and Qt WebEngine process untrusted bytes. Pre/post-validation and Chromium sandboxing reduce exposure but cannot remove parser/engine vulnerabilities. Keep system Qt packages and vendored monitoring current. |
| SR-09 | Review incomplete | Live advisories | The environment's network proxy returned HTTP 403 for the npm audit endpoint and npm registry, so current online advisory data could not be independently fetched during this pass. The lockfile's cached/offline audit reported zero known vulnerabilities, but that is not a substitute for a fresh query. The weekly `vendor-security.yml` workflow should provide the authoritative online result. |

## Low-risk fixes made

No new low-risk security defect was found that could be fixed without changing the documented trust model or undertaking a parser/host redesign. Existing mitigations and tests were retained. The functional antimeridian measurement correction in this quality pass does not change the security boundary.

The review added direct tests for previously uncovered thematic classification and geodesic measurement logic. Those tests reduce the chance that crafted or unusual valid values produce misleading legends or measurements, but are classified as correctness rather than security fixes.

## Secrets review detail

No production secret is required: the configured basemap providers use public tile URLs. `GH_TOKEN` appears only as the GitHub Actions job token supplied at runtime to the scheduled advisory query. Test strings include `/etc/passwd`, URL credentials and shell metacharacters specifically to prove that they are blocked or passed as a single argument; they are not credentials.

Because regex scanning cannot prove that a high-entropy value is harmless, repository owners should still keep GitHub secret scanning enabled. If a real secret ever entered history, deleting it from the branch would not be sufficient: revoke/rotate it first, then consider history rewriting.

## Dependency review detail

The shipped web runtime does not install npm packages. It uses the files under `core/vendor/`, checked by `core/vendor/SHA256SUMS` and `tests/vendor.test.cjs`. npm dependencies are development tooling (`eslint` and `playwright-core`) and are pinned by `package-lock.json`. The native runtime comes from the distribution's Qt packages, outside this repository's lockfile.

The repository already uses two complementary controls:

1. every PR runs lint, Node/browser tests, the native build/tests and the hardened-host smoke suite in `.github/workflows/ci.yml`; and
2. `.github/workflows/vendor-security.yml` checks the committed browser files against official npm release archives and queries GitHub advisories weekly.

The second check needs network access and should be investigated immediately if its scheduled run fails or reports an advisory. Dependabot covers npm and Actions metadata, but updating a vendored browser file remains a deliberate manual operation requiring hashes, licences, regression tests and release-note review.

## Owner decisions / follow-up

1. **KML/GPX parser architecture:** decide whether the documented bounded main-thread pause is acceptable, or whether a future release should adopt a worker-compatible streaming XML parser. That would be a larger dependency and security-review decision, not a low-risk patch.
2. **Resource envelope:** decide whether to offer a lower-memory mode or configurable limits for small systems. Lower defaults would reject files currently documented as supported; higher/configurable limits weaken the predictable availability boundary.
3. **Online audit confirmation:** confirm that the scheduled vendored-dependency security workflow is green after this PR. The current development environment could not reach the registries.

## Conclusion

No critical, high or medium severity issue was found. No secret or unsafe file-controlled shell execution was found. The important residual risks are availability at documented limits, synchronous XML DOM construction, third-party parser/engine defects and the need to confirm fresh online advisory results. These are already substantially mitigated and disclosed; the owner decisions above concern whether to invest in larger architectural changes.
