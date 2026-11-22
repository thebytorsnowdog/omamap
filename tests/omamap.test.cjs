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

function application(Worker) {
  const notices = [], stored = new Map([["omamap.basemap", "satellite"]]);
  const elements = new Map();
  const context = vm.createContext({
    OmaParse, Worker, performance, setTimeout,
    window: { localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) } },
    document: {
      addEventListener() {}, querySelectorAll: () => [],
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { hidden: true, addEventListener(type, fn) { this[type] = fn; } });
        return elements.get(id);
      }
    },
    Table: { wire() {}, onDatasetsChanged() {} },
    tiles: [], views: [], recordNotice: (...args) => notices.push(args),
    L: {
      latLngBounds: () => ({ extend() {} }),
      tileLayer: (url) => url,
      layerGroup: (urls) => ({ addTo() { context.tiles.push(...urls); return this; } })
    }
  });
  runCore(context, "basemaps.js", "app.js");
  vm.runInContext(`
    const noop = () => {};
    renderBasemapButtons = applyTheme = wireDragDrop = wireKeys = renderLayerList = setStatus = noop;
    clearSelection = renderLegend = disposeDataset = noop;
    prepareDataset = function* (saved) { return saved; };
    attachDataset = (ds) => { ds.layer = { getBounds: noop }; ds.featureCount = ds.geojson.features.length; STATE.datasets.push(ds); };
    fitBounds = noop;
    initMap = () => { STATE.map = { setView: (center, zoom) => views.push([...center, zoom]), removeLayer: noop }; };
    toast = recordNotice;
    boot();
  `, context);
  return { context, stored, notices };
}

test("Cancel terminates a pending XML worker, resets loading and allows another import", async () => {
  const workers = [];
  let reportPost;
  const posted = () => new Promise((resolve) => { reportPost = resolve; });
  class Worker {
    constructor(url) {
      assert.equal(url, "parse-worker.js");
      workers.push(this);
    }
    postMessage(message, transfer) { reportPost({ message, transfer }); }
    terminate() { this.terminated = true; }
  }

  const { context, notices } = application(Worker);
  const parser = vm.runInContext("Parser", context);
  const spinner = context.document.getElementById("loading");
  const file = (name, xml) => ({ name, arrayBuffer: () => new TextEncoder().encode(xml).buffer });
  const firstPost = posted();
  const loading = context.handleFiles([file("slow.kml", "<kml/>")]);
  const job = await Promise.race([firstPost, loading]);
  assert.ok(job, "KML is sent to the worker");
  assert.equal(job.message.name, "slow.kml");
  assert.equal(job.transfer[0], job.message.buffer);
  assert.equal(spinner.hidden, false);
  const pending = parser.jobs.get(job.message.id);
  assert.ok(pending);
  context.document.getElementById("loading-cancel").click();
  await loading;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 1, "replacement waits for the next import");
  assert.equal(parser.worker, null);
  assert.equal(parser.jobs.size, 0);
  assert.equal(spinner.hidden, true);
  assert.equal(vm.runInContext("cancelledLoad", context), false);
  assert.deepEqual(notices, [["Loading cancelled", "slow.kml", "warn"]]);
  assert.equal(vm.runInContext("STATE.datasets.length", context), 0);

  const nextPost = posted();
  const next = context.handleFiles([file("next.gpx", '<gpx><wpt lat="51" lon="-1"/></gpx>')]);
  const reply = await Promise.race([nextPost, next]);
  assert.ok(reply, "GPX is sent to the replacement worker");
  const datasets = await OmaParse.parseBytes(reply.message.name, reply.message.buffer);
  // Ignore a late error delivery from the terminated worker while the new job runs.
  workers[0].onerror({ preventDefault() {} });
  workers[1].onmessage({ data: { id: reply.message.id, ok: true, datasets } });
  await next;
  assert.equal(workers.length, 2);
  assert.equal(spinner.hidden, true);
  assert.equal(vm.runInContext("STATE.datasets[0].name", context), "next");
});

test("a host without workers can still import loose KML through the sliced fallback", async () => {
  const { context, notices } = application();
  const xml = "<kml><Placemark><Point><coordinates>1,2</coordinates></Point></Placemark></kml>";
  const buffer = new TextEncoder().encode(xml).buffer;
  await context.handleFiles([{ name: "local.kml", arrayBuffer: () => buffer }]);
  assert.equal(vm.runInContext("Parser.failed", context), true);
  assert.equal(vm.runInContext("STATE.datasets[0].name", context), "local");
  assert.deepEqual(vm.runInContext("STATE.datasets[0].geojson.features[0].geometry.coordinates", context), [1, 2]);
  assert.equal(context.document.getElementById("loading").hidden, true);
  assert.deepEqual(notices, []);
});

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
