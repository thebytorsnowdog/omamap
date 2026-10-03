"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "core", "app.js"), "utf8");
const context = {
  document: { addEventListener() {} },
  window: {},
  console,
  Map,
  Set,
  Uint16Array,
  Float64Array,
  URL,
  TextDecoder,
  TextEncoder,
  Blob,
  performance
};
vm.createContext(context);
vm.runInContext(source + "\nthis.MeasureTest = { lineLength, polygonArea, measureGeometry };", context);
const M = context.MeasureTest;

test("line length follows the short route across the antimeridian", () => {
  const metres = M.lineLength([[179.9, 0], [-179.9, 0]]);
  assert.ok(metres > 22000 && metres < 22300, metres + " m");
});

test("polygon area remains local when a ring crosses the antimeridian", () => {
  const ordinary = [[[-0.1, 0], [0.1, 0], [0.1, 0.2], [-0.1, 0.2], [-0.1, 0]]];
  const crossing = [[[179.9, 0], [-179.9, 0], [-179.9, 0.2], [179.9, 0.2], [179.9, 0]]];
  const expected = M.polygonArea(ordinary);
  const actual = M.polygonArea(crossing);

  assert.ok(actual > 0);
  assert.ok(Math.abs(actual - expected) / expected < 1e-10, `${actual} versus ${expected}`);
  assert.equal(M.measureGeometry({ type: "Polygon", coordinates: crossing }).area, actual);
});
