"use strict";
/* The Omarchy bar widget runs unsandboxed inside the desktop shell, and
   `omarchy plugin add` clones this whole repository. These tests run the
   widget's JavaScript functions against hostile recent.json entries and
   check what the plugin exposes to the shell. Usage: node --test tests/ */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const QML = fs.readFileSync(path.join(ROOT, "omarchy-plugin", "BarWidget.qml"), "utf8");

// Pull a top-level `function name(...) { ... }` out of the QML by brace matching.
function extract(name) {
  const start = QML.indexOf("  function " + name + "(");
  assert.ok(start >= 0, "widget defines " + name + "()");
  let depth = 0, i = QML.indexOf("{", start);
  for (; i < QML.length; i++) {
    if (QML[i] === "{") depth++;
    else if (QML[i] === "}" && --depth === 0) break;
  }
  return QML.slice(start, i + 1);
}

// The widget's functions bound to a stand-in for the QML root and Quickshell.
function widget(env) {
  const launched = [];
  const root = { maxItems: 15, installed: true, popupOpen: false, homepage: "https://github.com/thebytorsnowdog/omamap", recent: [],
    bar: { run: (cmd) => launched.push({ shell: cmd }), shellQuote: (v) => "'" + String(v || "").replace(/'/g, "'\\''") + "'" } };
  const Quickshell = { env: (k) => env[k], execDetached: (argv) => launched.push({ argv: argv }) };
  const names = ["clean", "tidyFolder", "applyRecent", "openOmaMap"].filter((n) => QML.includes("  function " + n + "("));
  const body = names.map(extract).join("\n") + "\nreturn {" + names.map((n) => n + ": " + n).join(", ") + "};";
  const fns = new Function("root", "Quickshell", body)(root, Quickshell);
  Object.assign(root, fns);
  return { root, launched };
}

const HOSTILE = [
  "/tmp/a'$(touch /tmp/pwned)'.geojson",
  "/tmp/`id`.geojson",
  "/tmp/$HOME;rm -rf ~.geojson",
  "/tmp/--new-window.geojson",
  "/tmp/\"quoted\" & spaced.geojson"
];

test("recent paths are launched as one argv element after --, never through a shell", () => {
  const { root, launched } = widget({ HOME: "/home/me" });
  root.applyRecent(JSON.stringify({ version: 1, recent: HOSTILE.map((p) => ({ path: p, kind: "data" })) }));
  assert.equal(root.recent.length, HOSTILE.length);
  root.recent.forEach((r) => root.openOmaMap(r.path));
  assert.deepEqual(launched, HOSTILE.map((p) => ({ argv: ["omamap", "--", p] })));
  root.openOmaMap("");
  assert.deepEqual(launched.pop(), { argv: ["omamap"] });
});

test("the not-installed link opens without a shell too", () => {
  const { root, launched } = widget({ HOME: "/home/me" });
  root.installed = false;
  root.openOmaMap("/tmp/x.geojson");
  assert.deepEqual(launched, [{ argv: ["xdg-open", "https://github.com/thebytorsnowdog/omamap"] }]);
});

test("recent entries that are relative, multi-line, oversized or malformed are dropped", () => {
  const { root } = widget({ HOME: "/home/me" });
  root.applyRecent(JSON.stringify({ recent: [
    { path: "-rf.geojson" }, { path: "relative/x.geojson" }, { path: "/tmp/a\nb.geojson" }, { path: "/tmp/\u0000x" },
    { path: "/" + "a".repeat(5000) }, { path: 42 }, null, "string", { path: "/home/me/maps/ok.geojson", name: "<b>ok</b>\u0007", kind: "profile" }
  ] }));
  assert.deepEqual(root.recent, [{ path: "/home/me/maps/ok.geojson", name: "<b>ok</b> ", folder: "~/maps", profile: true }]);
  root.applyRecent("x".repeat(300000));
  assert.deepEqual(root.recent, []);
  root.applyRecent("{not json");
  assert.deepEqual(root.recent, []);
});

test("only the home directory itself is shortened to ~", () => {
  const { root } = widget({ HOME: "/home/me" });
  assert.equal(root.tidyFolder("/home/me/maps"), "~/maps");
  assert.equal(root.tidyFolder("/home/me"), "~");
  assert.equal(root.tidyFolder("/home/meadow/maps"), "/home/meadow/maps");
  assert.equal(root.tidyFolder("/srv/home/me/x"), "/srv/home/me/x");
  assert.equal(widget({}).root.tidyFolder("/tmp"), "/tmp");
});

test("the plugin exposes only the bar widget to the shell", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.kinds, ["bar-widget"]);
  assert.deepEqual(manifest.entryPoints, { barWidget: "omarchy-plugin/BarWidget.qml" });
  // QML resolves sibling types and qmldir files from the widget's directory.
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "omarchy-plugin")), ["BarWidget.qml"]);
  // Nothing else in the clone is QML the shell could pick up.
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(tracked.filter((f) => /\.qml$|(^|\/)qmldir$/.test(f)), ["omarchy-plugin/BarWidget.qml"]);
  assert.equal(tracked.filter((f) => f.endsWith("manifest.json")).length, 1);
});
