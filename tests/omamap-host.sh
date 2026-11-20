#!/usr/bin/env bash
# Focused native OmaMap regressions. Every file and setting is a throwaway fixture.
set -euo pipefail
cd "$(dirname "$0")/.."
bin=${1:-build/omamap}
scratch=$(mktemp -d)
first=
cleanup() {
  local status=$?
  if (( status )); then cat "$scratch"/*.log >&2; fi
  if [[ -n $first ]]; then kill "$first" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

export XDG_DATA_HOME=$scratch/data XDG_CACHE_HOME=$scratch/cache XDG_STATE_HOME=$scratch/state
export XDG_CONFIG_HOME=$scratch/config XDG_RUNTIME_DIR=$scratch/runtime OMAMAP_INSTANCE=omamap-test-$$
export QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-offscreen} QT_FORCE_STDERR_LOGGING=1 QTWEBENGINE_CHROMIUM_FLAGS=--disable-gpu
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$scratch/bin"
chmod 700 "$XDG_RUNTIME_DIR"
for command in hyprctl omarchy-font-current; do
  printf '#!/bin/sh\nexit 0\n' > "$scratch/bin/$command"
  chmod +x "$scratch/bin/$command"
done
export PATH=$scratch/bin:$PATH

printf 'name,latitude,longitude\nalpha,1,1\nbeta,2,2\n' > "$scratch/base.csv"
python3 - "$scratch" <<'PY'
from pathlib import Path
from sys import argv
from zipfile import ZipFile

root = Path(argv[1])
with ZipFile("tests/fixtures/projected-components.zip") as archive:
    for folder, extensions in (("left", ("shp", "prj", "dbf")), ("right", ("shp", "prj")),
                               ("ambiguous", ("shp", "prj", "dbf", "DBF"))):
        (root / folder).mkdir()
        for extension in extensions:
            (root / folder / ("site." + extension)).write_bytes(archive.read("ASSET." + extension.upper()))
PY

overflow=("$scratch/left/site.shp")
for i in {1..99}; do
  fixture="$scratch/extra-$i.csv"
  cp "$scratch/base.csv" "$fixture"
  overflow+=("$fixture")
done

assert_rejected() {
  local result=0
  timeout -k 2 10 "$bin" "$@" >> "$scratch/rejected.log" 2>&1 || result=$?
  [[ $result == 1 ]]
  grep -q 'Open at most 100 files at once, including shapefile companions' "$scratch/rejected.log"
}

assert_rejected --new-window "${overflow[@]}"
: > "$scratch/rejected.log"

observe='const open = OmaMap.openUrls; OmaMap.openUrls = function (...args) {
  return open(...args).then(() => {
    const names = STATE.datasets.map((d) => d.name);
    const attributes = STATE.datasets.slice(1).map((d) => Object.keys(d.features[0].properties).length);
    toast(JSON.stringify({names, attributes}), "", "ok");
    window.omamapChecked = true;
  });
};'
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_JS="$observe" OMAMAP_SELFTEST_WAIT='window.omamapChecked === true' \
  timeout -k 2 55 "$bin" "$scratch/base.csv" > "$scratch/host.log" 2> "$scratch/ready.log" &
first=$!
node tests/host-wait.cjs "$scratch/ready.log" OMAMAP_SELFTEST_READY
assert_rejected "${overflow[@]}"
timeout -k 2 10 "$bin" "$scratch/left/site.shp" "$scratch/right/site.shp" "$scratch/ambiguous/site.shp" 2>> "$scratch/ready.log"
wait "$first"
first=

jq -e '
  .basemap == "none" and .worker and .errors == [] and
  .datasets == ["base:2", "site:1", "site:1"] and
  (.notices | any(contains("Multiple files match") or . == "Skipped site.shp")) and
  (.notices | any(startswith("{") and (fromjson | .attributes[0] > 0 and .attributes[1] == 0)))
' "$scratch/host.log" >/dev/null
echo "OmaMap native batch, grouping and launcher checks passed"
