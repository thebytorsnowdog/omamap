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
# Throwaway browser profile, recent list and settings.
export XDG_DATA_HOME=$(mktemp -d) XDG_CACHE_HOME=$(mktemp -d) XDG_STATE_HOME=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d)
export OMAMAP_INSTANCE=smoke-$$   # never talk to the user's running OmaMap
# A private runtime directory too: the single-instance socket lives there.
export XDG_RUNTIME_DIR=$(mktemp -d)
chmod 700 "$XDG_RUNTIME_DIR"
# Nothing here may reach the desktop: links the app hands out are only logged.
fakebin=$(mktemp -d)
printf '#!/bin/sh\necho "$*" >> "%s/opened"\n' "$fakebin" > "$fakebin/xdg-open"
chmod +x "$fakebin/xdg-open"
export PATH=$fakebin:$PATH BROWSER=true
cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -f ${hostlog:-} ]]; then
    echo "Native host diagnostics:" >&2
    tail -100 "$hostlog" >&2
  fi
  rm -rf "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR" "$fakebin"
  [[ -z ${hostlog:-} ]] || rm -f "$hostlog"
}
trap cleanup EXIT
hostlog=$(mktemp)
fail=0

out=$(OMAMAP_SELFTEST=1 timeout -k 5 60 "$bin" --new-window $fix/park.geojson $fix/walk.gpx $fix/stations.csv \
  tests/fixtures/point.zip $fix/loose/projected.shp $fix/loose/projected.dbf $fix/loose/projected.prj 2>> "$hostlog" | tail -1)
if [[ $out == *'"worker":true'* && $out == *'park:1'* && $out == *'walk:1'* && $out == *'stations:2'* && $out == *'point:1'* && $out == *'projected:1'* && $out == *'"errors":[]'* ]]; then
  echo "✔ command-line files load through the host"
else
  echo "✖ command-line files load through the host: $out"; fail=1
fi

log=$(mktemp)
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=8000 timeout -k 5 60 "$bin" $fix/park.geojson > "$log" 2>> "$hostlog" &
first=$!
sleep 3
timeout -k 5 10 "$bin" $fix/cafes.geojson 2>> "$hostlog"
wait $first || true
out=$(tail -1 "$log"); rm -f "$log"
if [[ $out == *'park:1'* && $out == *'cafes:2'* ]]; then
  echo "✔ second launch forwards files to the running window"
else
  echo "✖ second launch forwards files to the running window: $out"; fail=1
fi

# Save a profile through the desktop save path, then reopen it from the command line.
saved=$XDG_DATA_HOME/smoke.omamap
out=$(OMAMAP_SAVE_PATH=$saved OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=5000 OMAMAP_SELFTEST_JS='saveProfile()' \
  timeout -k 5 60 "$bin" --new-window $fix/park.geojson $fix/stations.csv 2>> "$hostlog" | tail -1)
recent=$XDG_STATE_HOME/omamap/recent.json
if [[ -s $saved ]] && jq -e '.recent[0].kind == "profile" and (.recent[0].path | endswith("/smoke.omamap"))
    and any(.recent[]; .name == "park.geojson")' "$recent" >/dev/null 2>&1; then
  echo "✔ saving a profile writes the file and the recent list"
else
  echo "✖ saving a profile writes the file and the recent list: $(ls -la "$saved" 2>&1) $(cat "$recent" 2>&1)"; fail=1
fi
out=$(OMAMAP_SELFTEST=1 timeout -k 5 60 "$bin" --new-window "$saved" 2>> "$hostlog" | tail -1)
if [[ $out == *'park:1'* && $out == *'stations:2'* && $out == *'"errors":[]'* ]]; then
  echo "✔ a saved profile reopens from the command line"
else
  echo "✖ a saved profile reopens from the command line: $out"; fail=1
fi

# Kill the page's renderer process: the app must reload the page and say so.
log=$(mktemp)
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=9000 timeout -k 5 60 "$bin" --new-window $fix/park.geojson > "$log" 2>> "$hostlog" &
app=$!
sleep 4
descendants() { local p; for p in $(pgrep -P "$1"); do echo "$p"; descendants "$p"; done; }
renderer=$(for p in $(descendants $app); do grep -qa -- '--type=renderer' /proc/$p/cmdline 2>> "$hostlog" && echo $p; done | head -1)
[[ -n $renderer ]] && kill -9 "$renderer"
wait $app || true
out=$(tail -1 "$log"); rm -f "$log"
if [[ -n $renderer && $out == *'OmaMap recovered'* ]]; then
  echo "✔ a crashed page reloads with a notice"
else
  echo "✖ a crashed page reloads with a notice (renderer pid: ${renderer:-none}): $out"; fail=1
fi

# Live theme switch: replace the theme directory the way omarchy-theme-set does.
themes=$(mktemp -d)
mkdir -p "$themes/current/theme"
printf 'mode = "dark"\nbackground = "#101010"\naccent = "#ff8800"\n' > "$themes/current/theme/colors.toml"
log=$(mktemp)
OMAMAP_THEME_DIR="$themes/current/theme" OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=6000 timeout -k 5 60 "$bin" --new-window > "$log" 2>> "$hostlog" &
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
# ---------------------------------------------------------------- security

