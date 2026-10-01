"use strict";
/* The bundled libraries must be exactly the reviewed releases. Their SHA-256
   hashes are pinned in core/vendor/SHA256SUMS (checked here and by the
   PKGBUILD's check()); updating a library means updating that file. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const VENDOR = path.join(__dirname, "..", "core", "vendor");

// Leaflet 1.9.4, PapaParse 5.4.1, fflate 0.8.3, shpjs 6.2.0, @tmcw/togeojson 5.1.2.
const EXPECTED = {
  "fflate.js": "462ef8041fc970e3615a20a9dd2b2e3047a073b2da729ef4f02b634bba8b7b83",
  "leaflet.css": "a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6",
  "leaflet.js": "db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a",
  "papaparse.min.js": "b8e870c5d2b29772f10c9fa9a693c8b896aac8540ed6701e3cc6304c683febdb",
  "shp.js": "7a41a70f4509b5d60c8c2516597e93ddc2eff1c9b052a8179be09e34d0a98a58",
  "togeojson.umd.js": "a0ebe44ff40f1cfc71dc6eafcaa0c083687fc26298d743d042c0a37335da8768"
};

test("vendored libraries match their pinned SHA-256 hashes", () => {
  const sums = Object.fromEntries(fs.readFileSync(path.join(VENDOR, "SHA256SUMS"), "utf8").trim().split("\n")
    .map((line) => line.split(/\s+\*?/)).map(([hash, name]) => [name, hash]));
  assert.deepEqual(sums, EXPECTED);
  for (const [name, hash] of Object.entries(EXPECTED)) {
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(VENDOR, name))).digest("hex"), hash, name);
  }
});

test("no unpinned code is vendored", () => {
  const files = fs.readdirSync(VENDOR).filter((f) => fs.statSync(path.join(VENDOR, f)).isFile() && f !== "SHA256SUMS");
  assert.deepEqual(files.sort(), Object.keys(EXPECTED).sort());
});
