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

# CI uses xcb under Xvfb: WebEngine's widget compositor needs an OpenGL
# context even when Chromium GPU acceleration is disabled.
export QT_QPA_PLATFORM=${QT_QPA_PLATFORM:-offscreen} QT_FORCE_STDERR_LOGGING=1 QTWEBENGINE_CHROMIUM_FLAGS=--disable-gpu
# Throwaway browser profile, recent list and settings.
scratch=$(mktemp -d)
export XDG_DATA_HOME=$scratch/data XDG_CACHE_HOME=$scratch/cache XDG_STATE_HOME=$scratch/state XDG_CONFIG_HOME=$scratch/config
mkdir -p "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$XDG_CONFIG_HOME"
export OMAMAP_INSTANCE=smoke-$$   # never talk to the user's running OmaMap
# A private runtime directory too: the single-instance socket lives there.
export XDG_RUNTIME_DIR=$scratch/runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# Nothing here may reach the desktop: links the app hands out are only logged.
fakebin=$scratch/bin
mkdir -p "$fakebin"
printf '#!/bin/sh\necho "$*" >> "%s/opened"\n' "$fakebin" > "$fakebin/xdg-open"
chmod +x "$fakebin/xdg-open"
export PATH=$fakebin:$PATH BROWSER=true
cleanup() {
  local status=$?
  if (( status != 0 )) && [[ -f ${hostlog:-} ]]; then
    echo "Native host diagnostics:" >&2
    tail -100 "$scratch"/*.stderr >&2
  fi
  local child
  for child in $(jobs -pr); do kill "$child" 2>/dev/null || true; done
  [[ -z ${squat:-} ]] || rm -f "$squat"
  rm -rf "$scratch"
}
trap cleanup EXIT
hostlog=$scratch/host.stderr
: > "$hostlog"
wait_ready() { node tests/host-wait.cjs "$1" "${2:-OMAMAP_SELFTEST_READY}"; }
fail=0

out=$(OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 5 && document.getElementById("loading").hidden' timeout -k 5 60 "$bin" --new-window $fix/park.geojson $fix/walk.gpx $fix/stations.csv \
  tests/fixtures/point.zip $fix/loose/projected.shp $fix/loose/projected.dbf $fix/loose/projected.prj 2>> "$hostlog" | tail -1)
if [[ $out == *'"worker":true'* && $out == *'park:1'* && $out == *'walk:1'* && $out == *'stations:2'* && $out == *'point:1'* && $out == *'projected:1'* && $out == *'"errors":[]'* ]]; then
  echo "✔ command-line files load through the host"
else
  echo "✖ command-line files load through the host: $out"; fail=1
fi

log=$(mktemp "$scratch/page.XXXXXX")
readylog=$(mktemp "$scratch/ready.XXXXXX.stderr")
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 2 && document.getElementById("loading").hidden' timeout -k 5 60 "$bin" $fix/park.geojson > "$log" 2> "$readylog" &
first=$!
wait_ready "$readylog"
timeout -k 5 10 "$bin" $fix/cafes.geojson 2>> "$hostlog"
wait "$first"
cat "$readylog" >> "$hostlog"
out=$(tail -1 "$log"); rm -f "$log"
if [[ $out == *'park:1'* && $out == *'cafes:2'* ]]; then
  echo "✔ second launch forwards files to the running window"
else
  echo "✖ second launch forwards files to the running window: $out"; fail=1
fi

# Save a profile through the desktop save path, then reopen it from the command line.
saved=$XDG_DATA_HOME/smoke.omamap
out=$(OMAMAP_SAVE_PATH=$saved OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='window.savedByHost === true' \
  OMAMAP_SELFTEST_JS='const saved = window.OmaMap.profileSaved; window.OmaMap.profileSaved = function (path) { saved(path); window.savedByHost = true; }; loadQueue.then(() => saveProfile());' \
  timeout -k 5 60 "$bin" --new-window $fix/park.geojson $fix/stations.csv 2>> "$hostlog" | tail -1)
recent=$XDG_STATE_HOME/omamap/recent.json
if [[ -s $saved ]] && jq -e '.recent[0].kind == "profile" and (.recent[0].path | endswith("/smoke.omamap"))
    and any(.recent[]; .name == "park.geojson")' "$recent" >/dev/null 2>&1; then
  echo "✔ saving a profile writes the file and the recent list"
else
  echo "✖ saving a profile writes the file and the recent list: $(ls -la "$saved" 2>&1) $(cat "$recent" 2>&1)"; fail=1
fi
out=$(OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 2 && document.getElementById("loading").hidden' timeout -k 5 60 "$bin" --new-window "$saved" 2>> "$hostlog" | tail -1)
if [[ $out == *'park:1'* && $out == *'stations:2'* && $out == *'"errors":[]'* ]]; then
  echo "✔ a saved profile reopens from the command line"
else
  echo "✖ a saved profile reopens from the command line: $out"; fail=1
fi

# Kill the page's renderer process: the app must reload the page and say so.
log=$(mktemp "$scratch/page.XXXXXX")
crashlog=$(mktemp "$scratch/crash.XXXXXX.stderr")
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='Array.from(document.querySelectorAll(".toast")).some(t => t.textContent.includes("OmaMap recovered"))' timeout -k 5 60 "$bin" --new-window $fix/park.geojson > "$log" 2> "$crashlog" &
app=$!
# A readiness marker proves a live page exists; the completion condition
# waits for the recovered page's actual notice.
wait_ready "$crashlog"
descendants() { local p; for p in $(pgrep -P "$1"); do echo "$p"; descendants "$p"; done; }
renderer=$(for p in $(descendants "$app"); do grep -qa -- '--type=renderer' /proc/$p/cmdline 2>> "$hostlog" && echo "$p"; done | head -1 || true)
[[ -n $renderer ]] && kill -9 "$renderer"
wait "$app"
cat "$crashlog" >> "$hostlog"; rm -f "$crashlog"
out=$(tail -1 "$log"); rm -f "$log"
if [[ -n $renderer && $out == *'OmaMap recovered'* ]]; then
  echo "✔ a crashed page reloads with a notice"
else
  echo "✖ a crashed page reloads with a notice (renderer pid: ${renderer:-none}): $out"; fail=1
fi

# Live theme switch: replace the theme directory the way omarchy-theme-set does.
themes=$scratch/themes
mkdir -p "$themes/current/theme"
printf 'mode = "dark"\nbackground = "#101010"\naccent = "#ff8800"\n' > "$themes/current/theme/colors.toml"
log=$(mktemp "$scratch/page.XXXXXX")
readylog=$(mktemp "$scratch/ready.XXXXXX.stderr")
OMAMAP_THEME_DIR="$themes/current/theme" OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.mode === "light" && STATE.basemapId === "light"' timeout -k 5 60 "$bin" --new-window > "$log" 2> "$readylog" &
first=$!
wait_ready "$readylog"
rm -rf "$themes/current/theme" && mkdir -p "$themes/current/theme"
printf 'mode = "light"\nbackground = "#fafafa"\naccent = "#0055ff"\n' > "$themes/current/theme/colors.toml"
wait "$first"
cat "$readylog" >> "$hostlog"
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
received=$scratch/received
: > "$received"
squatterlog=$scratch/squatter.stderr
: > "$squatterlog"
python3 -c '
import socket, sys, os
s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); s.settimeout(45)
print("SOCKET_READY", flush=True)
try:
    c, _ = s.accept(); data = c.recv(65536); open(sys.argv[2], "wb").write(data)
except socket.timeout: pass
os.unlink(sys.argv[1])' "$squat" "$received" > "$squatterlog" &
squatter=$!
wait_ready "$squatterlog" SOCKET_READY
out=$(OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 1 && document.getElementById("loading").hidden' timeout -k 5 60 "$bin" $fix/cafes.geojson 2>> "$hostlog" | tail -1 || true)
kill $squatter 2>> "$hostlog" || true; wait $squatter 2>> "$hostlog" || true
rm -f "$squat"
if [[ ! -s $received && $out == *'cafes:2'* ]]; then
  echo "✔ a socket squatted in /tmp never receives opened paths"
else
  echo "✖ a socket squatted in /tmp never receives opened paths: squatter got '$(cat "$received")', app: $out"; fail=1
fi
rm -f "$received"

# File names may contain newlines; forwarding must not split them into two paths.
odd=$scratch/odd
mkdir -p "$odd"
cp $fix/cafes.geojson "$odd/odd"$'\n'"name.geojson"
log=$(mktemp "$scratch/page.XXXXXX")
readylog=$(mktemp "$scratch/ready.XXXXXX.stderr")
OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 2 && document.getElementById("loading").hidden' timeout -k 5 60 "$bin" $fix/park.geojson > "$log" 2> "$readylog" &
first=$!
wait_ready "$readylog"
sock=$(ls "$XDG_RUNTIME_DIR"/omamap-*.sock 2>> "$hostlog" | head -1 || true)
timeout -k 5 10 "$bin" "$odd/odd"$'\n'"name.geojson" 2>> "$hostlog" || true
wait "$first"
cat "$readylog" >> "$hostlog"
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

# Installed binaries read the core next to themselves, never the checkout
# they were built from, and refuse a core other users could modify.
reloc=$scratch/reloc
mkdir -p "$reloc/bin" "$reloc/share/omamap"
cp "$bin" "$reloc/bin/omamap"
cp -r core "$reloc/share/omamap/core"
chmod 775 "$reloc/share/omamap/core"
refused=$(OMAMAP_SELFTEST=1 timeout -k 5 30 "$reloc/bin/omamap" --new-window 2>&1 | grep -c 'writable by other users' || true)
chmod 755 "$reloc/share/omamap/core"
out=$(OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='STATE.datasets.length === 1 && document.getElementById("loading").hidden' timeout -k 5 60 "$reloc/bin/omamap" --new-window $fix/park.geojson 2>> "$hostlog" | tail -1)
rm -rf "$reloc"
if (( refused > 0 )) && [[ $out == *'park:1'* ]]; then
  echo "✔ an installed binary only loads a core other users cannot change"
else
  echo "✖ an installed binary only loads a core other users cannot change: refused=$refused, $out"; fail=1
fi

# Page-level checks: headers, tokens, permissions, windows and navigation.
probe='(async function () {
  const r = [];
  // Record the file URL the host hands over (a second launch sends park.geojson).
  let receivedFile;
  const shared = new Promise((resolve) => { receivedFile = resolve; });
  const realFetch = window.fetch;
  window.fetch = function (u) {
    const response = realFetch.apply(this, arguments);
    if (/\/file\/[0-9a-f]{32}\//.test(String(u))) response.then(() => receivedFile(String(u)));
    return response;
  };
  console.log("OMAMAP_PROBE_READY");
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
  const url = await shared;
  await step("reuse", () => realFetch(url).then((x) => x.status));
  await loadQueue;
  toast("probe " + r.join(" "), "", "err");
  window.probeDone = true;
})();'
log=$(mktemp "$scratch/probe.XXXXXX.stderr")
page=$(mktemp "$scratch/page.XXXXXX")
OMAMAP_DEBUG=1 QT_FORCE_STDERR_LOGGING=1 OMAMAP_SELFTEST=1 OMAMAP_SELFTEST_WAIT='window.probeDone === true' \
  OMAMAP_SELFTEST_JS="$probe" timeout -k 5 60 "$bin" > "$page" 2>"$log" &
first=$!
wait_ready "$log" OMAMAP_PROBE_READY
timeout -k 5 10 "$bin" $fix/park.geojson 2>> "$hostlog" || true
wait "$first"
out=$(tail -1 "$page"); rm -f "$page"
token_url=$(grep -oE 'omamap://app/file/[0-9a-f]{32}/park.geojson' "$log" | head -1 || true)
external=$(grep -o '\[open-external\] .*' "$log" | tr '\n' ' ' || true)
want='csp=nosniff guess=404 clipboard!NotAllowedError geo=code1 notify=denied popup=true reuse=404'
if [[ $out == *"probe $want"* && $out == *'park:1'* && $token_url =~ /file/[0-9a-f]{32}/ && $external == '[open-external] https://example.com/link ' ]]; then
  echo "✔ the host locks down headers, single-use file tokens, permissions, windows and navigation"
else
  echo "✖ the host locks down headers, single-use file tokens, permissions, windows and navigation:"
  echo "    page: $out"; echo "    file url: $token_url"; echo "    opened externally: $external"; fail=1
fi
rm -f "$log"
exit $fail
