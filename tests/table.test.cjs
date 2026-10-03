"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function table(properties, overrides = {}) {
  const elements = new Map();
  const context = vm.createContext({
    performance: { now: () => 0 }, setTimeout,
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    el(id) {
      if (!elements.has(id)) elements.set(id, { style: {}, scrollWidth: 400 });
      return elements.get(id);
    },
    plural: (n, word) => n + " " + word + (n === 1 ? "" : "s"),
    ...overrides
  });
  for (const name of ["style.js", "table.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", name), "utf8"), context);
  }
  vm.runInContext("this.table = Table;", context);
  context.table.ds = { features: properties.map((p) => ({ properties: p })) };
  return { table: context.table, elements };
}

test("table sorts numbers and numeric strings stably with missing values last in either direction", async () => {
  const { table: t } = table([
    { value: "10" }, { value: null }, { value: 2 }, { value: "2" }, {}, { value: "" }, { value: -1 }
  ]);
  t.sort = { field: "value", dir: 1 };
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [6, 2, 3, 0, 1, 4, 5]);
  t.sort.dir = -1;
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [0, 2, 3, 6, 1, 4, 5]);
  t.sort = null;
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [0, 1, 2, 3, 4, 5, 6], "reset restores file order");
});

test("table search includes nested values, ignores case, and combines with view filtering", async () => {
  const { table: t, elements } = table([
    { name: "Main ROAD", metadata: { owner: "Council" } },
    { name: "Road outside the map" },
    { name: "footpath", metadata: { route: "ROAD" } },
    { name: "canal" }
  ]);
  t.ds.layers = [{ visible: true }, { visible: false }, { visible: true }, { visible: true }];
  t.inView = true;
  t.inViewTest = () => (layer) => layer.visible;
  t.query = "  rOAd  ";
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [0, 2]);
  assert.equal(elements.get("tp-count").textContent, "2 of 4 rows");
  t.inView = false;
  t.query = "COUNCIL";
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [0]);
  t.query = "";
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [0, 1, 2, 3]);
});

test("table uses natural text sorting without inheriting missing prototype fields", async () => {
  const { table: t } = table([
    { toString: "Road 10" }, {}, { toString: "road 2" }, { toString: "Road 1" }
  ]);
  t.sort = { field: "toString", dir: 1 };
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [3, 2, 0, 1]);
});

test("large table sorts merge all runs and preserve equal-value file order", async () => {
  const values = Array.from({ length: 6200 }, (_, i) => ({ value: (6200 - i) % 37 }));
  const { table: t } = table(values);
  t.sort = { field: "value", dir: 1 };
  await t.refilter();
  assert.equal(t.order.length, values.length);
  assert.equal(new Set(t.order).size, values.length);
  for (let i = 1; i < t.order.length; i++) {
    const a = t.order[i - 1], b = t.order[i];
    assert.ok(values[a].value < values[b].value || (values[a].value === values[b].value && a < b));
  }
});

test("a superseded cooperative search cannot overwrite the latest results", async () => {
  const timers = [];
  let now = 0;
  const { table: t } = table(Array.from({ length: 300 }, (_, i) => ({ name: i === 299 ? "latest" : "old" })), {
    performance: { now: () => now },
    setTimeout(fn) { timers.push(fn); }
  });
  const rowText = t.rowText;
  let useBudget = true;
  t.rowText = function (i) {
    if (useBudget && i === 0) now += 10;
    return rowText.call(this, i);
  };
  t.query = "old";
  const stale = t.refilter();
  assert.equal(timers.length, 1, "the older search yielded on its time budget");
  assert.equal(t.order, null, "partial results stay unpublished");
  useBudget = false;
  t.query = "latest";
  await t.refilter();
  assert.deepEqual(Array.from(t.order), [299]);
  timers.shift()();
  await stale;
  assert.deepEqual(Array.from(t.order), [299], "resuming the stale search preserves the newer results");
});
