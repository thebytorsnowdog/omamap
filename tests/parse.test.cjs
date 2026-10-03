"use strict";
/* Parser and validation tests, run in Node against the same vendored
   libraries the app ships. Usage: npm test */
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

test("missing profile numbers preserve defaults instead of becoming zero", async () => {
  for (const value of [null, undefined, "", "  ", false, true, [], {}]) {
    const p = await P.parseBytes("defaults.omamap", bytes(profileOf({
      view: { lat: value, lng: -3.2, zoom: 11 },
      datasets: [{ style: { fillOpacity: value, weight: value, radius: value }, geojson: JSON.parse(POINT_FC) }]
    })));
    assert.equal(p.view, null);
    assert.equal(p.datasets[0].style.fillOpacity, null);
    assert.equal(p.datasets[0].style.weight, null);
    assert.equal(p.datasets[0].style.radius, null);
  }
  const p = await P.parseBytes("numbers.omamap", bytes(profileOf({
    view: { lat: "0", lng: 0, zoom: "11" },
    datasets: [{ style: { fillOpacity: 0, weight: "3", radius: "7" }, geojson: JSON.parse(POINT_FC) }]
  })));
  assert.deepEqual(p.view, { lat: 0, lng: 0, zoom: 11 });
  assert.equal(p.datasets[0].style.fillOpacity, 0);
  assert.equal(p.datasets[0].style.weight, 3);
  assert.equal(p.datasets[0].style.radius, 7);
});

test("profile dataset warnings are kept, cleaned and capped", async () => {
  const many = Array.from({ length: 30 }, (_, i) => "note " + i);
  const p = await P.parseBytes("w.omamap", bytes(profileOf({ datasets: [
    { name: "A", warnings: ["No .prj file: coordinates were assumed to be WGS84.", "bad\u0000\nline", 7, { html: "<b>" }, "", "x".repeat(1000)], geojson: JSON.parse(POINT_FC) },
    { name: "B", warnings: many, geojson: JSON.parse(POINT_FC) },
    { name: "C", warnings: "not a list", geojson: JSON.parse(POINT_FC) },
    { name: "D", geojson: JSON.parse(POINT_FC) }] })));
  const [a, b, c, d] = p.datasets;
  assert.deepEqual(a.warnings.slice(0, 2), ["No .prj file: coordinates were assumed to be WGS84.", "bad  line"]);
  assert.equal(a.warnings.length, 3);
  assert.equal(a.warnings[2].length, 300);
  assert.equal(b.warnings.length, 20);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(d.warnings, []);
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

test("shapefile date fields read as YYYY-MM-DD text, empty dates as null", async () => {
  const [ds] = await P.parseBytes("dated.zip", fixture("dated.zip"));
  assert.equal(ds.geojson.features[0].properties.INSTALLED, "1987-03-14");
  assert.equal(ds.geojson.features[1].properties.INSTALLED, null);
});

test("forbidden keys are rejected at any depth, and non-JSON objects refused", () => {
  const nested = JSON.parse('{"type":"Feature","geometry":{"type":"Point","coordinates":[0,0]},"properties":{"a":{"b":[{"__proto__":{"polluted":true}}]}}}');
  assert.throws(() => P.validateFeatureCollection(nested), /unsafe property name/);
  assert.equal(({}).polluted, undefined);
  const weird = { type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { m: new Map() } };
  assert.throws(() => P.validateFeatureCollection(weird), /only JSON values/);
});

test("validated geometry keeps only GeoJSON members", () => {
  const fc = P.validateFeatureCollection({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [1, 2], extra: "x".repeat(1000), bbox: [1, 2, 1, 2] } });
  assert.deepEqual(Object.keys(fc.features[0].geometry), ["type", "coordinates"]);
});

/* ------------------------- Resource limits ------------------------------ */

test("a CSV with more rows than the feature limit stops early with a clear error", () => {
  // Before: every row became a feature before the limit was checked, so a
  // 100 MiB CSV of short rows needed gigabytes and crashed the page.
  const csv = "lat,lon\n" + "1,1\n".repeat(P.LIMITS.features + 1);
  assert.throws(() => P.csvToGeoJSON(csv), /more than 500,000 rows/);
  // Exactly at the limit still loads.
  assert.equal(P.csvToGeoJSON("lat,lon\n" + "1,1\n".repeat(P.LIMITS.features)).features.length, P.LIMITS.features);
});

test("chunked CSV parsing keeps quoted newlines and commas across chunk boundaries", () => {
  const rows = [];
  for (let i = 0; i < 40000; i++) rows.push('1,2,"line ' + i + '\nsecond, line ""quoted"""');
  const fc = P.csvToGeoJSON("lat,lon,note\n" + rows.join("\n") + "\n");
  assert.equal(fc.features.length, 40000);
  assert.equal(fc.features[39999].properties.note, 'line 39999\nsecond, line "quoted"');
  assert.throws(() => P.csvToGeoJSON("lat,lon,note\n" + rows.join("\n") + '\n1,2,"unterminated\n'), /malformed/);
});

test("a CSV with too many columns is rejected before rows are built", () => {
  const header = ["lat", "lon"].concat(Array.from({ length: 600 }, (_, i) => "c" + i)).join(",");
  assert.throws(() => P.csvToGeoJSON(header + "\n" + "1,".repeat(601) + "1\n"), /more than 500 columns/);
});

test("deeply nested GeoJSON arrays fail cleanly, not with a stack overflow", () => {
  const deep = "[".repeat(100000) + "]".repeat(100000);
  assert.throws(() => P.jsonToGeoJSON(deep), /nested too deeply/);
  // Two levels of layer arrays still work.
  const fc = JSON.parse(POINT_FC);
  assert.equal(P.jsonToGeoJSON(JSON.stringify([[fc, fc], [fc]])).features.length, 3);
});

test("a dataset may not invent more than 1,000 attribute names", () => {
  // Each name becomes a table column and a colour-by option; millions froze the UI.
  const features = Array.from({ length: 1001 }, (_, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { ["f" + i]: 1 } }));
  assert.throws(() => P.validateFeatureCollection({ type: "FeatureCollection", features }), /more than 1,000 different attribute names/);
  assert.equal(P.validateFeatureCollection({ type: "FeatureCollection", features: features.slice(0, 1000) }).features.length, 1000);
});

