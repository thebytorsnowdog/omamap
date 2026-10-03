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

test("a wide four-vertex box preserves the established spherical area", () => {
  const wide = [[[-100, 0], [100, 0], [100, 10], [-100, 10], [-100, 0]]];
  const area = M.polygonArea(wide);

  // Regression value from the implementation on main. In particular, do not
  // wrap the i/i+2 longitude difference as though it were a polygon edge.
  assert.ok(Math.abs(area - 24658421971425.824) < 0.01, String(area));
  assert.equal(M.measureGeometry({ type: "Polygon", coordinates: wide }).area, area);
});

test("polygon holes are subtracted from the outer ring", () => {
  const outer = [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]];
  const hole = [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]];
  const area = M.polygonArea([outer, hole]);

  assert.equal(area, M.polygonArea([outer]) - M.polygonArea([hole]));
  assert.equal(M.measureGeometry({ type: "Polygon", coordinates: [outer, hole] }).area, area);
});