# Another local user can create sockets in /tmp. The old /tmp/omamap-$USER
# socket let them receive every path this user opened with `omamap FILE`.
squat=/tmp/omamap-${USER:-user}-$OMAMAP_INSTANCE
received=$(mktemp)
python3 -c '
import socket, sys, os
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); s.settimeout(20)
try:
    c, _ = s.accept(); data = c.recv(65536); open(sys.argv[2], "wb").write(data)
except socket.timeout: pass
os.unlink(sys.argv[1])' "$squat" "$received" &
squatter=$!
sleep 1
out=$(OMAMAP_SELFTEST=1 timeout -k 5 60 "$bin" $fix/cafes.geojson 2>> "$hostlog" | tail -1 || true)
kill $squatter 2>> "$hostlog" || true; wait $squatter 2>> "$hostlog" || true
rm -f "$squat"
if [[ ! -s $received && $out == *'cafes:2'* ]]; then
  echo "✔ a socket squatted in /tmp never receives opened paths"
else
  echo "✖ a socket squatted in /tmp never receives opened paths: squatter got '$(cat "$received")', app: $out"; fail=1
fi
rm -f "$received"

# File names may contain newlines; forwarding must not split them into two paths.
odd=$(mktemp -d)
cp $fix/cafes.geojson "$odd/odd"$'\n'"name.geojson"
log=$(mktemp)
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=8000 timeout -k 5 60 "$bin" $fix/park.geojson > "$log" 2>> "$hostlog" &
first=$!
sleep 3
sock=$(ls "$XDG_RUNTIME_DIR"/omamap-*.sock 2>> "$hostlog" | head -1 || true)
timeout -k 5 10 "$bin" "$odd/odd"$'\n'"name.geojson" 2>> "$hostlog" || true
wait $first || true
out=$(tail -1 "$log"); rm -rf "$log" "$odd"
if [[ -n $sock && $out == *'park:1'* && $out == *'odd\nname:2'* ]]; then
  echo "✔ the instance socket is in the runtime directory and forwards odd file names intact"
else
  echo "✖ the instance socket is in the runtime directory and forwards odd file names intact: socket '$sock', $out"; fail=1
fi

recent=$XDG_STATE_HOME/omamap/recent.json
if [[ $(stat -c %a "$recent" 2>> "$hostlog") == 600 && $(stat -c %a "$(dirname "$recent")" 2>> "$hostlog") == 700 ]]; then
  echo "✔ the recent-files list is private to the user"
else
  echo "✖ the recent-files list is private to the user: $(stat -c '%a %n' "$recent" "$(dirname "$recent")")"; fail=1
fi

# Page-level checks: headers, tokens, permissions, windows and navigation.
probe='(async function () {
  const r = [];
  const to = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 1500))]);
  const step = async (name, fn) => { try { r.push(name + "=" + await to(fn())); } catch (e) { r.push(name + "!" + e.name); } };
  await step("csp", () => fetch("index.html").then((x) => /frame-ancestors .none./.test(x.headers.get("content-security-policy")) && x.headers.get("x-content-type-options")));
  await step("guess", () => fetch("omamap://app/file/1/park.geojson").then((x) => x.status));
  await step("clipboard", () => navigator.clipboard.readText());
  await step("geo", () => new Promise((ok) => navigator.geolocation.getCurrentPosition(() => ok("granted"), (e) => ok("code" + e.code))));
  await step("notify", () => Notification.requestPermission());
  await step("popup", async () => window.open("https://example.com/popup") === null);
  const click = (href) => { const a = document.createElement("a"); a.href = href; document.body.appendChild(a); a.click(); a.remove(); };
  click("file:///etc/passwd"); click("steam://run/1"); click("omamap://app/vendor/leaflet.js"); click("https://example.com/link");
  setTimeout(() => toast("probe " + r.join(" "), "", "err"), 1500);
})();'
log=$(mktemp)
out=$(OMAMAP_DEBUG=1 QT_FORCE_STDERR_LOGGING=1 OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_DELAY=12000 \
  OMAMAP_SELFTEST_JS="$probe" timeout -k 5 60 "$bin" --new-window $fix/park.geojson 2>"$log" | tail -1)
token_url=$(grep -o 'omamap://app/file/[0-9a-zA-Z]*/park.geojson' "$log" | head -1 || true)
external=$(grep -o '\[open-external\] .*' "$log" | tr '\n' ' ' || true)
want='csp=nosniff guess=404 clipboard!NotAllowedError geo=code1 notify=denied popup=true'
if [[ $out == *"probe $want"* && $out == *'park:1'* && $token_url =~ /file/[0-9a-f]{32}/ && $external == '[open-external] https://example.com/link ' ]]; then
  echo "✔ the host locks down headers, file tokens, permissions, windows and navigation"
else
  echo "✖ the host locks down headers, file tokens, permissions, windows and navigation:"
  echo "    page: $out"; echo "    file url: $token_url"; echo "    opened externally: $external"; fail=1
fi
rm -f "$log"
exit $fail