test("feature IDs are bounded in length", () => {
  const f = (id) => ({ type: "Feature", id: id, geometry: { type: "Point", coordinates: [0, 0] }, properties: {} });
  assert.throws(() => P.validateFeatureCollection(f("x".repeat(1001))), /feature ID exceeds/);
  assert.equal(P.validateFeatureCollection(f("x".repeat(1000))).features[0].id.length, 1000);
});

test("a ZIP may hold at most 50 layers", async () => {
  const files = {};
  for (let i = 0; i < 51; i++) files["l" + i + ".geojson"] = POINT_FC;
  await assert.rejects(P.parseBytes("many.zip", makeZip(files)), /more than 50 layers/);
  delete files["l50.geojson"];
  assert.equal((await P.parseBytes("fifty.zip", makeZip(files))).length, 50);
});

test("the layers of one ZIP together are capped at 1,000,000 features", async () => {
  // Three layers under the per-dataset limit, but over the per-file total.
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const csv = () => {
    const rows = ["lat,lon"];
    for (let i = 0; i < 340000; i++) rows.push((rnd() * 80).toFixed(4) + "," + (rnd() * 170).toFixed(4));
    return rows.join("\n");
  };
  await assert.rejects(P.parseBytes("big.zip", makeZip({ "a.csv": csv(), "b.csv": csv(), "c.csv": csv() })), /together exceed 1,000,000 features/);
});

