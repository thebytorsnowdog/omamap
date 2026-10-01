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

test("CSV rejects partial numbers and ragged rows", () => {
  assert.throws(() => P.csvToGeoJSON("lat,lon\n55.9abc,-3.2\n"), /complete numeric/);
  assert.throws(() => P.csvToGeoJSON("lat,lon\n55.9,-3.2,extra\n"), /number of cells|malformed/);
  assert.throws(() => P.csvToGeoJSON("name,value\nA,1\n"), /coordinate columns/);
});

// Reference values from PROJ (pyproj, EPSG:27700 -> EPSG:4326).
const BNG_REFERENCE = {
  "Edinburgh Castle": [-3.1998812, 55.9485944, 325165, 673490],
  "Glasgow George Sq": [-4.2543527, 55.8625381, 259010, 665560],
  "Stirling": [-3.939712, 56.1189872, 279500, 693500],
  "Land's End": [-5.7150377, 50.0678449, 134250, 25250],
  "Lerwick": [-1.1426065, 60.1552037, 447700, 1141500],
  "Norwich": [1.2936135, 52.6284194, 623000, 308500],
  "Far west": [-7.9899075, 54.2465121, 10000, 500000]
};
const metres = (a, b) => {
  const dy = (a[1] - b[1]) * 111320, dx = (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot(dx, dy);
};

test("British National Grid converts to WGS84 within 1 m of PROJ", () => {
  for (const [place, [lon, lat, e, n]] of Object.entries(BNG_REFERENCE)) {
    const got = P.bngToWgs84(e, n);
    assert.ok(metres(got, [lon, lat]) < 1, place + " off by " + metres(got, [lon, lat]).toFixed(2) + " m");
  }
});

test("easting/northing CSV is converted, with a note", async () => {
  const [ds] = await P.parseBytes("bng.csv", bytes("Asset,Easting,Northing\nCastle,325165,673490\nSquare,259010,665560\n"));
  assert.ok(metres(ds.geojson.features[0].geometry.coordinates, [-3.1998812, 55.9485944]) < 1);
  assert.equal(ds.geojson.features[1].properties.Asset, "Square");
  assert.match(ds.warnings[0], /British National Grid/);
});

test("x/y CSV is read as lon/lat or BNG depending on the values", async () => {
  const [wgs] = await P.parseBytes("a.csv", bytes("x,y\n-3.2,55.95\n"));
  assert.deepEqual(wgs.geojson.features[0].geometry.coordinates, [-3.2, 55.95]);
  assert.deepEqual(wgs.warnings, []);
  const [grid] = await P.parseBytes("b.csv", bytes("x,y\n325165,673490\n"));
  assert.ok(metres(grid.geojson.features[0].geometry.coordinates, [-3.1998812, 55.9485944]) < 1);
});

test("BNG CSV rejects values outside the grid", () => {
  assert.throws(() => P.csvToGeoJSON("easting,northing\n900000,100\n"), /outside the British National Grid/);
});

test("GeoJSON declaring EPSG:27700 is converted", async () => {
  const fc = { type: "FeatureCollection", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::27700" } },
    features: [{ type: "Feature", properties: { id: 1 }, geometry: { type: "LineString", coordinates: [[325165, 673490], [259010, 665560]] } }] };
  const [ds] = await P.parseBytes("qgis.geojson", bytes(JSON.stringify(fc)));
  const line = ds.geojson.features[0].geometry.coordinates;
  assert.ok(metres(line[0], [-3.1998812, 55.9485944]) < 1);
  assert.ok(metres(line[1], [-4.2543527, 55.8625381]) < 1);
  assert.match(ds.warnings[0], /EPSG:27700/);
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

/* ------------------------------ Profiles ------------------------------- */
const profileOf = (over) => JSON.stringify(Object.assign({
  omamap: "profile", version: 1, savedAt: "2026-10-01T12:00:00Z",
  view: { lat: 55.9, lng: -3.2, zoom: 11 }, basemap: "satellite",
  datasets: [{ name: "Sites", visible: false, slot: 3, style: { colour: "#AABBCC", fillOpacity: 0.5, weight: 3, radius: 7, outline: "fg", byField: { field: "status", mode: "categories", reverse: true } },
    geojson: JSON.parse(POINT_FC) }]
}, over));

test("an OmaMap profile parses with view, basemap and styles", async () => {
  const p = await P.parseBytes("work.omamap", bytes(profileOf({})));
  assert.equal(p.kind, "profile");
  assert.deepEqual(p.view, { lat: 55.9, lng: -3.2, zoom: 11 });
  assert.equal(p.basemap, "satellite");
  const ds = p.datasets[0];
  assert.equal(ds.name, "Sites");
  assert.equal(ds.visible, false);
  assert.deepEqual(ds.style, { colour: "#aabbcc", fillOpacity: 0.5, weight: 3, radius: 7, outline: "fg", byField: { field: "status", mode: "categories", reverse: true } });
  assert.equal(ds.geojson.features[0].properties.name, "Edinburgh");
});

test("profile style values are cleaned, and unsafe fields dropped", async () => {
  const p = await P.parseBytes("x.omamap", bytes(profileOf({ datasets: [{ name: "A\u0007", style: { colour: "red;}", fillOpacity: 9, weight: -4, outline: "javascript", byField: { field: "__proto__" } }, geojson: JSON.parse(POINT_FC) }] })));
  const st = p.datasets[0].style;
  assert.equal(p.datasets[0].name, "A ");
  assert.equal(st.colour, null);
  assert.equal(st.fillOpacity, 1);
  assert.equal(st.weight, 0.5);
  assert.equal(st.outline, "auto");
  assert.equal(st.byField, null);
});

test("profiles with bad data or from a newer version are rejected", async () => {
  await assert.rejects(P.parseBytes("x.omamap", bytes(profileOf({ version: 99 }))), /newer OmaMap/);
  await assert.rejects(P.parseBytes("x.omamap", bytes(profileOf({ datasets: [{ name: "Bad", geojson: { type: "Point", coordinates: [500, 500] } }] }))), /Bad.*WGS84/);
  await assert.rejects(P.parseBytes("x.omamap", bytes('{"type":"FeatureCollection","features":[]}')), /not an OmaMap profile/);
});

test("WIMP .sdv-profile.json files open as profiles", async () => {
  const wimp = { __sdv_profile: true, version: 1, map: { center: [56.1, -3.9], zoom: 9, basemap: "osm" },
    datasets: [
      { name: "Assets", kind: "vector", visible: true, style: { color: "#1f6feb", fillColor: "#16a34a", fillOpacity: 0.4, weight: 2, radius: 7 },
        styleByField: { field: "status", mode: "completion" }, geojson: JSON.parse(POINT_FC) },
      { name: "Service map", kind: "arcgis-map", visible: false, sourceRef: { url: "https://example.test" } }
    ] };
  const p = await P.parseBytes("team.sdv-profile.json", bytes(JSON.stringify(wimp)));
  assert.equal(p.kind, "profile");
  assert.deepEqual(p.view, { lat: 56.1, lng: -3.9, zoom: 9 });
  assert.equal(p.datasets.length, 1);
  assert.equal(p.datasets[0].style.colour, "#16a34a");
  assert.deepEqual(p.datasets[0].style.byField, { field: "status", mode: "categories", reverse: false });
  assert.match(p.notes[0], /Service map/);
});
