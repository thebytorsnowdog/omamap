"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function scheduler() {
  const frames = [], applied = [];
  const ds = { name: "points" };
  const context = vm.createContext({
    STATE: { datasets: [ds] },
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    applyDatasetStyle: (value) => applied.push(value.name),
    highlightSelection() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", "style.js"), "utf8") + `
    renderLegend = function () {};
    refreshSwatches = function () {};
    this.scheduler = { scheduleRestyle, restyleIdle };
  `, context);
  return { ...context.scheduler, ds, applied, frame: () => frames.shift()() };
}

test("restyle idle waits for the paint frame even when called after applying styles", async () => {
  const s = scheduler();
  s.scheduleRestyle(s.ds);
  s.scheduleRestyle(s.ds);
  s.frame();
  assert.deepEqual(s.applied, ["points"], "duplicate requests are coalesced");
  let idle = false;
  const pending = s.restyleIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false, "the map redraw has not painted yet");
  s.frame();
  await pending;
  assert.equal(idle, true);
});

test("restyle idle waits for changes queued before an earlier paint finishes", async () => {
  const s = scheduler();
  s.scheduleRestyle(s.ds);
  let idle = false;
  const pending = s.restyleIdle().then(() => { idle = true; });
  s.frame();
  s.scheduleRestyle(s.ds);
  s.frame(); // First paint; the second restyle is still queued.
  await Promise.resolve();
  assert.equal(idle, false);
  s.frame(); // Second restyle.
  await Promise.resolve();
  assert.equal(idle, false);
  s.frame(); // Second paint.
  await pending;
  assert.deepEqual(s.applied, ["points", "points"]);
  assert.equal(idle, true);
});