/* Minimal shapefile writers for the header checks below. */
function makeShp(points, emptyRecords = 0) {
  const recs = [];
  points.forEach(([x, y], i) => {
    const r = Buffer.alloc(28);
    r.writeInt32BE(i + 1, 0); r.writeInt32BE(10, 4);           // content: 20 bytes = 10 words
    r.writeInt32LE(1, 8); r.writeDoubleLE(x, 12); r.writeDoubleLE(y, 20);
    recs.push(r);
  });
  if (emptyRecords) recs.push(Buffer.alloc(8 * emptyRecords));  // id 0, length 0
  const body = Buffer.concat(recs);
  const head = Buffer.alloc(100);
  head.writeInt32BE(9994, 0); head.writeInt32BE((100 + body.length) / 2, 24); head.writeInt32LE(1000, 28); head.writeInt32LE(1, 32);
  return Buffer.concat([head, body]);
}
function makeDbf(values, claimedRecords) {
  const head = Buffer.alloc(32);
  head.writeUInt8(3, 0); head.writeUInt32LE(claimedRecords === undefined ? values.length : claimedRecords, 4);
  head.writeUInt16LE(32 + 32 + 1, 8); head.writeUInt16LE(1 + 10, 10);
  const field = Buffer.alloc(32);
  field.write("name", 0, "latin1"); field.write("C", 11, "latin1"); field.writeUInt8(10, 16);
  const rows = values.map((v) => Buffer.from(" " + String(v).padEnd(10).slice(0, 10), "latin1"));
  return Buffer.concat([head, field, Buffer.from([13]), ...rows, Buffer.from([26])]);
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test("a .dbf claiming billions of records is refused before shpjs reads it", async () => {
  // shpjs loops over the claimed count; 3.4 billion empty rows exhausted memory.
  const shp = makeShp([[-3.2, 55.9]]);
  assert.equal((await P.parseShapefileSet("ok", { shp: ab(shp), dbf: ab(makeDbf(["Leith"])) }))[0].geojson.features[0].properties.name, "Leith");
  await assert.rejects(P.parseShapefileSet("bad", { shp: ab(shp), dbf: ab(makeDbf(["Leith"], 0xcc000001)) }), /more than 500,000 records/);
  await assert.rejects(P.parseShapefileSet("short", { shp: ab(shp), dbf: ab(makeDbf(["Leith"], 1000)) }), /truncated or its header is inconsistent/);
  // The same file inside a ZIP.
  await assert.rejects(P.parseBytes("bad.zip", makeZip({ "x.shp": shp, "x.dbf": makeDbf(["Leith"], 0xcc000001) })), /more than 500,000 records/);
});

test("a .shp of millions of empty records is refused before features are built", async () => {
  const shp = makeShp([[-3.2, 55.9]], P.LIMITS.features + 10);
  await assert.rejects(P.parseShapefileSet("empty", { shp: ab(shp) }), /Shapefile has more than 500,000 records/);
  await assert.rejects(P.parseShapefileSet("junk", { shp: ab(Buffer.alloc(200)) }), /not a shapefile/);
});

test("a CSV with more than 10 million cells is refused before features are built", () => {
  // 100 MiB of one-character cells needed about 3 GiB once built.
  const header = ["lat", "lon"].concat(Array.from({ length: 498 }, (_, i) => "c" + i)).join(",");
  const row = "1" + ",1".repeat(499);
  assert.throws(() => P.csvToGeoJSON(header + "\n" + (row + "\n").repeat(20001)), /more than 10,000,000 cells/);
});

test("CSV preflight rejects wide rows before unbounded parsing", () => {
  const original = Papa.parse;
  let largest = 0;
  Papa.parse = (text, options) => { largest = Math.max(largest, text.length); return original(text, options); };
  try {
    assert.throws(() => P.csvToGeoJSON('x,'.repeat(2000000) + 'x\n1,2'), /columns/);
    assert.ok(largest <= 65536, 'only the bounded delimiter sample reaches Papa');
  } finally { Papa.parse = original; }
});

test("CSV preflight handles other delimiters, escaped quotes and CRLF", () => {
  for (const sep of [';', '\t', '|']) {
    const fc = P.csvToGeoJSON(['lat','lon','note'].join(sep) + '\r\n' + ['1','2','"a\r\nb""c"'].join(sep));
    assert.equal(fc.features[0].properties.note, 'a\r\nb"c');
  }
});

test("validation returns fields first appearing after row 5000", () => {
  const input = JSON.parse(POINT_FC);
  input.features = Array.from({length:5001}, () => JSON.parse(POINT_FC).features[0]);
  input.features[5000].properties.late = 1;
  assert.deepEqual(P.validateFeatureCollection(input).fields, ['name','late']);
});

test("profile export preserves palette slots and UTF-8 data", async () => {
  const profile = {omamap:'profile',version:1,datasets:[{name:'Édimbourg 🗺',slot:8,geojson:JSON.parse(POINT_FC)}]};
  const blob = await P.profileBlob(profile);
  const parsed = await P.parseBytes('roundtrip.omamap', await blob.arrayBuffer());
  assert.equal(parsed.datasets[0].slot,8);
  assert.equal(parsed.datasets[0].name,profile.datasets[0].name);
  assert.deepEqual(JSON.parse(await blob.text()),profile);
});

test("oversized profile export fails instead of creating an unreadable save", async () => {
  const f = JSON.parse(POINT_FC).features[0];
  f.properties.text = 'x'.repeat(95000);
  const profile = {omamap:'profile',version:1,datasets:[{geojson:{type:'FeatureCollection',features:Array(1200).fill(f)}}]};
  await assert.rejects(P.profileBlob(profile), /100 MiB reopening limit/);
});

test("workspace limits count all datasets together", () => {
  const fc = P.validateFeatureCollection(JSON.parse(POINT_FC));
  assert.ok(fc.estimatedBytes > 0);
  assert.doesNotThrow(() => P.checkWorkspace([fc,fc]));
  assert.throws(() => P.checkWorkspace([{features:{length:500001},coordinateCount:1,estimatedBytes:1},{features:{length:500000},coordinateCount:1,estimatedBytes:1}]), /Workspace memory budget/);
  assert.throws(() => P.checkWorkspace([{features:[],coordinateCount:10000001,estimatedBytes:1}]), /Workspace memory budget/);
  assert.throws(() => P.checkWorkspace([{features:[],coordinateCount:0,estimatedBytes:P.LIMITS.workspaceBytes},{features:[],coordinateCount:0,estimatedBytes:1}]), /Workspace memory budget/);
});

test("CSV preflight accepts a UTF-8 BOM before quoted headers", () => {
  const fc = P.csvToGeoJSON('\ufeff"lat","lon","note"\n1,2,"a,b"');
  assert.equal(fc.features[0].properties.note,'a,b');
});

test("a 200k x 20 CSV inside the documented limits is accepted (names are charged once)", () => {
  const rows = ["lat,lon," + Array.from({ length: 18 }, (_, i) => "field_" + i).join(",")];
  for (let i = 0; i < 200000; i++) {
    const r = [51 + (i % 1000) / 1000, -1 - (i % 997) / 1000];
    for (let c = 2; c < 20; c++) r.push("v" + (i % 50));
    rows.push(r.join(","));
  }
  const fc = P.csvToGeoJSON(rows.join("\n"));
  assert.equal(fc.features.length, 200000);
  assert.equal(fc.fields.length, 20);
  assert.ok(fc.estimatedBytes < P.LIMITS.workspaceBytes);
});

test("attribute data beyond the budget is refused with a clear reason", () => {
  const big = "x".repeat(90000);
  const features = Array.from({ length: 1300 }, () => ({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { a: big } }));
  assert.throws(() => P.validateFeatureCollection({ type: "FeatureCollection", features }), /200 MiB attribute budget after [\d,]+ features\. Remove unused columns/);
});

test("KML and GPX inside a ZIP or KMZ come back for the page to convert", async () => {
  const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Point><coordinates>-1,51</coordinates></Point></Placemark></kml>';
  const gpx = '<?xml version="1.0"?><gpx version="1.1" creator="t"><wpt lat="51" lon="-1"/></gpx>';
  const pt = JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: {} });
  const zip = fflate.zipSync({ "doc.kml": fflate.strToU8(kml), "walk.gpx": fflate.strToU8(gpx), "p.geojson": fflate.strToU8(pt) });
  const layers = await P.parseBytes("mixed.zip", zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
  assert.deepEqual(layers.map((l) => l.name).sort(), ["mixed / doc", "mixed / p", "mixed / walk"]);
  const xml = layers.filter((l) => l.xml).map((l) => l.xml.ext).sort();
  assert.deepEqual(xml, ["gpx", "kml"]);
  const kmz = fflate.zipSync({ "doc.kml": fflate.strToU8(kml) });
  const only = await P.parseBytes("trip.kmz", kmz.buffer.slice(kmz.byteOffset, kmz.byteOffset + kmz.byteLength));
  assert.equal(only.length, 1); assert.equal(only[0].name, "trip"); assert.equal(only[0].xml.items, 1);
  const bad = fflate.zipSync({ "doc.kml": fflate.strToU8('<!DOCTYPE x [<!ENTITY a "b">]>' + kml) });
  await assert.rejects(P.parseBytes("bad.kmz", bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)), /DOCTYPE/);
  // Converted on the page; totals are re-checked with exact counts.
  const two = [{ xml: { text: "", ext: "kml" } }, { xml: { text: "", ext: "kml" } }];
  const run = () => ({ type: "FeatureCollection", features: new Array(600000).fill(0) });
  await assert.rejects(P.resolveXmlLayers(two, run), /together exceed/);
});
