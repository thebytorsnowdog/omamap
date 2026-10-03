"use strict";
// Wait for a host/squatter readiness marker. Subscribe before reading so a
// write between the initial read and watcher setup cannot be missed.
const fs = require("node:fs");
const [file, marker] = process.argv.slice(2);
if (!file || !marker) throw new Error("Usage: node tests/host-wait.cjs LOG MARKER");
let watcher, deadline;
function finish(code) {
  clearTimeout(deadline);
  watcher.close();
  process.exitCode = code;
}
function check() {
  if (fs.readFileSync(file, "utf8").includes(marker)) finish(0);
}
watcher = fs.watch(file, check);
deadline = setTimeout(() => {
  console.error("Timed out waiting for " + JSON.stringify(marker) + " in " + file);
  finish(1);
}, 30000);
check();
