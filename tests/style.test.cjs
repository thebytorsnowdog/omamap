"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "core", "style.js"), "utf8");
const context = {
  STATE: {
    palette: ["#111111", "#222222", "#333333", "#444444"],
    themeColors: { green: "#00aa00", yellow: "#aaaa00", red: "#aa0000" },
    themeVersion: 1
  },
  isHex: (value) => /^#[0-9a-f]{6}$/i.test(value),
  cssVar: (name) => name,
  console,
  Intl,
  Map,
  Set,
  Uint16Array
};
vm.createContext(context);
vm.runInContext(source + `\nthis.StyleTest = {
  CLASS_OTHER, CLASS_MISSING, fieldIsNumeric, setColourBy, featureColour
};`, context);
const S = context.StyleTest;
const dataset = (values) => ({
  features: values.map((value) => ({ properties: { value } })),
  style: { byField: null },
  classOf: null
});

test("semantic categories are normalised, counted and use theme meanings", () => {
  const ds = dataset(["OVERDUE", "Completed", " pending ", "completed", null]);
  S.setColourBy(ds, "value", "categories", false);

  assert.deepEqual(Array.from(ds.style.byField.classes, (c) => [c.key, c.count, c.meaning]), [
    ["completed", 2, "good"], ["pending", 1, "warn"], ["overdue", 1, "bad"]
  ]);
  assert.equal(ds.style.byField.missingCount, 1);
  assert.equal(S.featureColour(ds, 0), "#aa0000");
  assert.equal(S.featureColour(ds, 1), "#00aa00");
  assert.equal(S.featureColour(ds, 2), "#aaaa00");
});

test("category classification keeps the 24 most common values and groups the rest", () => {
  const values = [];
  for (let i = 0; i < 30; i++) for (let n = 0; n <= i; n++) values.push("category-" + i);
  const ds = dataset(values);
  S.setColourBy(ds, "value", "categories", false);

  assert.equal(ds.style.byField.classes.length, 24);
  assert.equal(ds.style.byField.classes[0].key, "category 29");
  assert.equal(ds.style.byField.otherCount, 1 + 2 + 3 + 4 + 5 + 6);
  assert.equal(ds.classOf[0], S.CLASS_OTHER);
});

test("numeric ranges use deterministic quantiles and include the maximum", () => {
  const ds = dataset([1, "2", 3, 4, 5, 6, 7, 8, 9, 10, "not a number", ""]);
  assert.equal(S.fieldIsNumeric(ds, "value"), false, "mixed fields are not offered as numeric");

  // Seven values make floor and ceil quantile selection produce different
  // breaks. The implementation deliberately selects indices 1, 2, 4 and 5.
  const numeric = dataset([1, "2", 3, 4, 5, 6, 7, null]);
  assert.equal(S.fieldIsNumeric(numeric, "value"), true);
  S.setColourBy(numeric, "value", "ranges", false);

  assert.equal(numeric.style.byField.classes.length, 5);
  assert.deepEqual(Array.from(numeric.style.byField.classes, (c) => [c.min, c.max, c.count]), [
    [1, 2, 1], [2, 3, 1], [3, 5, 2], [5, 6, 1], [6, 7, 2]
  ]);
  assert.equal(numeric.classOf[6], 4, "the inclusive final range contains the maximum");
  assert.equal(numeric.classOf[7], S.CLASS_MISSING);
});

test("numeric categories preserve negative signs and scientific exponents in ramp order", () => {
  const ds = dataset([-10, -2, -1, 0, "1e-3", 1, 2, 10]);
  S.setColourBy(ds, "value", "categories", false);
  assert.deepEqual(Array.from(ds.style.byField.classes, (c) => c.key), ["-10", "-2", "-1", "0", "1e-3", "1", "2", "10"]);
  assert.equal(ds.style.byField.colouring, "ramp");
  assert.deepEqual(Array.from(ds.classOf), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("semantic category labels still normalize hyphens and underscores", () => {
  const ds = dataset(["out-of-service", "out_of_service", "OUT OF SERVICE", "in service"]);
  S.setColourBy(ds, "value", "categories", false);
  assert.deepEqual(Array.from(ds.style.byField.classes, (c) => [c.key, c.count, c.meaning]), [
    ["in service", 1, "good"], ["out of service", 3, "bad"]
  ]);
});
