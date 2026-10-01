#!/usr/bin/env bash
# Smoke test for the native host, run headless:
#  1. opens files given on the command line (all formats, parse worker active)
#  2. a second `omamap FILE` hands the file to the running window
# Usage: tests/host-smoke.sh [path/to/omamap]
set -euo pipefail
cd "$(dirname "$0")/.."
bin=${1:-build/omamap}
fix=tests/output/fixtures
[[ -f $fix/park.geojson ]] || { echo "Run tests/browser.cjs first to write fixtures." >&2; exit 2; }

export QT_QPA_PLATFORM=offscreen QT_FORCE_STDERR_LOGGING=1 QTWEBENGINE_CHROMIUM_FLAGS=--disable-gpu
export XDG_DATA_HOME=$(mktemp -d) XDG_CACHE_HOME=$(mktemp -d)   # throwaway profile
trap 'rm -rf "$XDG_DATA_HOME" "$XDG_CACHE_HOME"' EXIT
fail=0

out=$(OMAMAP_SELFTEST=1 timeout 60 "$bin" --new-window $fix/park.geojson $fix/walk.gpx $fix/stations.csv \
  tests/fixtures/point.zip $fix/loose/projected.shp $fix/loose/projected.dbf $fix/loose/projected.prj 2>/dev/null | tail -1)
if [[ $out == *'"worker":true'* && $out == *'park:1'* && $out == *'walk:1'* && $out == *'stations:2'* && $out == *'point:1'* && $out == *'projected:1'* && $out == *'"errors":[]'* ]]; then
  echo "✔ command-line files load through the host"
else
  echo "✖ command-line files load through the host: $out"; fail=1
fi

log=$(mktemp)
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=8000 timeout 60 "$bin" $fix/park.geojson > "$log" 2>/dev/null &
first=$!
sleep 3
timeout 10 "$bin" $fix/cafes.geojson 2>/dev/null
wait $first || true
out=$(tail -1 "$log"); rm -f "$log"
if [[ $out == *'park:1'* && $out == *'cafes:2'* ]]; then
  echo "✔ second launch forwards files to the running window"
else
  echo "✖ second launch forwards files to the running window: $out"; fail=1
fi

# Live theme switch: replace the theme directory the way omarchy-theme-set does.
themes=$(mktemp -d)
mkdir -p "$themes/current/theme"
printf 'mode = "dark"\nbackground = "#101010"\naccent = "#ff8800"\n' > "$themes/current/theme/colors.toml"
log=$(mktemp)
OMAMAP_THEME_DIR="$themes/current/theme" OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=6000 timeout 60 "$bin" --new-window > "$log" 2>/dev/null &
first=$!
sleep 3
rm -rf "$themes/current/theme" && mkdir -p "$themes/current/theme"
printf 'mode = "light"\nbackground = "#fafafa"\naccent = "#0055ff"\n' > "$themes/current/theme/colors.toml"
wait $first || true
out=$(tail -1 "$log"); rm -rf "$log" "$themes"
if [[ $out == *'"mode":"light"'* && $out == *'rgb(250, 250, 250)'* && $out == *'"basemap":"light"'* ]]; then
  echo "✔ switching the Omarchy theme recolours the open window"
else
  echo "✖ switching the Omarchy theme recolours the open window: $out"; fail=1
fi
exit $fail
