"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const OmaParse = require("../core/parse.js");

function runCore(context, ...files) {
  for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, "../core", file), "utf8"), context);
}

function application() {
  const notices = [], stored = new Map([["omamap.basemap", "satellite"]]);
  const context = vm.createContext({
    OmaParse,
    window: { localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) } },
    document: { addEventListener() {}, getElementById: () => ({ addEventListener() {} }), querySelectorAll: () => [] },
    Table: { wire() {}, onDatasetsChanged() {} },
    tiles: [], views: [], notices,
    L: {
      tileLayer: (url) => url,
      layerGroup: (urls) => ({ addTo() { context.tiles.push(...urls); return this; } })
    }
  });
  runCore(context, "basemaps.js", "app.js");
  vm.runInContext(`
    const noop = () => {};
    renderBasemapButtons = applyTheme = wireDragDrop = wireKeys = renderLayerList = setStatus = noop;
    clearSelection = renderLegend = disposeDataset = setLoading = noop;
    prepareDataset = (saved) => saved;
    attachDataset = (ds) => STATE.datasets.push(ds);
    runSliced = async (stage) => stage;
    initMap = () => { STATE.map = { setView: (center, zoom) => views.push([...center, zoom]), removeLayer: noop }; };
    toast = (...args) => notices.push(args);
    Parser.start = noop;
    boot();
  `, context);
  return { context, stored, notices };
}

test("OmaMap profile restore keeps None through legacy preferences and online profile metadata", async () => {
  const { context, stored } = application();
  const profile = await OmaParse.parseBytes("legacy.omamap", new TextEncoder().encode(JSON.stringify({
    omamap: "profile", version: 1, basemap: "topo", view: { lat: 10, lng: 20, zoom: 9 },
    datasets: [{ name: "Fixture", geojson: { type: "Point", coordinates: [20, 10] } }]
  })).buffer);
  assert.equal(profile.basemap, "topo");
  assert.equal(vm.runInContext("STATE.basemapId", context), "none");
  vm.runInContext('setBasemap("none", true)', context);
  await context.restoreProfile(profile);
  assert.equal(vm.runInContext("STATE.datasets[0].name", context), "Fixture");
  assert.deepEqual(Array.from(context.views[0]), [10, 20, 9]);
  assert.deepEqual(context.tiles, []);
  assert.equal(stored.get("omamap.tileBasemap"), "none");

  const wimp = await OmaParse.parseBytes("legacy.sdv-profile.json", new TextEncoder().encode(JSON.stringify({
    __sdv_profile: true, map: { center: [20, 10], zoom: 8, basemap: "none" }, datasets: []
  })).buffer);
  vm.runInContext('setBasemap("streets", true); boot();', context);
  await context.restoreProfile(wimp);
  assert.equal(vm.runInContext("STATE.basemapId", context), "streets");
  assert.deepEqual(Array.from(context.views[1]), [20, 10, 8]);
  assert.deepEqual(context.tiles, ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"]);
  assert.equal(stored.get("omamap.tileBasemap"), "streets");
});

test("OmaMap native bridge keeps directory group IDs and rejects duplicate parts", async () => {
  const { context, notices } = application();
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(url);
    return { ok: true, headers: { get: () => null }, arrayBuffer: async () => url };
  };
  context.Parser = vm.runInContext("Parser", context);
  const sets = [];
  context.Parser.run = ({ name, parts }) => { sets.push({ name, ...parts }); return []; };
  const file = (shapeGroup, name, url) => ({ shapeGroup, name, url });
  await context.openUrls([
    file(0, "same.shp", "left-geometry"), file(0, "same.dbf", "left-attributes"),
    file(1, "same.shp", "right-geometry"), file(1, "same.dbf", "right-attributes"),
    file(2, "other.shp", "ambiguous-geometry"), file(2, "other.dbf", "ambiguous-attributes"),
    file(2, "OTHER.DBF", "ambiguous-duplicate")
  ], "release-batch");
  assert.deepEqual(sets, [
    { name: "same", shp: "left-geometry", dbf: "left-attributes" },
    { name: "same", shp: "right-geometry", dbf: "right-attributes" }
  ]);
  assert.deepEqual(fetched, ["left-geometry", "left-attributes", "right-geometry", "right-attributes", "release-batch"]);
  assert.match(notices[0][1], /Multiple files match/);
});
