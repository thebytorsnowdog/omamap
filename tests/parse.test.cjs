"use strict";
/* Parser and validation tests, run in Node against the same vendored
   libraries the app ships. Usage: node --test tests/ */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const core = path.join(__dirname, "..", "core");
globalThis.self = globalThis;
globalThis.fflate = require(path.join(core, "vendor/fflate.js"));
globalThis.shp = require(path.join(core, "vendor/shp.js"));
globalThis.Papa = require(path.join(core, "vendor/papaparse.min.js"));
const P = require(path.join(core, "parse.js"));

const fixture = (name) => {
  const b = fs.readFileSync(path.join(__dirname, "fixtures", name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};
const bytes = (s) => new TextEncoder().encode(s).buffer;

/* Minimal ZIP writer for tests: stored or deflated entries, optional data
   descriptors (as macOS Finder writes them). */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files, { descriptor = false } = {}) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const flags = descriptor ? 0x0008 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(descriptor ? 0 : crc, 14); lh.writeUInt32LE(descriptor ? 0 : comp.length, 18); lh.writeUInt32LE(descriptor ? 0 : data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const parts = [lh, nameBuf, comp];
    if (descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(data.length, 12);
      parts.push(dd);
    }
    const local = Buffer.concat(parts);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length, 8); end.writeUInt16LE(centrals.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...locals, central, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const POINT_FC = JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "Point", coordinates: [-3.19, 55.95] }, properties: { name: "Edinburgh" } }] });

test("GeoJSON file parses into one dataset", async () => {
  const [ds] = await P.parseBytes("places.geojson", bytes(POINT_FC));
  assert.equal(ds.name, "places");
  assert.equal(ds.geojson.features.length, 1);
  assert.equal(ds.geojson.features[0].properties.name, "Edinburgh");
});

test("bare geometry and single Feature are normalised", () => {
  const fc = P.validateFeatureCollection({ type: "LineString", coordinates: [[0, 0], [1, 1]] });
  assert.equal(fc.features.length, 1);
  assert.deepEqual(fc.features[0].properties, {});
});

test("GeoJSON rejects bad geometry", () => {
  assert.throws(() => P.validateFeatureCollection({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /closed/);
  assert.throws(() => P.validateFeatureCollection({ type: "Point", coordinates: [400000, 600000] }), /WGS84/);
  assert.throws(() => P.validateFeatureCollection({ type: "Point", coordinates: ["1", "2"] }), /finite numbers/);
  assert.throws(() => P.validateFeatureCollection({ type: "FeatureCollection", features: [] }), /no features/);
});

test("prototype-pollution property names are rejected", () => {
  const evil = '{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"__proto__":{"x":1}}}';
  assert.throws(() => P.jsonToGeoJSON(evil), /unsafe property/);
  assert.throws(() => P.csvToGeoJSON("lat,lon,constructor\n1,2,3\n"), /unsafe CSV header/);
});

test("CSV with lat/lon builds points and keeps cells as strings", async () => {
  const [ds] = await P.parseBytes("sites.csv", bytes("Site ID,Latitude,Longitude\n007,55.9,-3.2\n008,56.1,-3.9\n"));
  assert.equal(ds.geojson.features.length, 2);
  assert.equal(ds.geojson.features[0].properties["Site ID"], "007");
  assert.deepEqual(ds.geojson.features[1].geometry.coordinates, [-3.9, 56.1]);
});

test("CSV rejects partial numbers, ragged rows and easting/northing", () => {
  assert.throws(() => P.csvToGeoJSON("lat,lon\n55.9abc,-3.2\n"), /complete numeric/);
  assert.throws(() => P.csvToGeoJSON("lat,lon\n55.9,-3.2,extra\n"), /number of cells|malformed/);
  assert.throws(() => P.csvToGeoJSON("easting,northing\n325000,673000\n"), /Easting\/northing/);
});

test("zipped shapefile fixture loads one point", async () => {
  const layers = await P.parseBytes("point.zip", fixture("point.zip"));
  assert.equal(layers.length, 1);
  assert.equal(layers[0].geojson.features.length, 1);
});

test("shapefile with .prj is reprojected to WGS84", async () => {
  const layers = await P.parseBytes("projected.zip", fixture("projected-components.zip"));
  const [lon, lat] = layers[0].geojson.features[0].geometry.coordinates;
  assert.ok(lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90);
});

test("method-name entry ZIP still imports", async () => {
  const layers = await P.parseBytes("method-name.zip", fixture("method-name.zip"));
  assert.equal(layers[0].geojson.features.length, 1);
});

test("hostile ZIPs are rejected", async () => {
  await assert.rejects(P.parseBytes("bomb.zip", fixture("expanded.zip")), /ratio|expands|limit/i);
  await assert.rejects(P.parseBytes("cd.zip", fixture("central-directory-disagreement.zip")), /overlap|disagree|unlisted/i);
  await assert.rejects(P.parseBytes("cd8.zip", fixture("central-directory-disagreement-utf8.zip")), /overlap|disagree|unlisted/i);
  await assert.rejects(P.parseBytes("junk.zip", bytes("not a zip at all, definitely not")), /ZIP/);
});

test("ZIP with data descriptors (macOS Finder style) is accepted", async () => {
  const zip = makeZip({ "layer.geojson": POINT_FC }, { descriptor: true });
  const layers = await P.parseBytes("finder.zip", zip);
  assert.equal(layers[0].geojson.features[0].properties.name, "Edinburgh");
});

test("data descriptor that disagrees is rejected", async () => {
  const zip = new Uint8Array(makeZip({ "layer.geojson": POINT_FC }, { descriptor: true }));
  const dv = new DataView(zip.buffer);
  // Find the descriptor signature and corrupt its CRC.
  for (let i = 0; i < zip.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x08074b50) { dv.setUint32(i + 4, 0xdeadbeef, true); break; }
  }
  await assert.rejects(P.parseBytes("bad.zip", zip.buffer), /descriptor/);
});

test("ZIP with several layers returns one dataset per layer", async () => {
  const other = POINT_FC.replace("Edinburgh", "Glasgow");
  const layers = await P.parseBytes("bundle.zip", makeZip({ "a.geojson": POINT_FC, "b.geojson": other, "readme.txt": "hi" }));
  assert.deepEqual(layers.map((l) => l.name), ["bundle / a", "bundle / b"]);
});

test("loose shapefile parts parse as a set", async () => {
  const entries = P.extractZip(fixture("projected-components.zip"));
  const parts = {};
  for (const [name, data] of entries) {
    const ext = P.extOf(name);
    if (P.SHAPE_PARTS.includes(ext)) parts[ext] = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  assert.ok(parts.shp && parts.prj);
  const [ds] = await P.parseShapefileSet("roads", parts);
  assert.equal(ds.name, "roads");
  assert.ok(ds.geojson.features.length >= 1);
  assert.deepEqual(ds.warnings, []);
});
