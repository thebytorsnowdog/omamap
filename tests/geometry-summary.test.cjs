"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("nested geometry collections expose their leaf types and receive polygon defaults", () => {
  const context = vm.createContext({ document: { addEventListener() {} }, window: {} });
  for (const name of ["style.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", name), "utf8"), context);
  }
  vm.runInContext("this.summary = geometrySummary; this.defaults = defaultStyle;", context);
  const polygon = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] };
  const geojson = { features: [{ geometry: { type: "GeometryCollection", geometries: [
    { type: "GeometryCollection", geometries: [polygon, { type: "Point", coordinates: [0, 0] }] },
    polygon
  ] } }] };
  const geomTypes = context.summary(geojson);
  assert.deepEqual(Array.from(geomTypes), ["Polygon", "Point"]);
  const style = context.defaults({ geomTypes });
  assert.equal(style.fillOpacity, 0.35, "nested polygons should remain translucent");
  assert.equal(style.weight, 2);
});
