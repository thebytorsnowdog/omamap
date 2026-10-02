"use strict";
/* Interaction benchmark on large synthetic data, measured inside the page.
   Reports wall time per operation and the longest main-thread freeze.
   Usage: node tests/bench.cjs  (BENCH_POINTS / BENCH_POLYGONS / BENCH_WIDE_COLS / BENCH_KML to resize) */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright-core");
const CORE = path.join(__dirname, "..", "core");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const N_POINTS = Number(process.env.BENCH_POINTS || 100000), N_POLYS = Number(process.env.BENCH_POLYGONS || 20000);

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(CORE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!f.startsWith(CORE) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https:\/\//, (r) => r.fulfill({ status: 204 }));
  await page.goto("http://127.0.0.1:" + server.address().port + "/index.html");
  await page.waitForFunction(() => window.OmaMap);

  const results = await page.evaluate(async ([nPoints, nPolys, BENCH_WIDE_COLS, BENCH_KML]) => {
    const out = [];
    let longest = 0;
    new PerformanceObserver((list) => list.getEntries().forEach((e) => { longest = Math.max(longest, e.duration); })).observe({ type: "longtask", buffered: false });
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const settle = async () => { await frame(); await frame(); while (STATE.map._animatingZoom) await frame(); };
    const measure = async (name, fn) => {
      await settle(); longest = 0;
      const t = performance.now();
      await fn();
      await Table.pending;
      await settle();
      out.push({ name: name, ms: Math.round(performance.now() - t), freeze: Math.round(longest) });
    };
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const statuses = ["In service", "Out of service", "Planned"];
    const pts = []; for (let i = 0; i < nPoints; i++) pts.push({ type: "Feature", geometry: { type: "Point", coordinates: [-4.5 + rnd() * 2, 55.5 + rnd()] }, properties: { id: i, name: "Asset " + i, status: statuses[i % 3], grade: 1 + (i % 5), risk: Math.round(rnd() * 1000) / 10, owner: "Team " + (i % 40) } });
    const polys = []; for (let i = 0; i < nPolys; i++) { const x = -4.5 + rnd() * 2, y = 55.5 + rnd(), d = 0.002; polys.push({ type: "Feature", properties: { id: i, zone: "Z" + (i % 50) }, geometry: { type: "Polygon", coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] } }); }
    const file = (name, obj) => new File([JSON.stringify({ type: "FeatureCollection", features: obj })], name, { type: "application/json" });
    const pf = file("points.geojson", pts), qf = file("polygons.geojson", polys);

    await measure("load " + nPoints + " points", () => handleFiles([pf]));
    await measure("load " + nPolys + " polygons", () => handleFiles([qf]));
    const P = STATE.datasets[0], Q = STATE.datasets[1];
    await measure("pan (painted)", async () => { STATE.map.panBy([300, 0], { animate: false }); });
    await measure("zoom in (painted)", async () => { STATE.map.setZoom(STATE.map.getZoom() + 1, { animate: false }); });
    await measure("colour points by category", async () => { setColourBy(P, "owner", "categories"); applyDatasetStyle(P); renderLegend(); });
    await measure("colour points by ranges", async () => { setColourBy(P, "risk", "ranges"); applyDatasetStyle(P); renderLegend(); });
    await measure("theme switch", async () => OmaMap.applyTheme({ mode: "light", colors: { background: "#eeeeee", accent: "#0055ff", green: "#00aa00", blue: "#3366ff" } }));
    const clickCentre = () => { const c = STATE.map.getSize().divideBy(2); onMapClick({ layerPoint: STATE.map.containerPointToLayerPoint(c) }); };
    await measure("click identify", async () => { clickCentre(); });
    await measure("close panel (Esc)", async () => { clearSelection(); });
    await measure("click identify (panel reopens)", async () => { clickCentre(); });
    await measure("click another feature", async () => { const c = STATE.map.getSize().divideBy(2).add([40, 25]); onMapClick({ layerPoint: STATE.map.containerPointToLayerPoint(c) }); });
    clearSelection();
    // Full repaint of the vector canvas (what a pan end, resize or restyle costs).
    const fullRedraw = () => { const r = STATE.renderer; r._redrawBounds = null; const t = performance.now(); r._redraw(); return performance.now() - t; };
    { const runs = []; for (let i = 0; i < 7; i++) { await frame(); runs.push(fullRedraw()); } runs.sort((a, b) => a - b);
      out.push({ name: "vector canvas full redraw (median|worst)", ms: Math.round(runs[3]), freeze: Math.round(runs[6]) }); }
    await measure("zoom out (painted)", async () => { STATE.map.setZoom(STATE.map.getZoom() - 1, { animate: false }); });
    await measure("pan back (painted)", async () => { STATE.map.panBy([-300, 0], { animate: false }); });
    await measure("open table (points)", async () => { Table.open(P); });
    await measure("table search", async () => { Table.query = "asset 9999"; Table.refilter(); });
    await measure("table clear search", async () => { Table.query = ""; Table.refilter(); });
    await measure("table sort numeric", async () => { Table.toggleSort("risk"); });
    await measure("table sort text", async () => { Table.toggleSort("name"); });
    await measure("table in-view filter", async () => { Table.inView = true; Table.refilter(); });
    await measure("table row click", async () => { Table.inView = false; Table.refilter(); Table.choose(Table.order[5], false); });
    await measure("table polygons", async () => { Table.open(Q); });
    await measure("hide + show polygons", async () => { toggleVisible(Q.id); toggleVisible(Q.id); });
    await measure("save profile (bounded export)", async () => { await OmaParse.profileBlob(buildProfile()); });

    // Style slider drag: 20 input events on the polygon outline width, one per frame.
    STATE.styleOpenId = Q.id; renderLayerList();
    const slider = Array.from(document.querySelectorAll(".style-editor input[type=range]")).find((r) => r.max === "8");
    await measure("slider drag x30 (polygons)", async () => {
      const lat = [];
      for (let i = 0; i < 30; i++) {
        slider.value = String(1 + (i % 10) * 0.5); slider.dispatchEvent(new Event("input"));
        const t = performance.now(); await frame(); lat.push(performance.now() - t);
      }
      if (window.restyleIdle) await restyleIdle();
      lat.sort((a, b) => a - b);
      out.push({ name: "  slider input->paint ms (median|worst)", ms: Math.round(lat[15]), freeze: Math.round(lat[29]) });
    });
    STATE.styleOpenId = null; renderLayerList();

    // Wide attribute table: draw + layout cost per scroll step.
    const wideCols = Number(BENCH_WIDE_COLS), wide = [];
    for (let i = 0; i < 20000; i++) { const p = {}; for (let c = 0; c < wideCols; c++) p["field_" + c] = "v" + ((i * 7 + c) % 97); wide.push({ type: "Feature", geometry: { type: "Point", coordinates: [-4 + rnd(), 55.5 + rnd()] }, properties: p }); }
    const W = addDataset({ name: "wide", geojson: { type: "FeatureCollection", features: wide } });
    await measure("open table (20k x " + wideCols + " cols)", async () => { Table.open(W); });
    const scrollSteps = async (dx, dy) => {
      const scroll = document.getElementById("tp-scroll"); let total = 0, worst = 0;
      for (let i = 0; i < 60; i++) {
        scroll.scrollTop += dy; scroll.scrollLeft += dx;
        const t = performance.now(); Table.draw(); void document.getElementById("tp-body").offsetHeight; const ms = performance.now() - t;
        total += ms; worst = Math.max(worst, ms); await frame();
      }
      return { avg: total / 60, worst: worst };
    };
    const v = await scrollSteps(0, 130);
    out.push({ name: "table scroll v (ms/step avg|worst)", ms: Math.round(v.avg * 10) / 10, freeze: Math.round(v.worst * 10) / 10 });
    const h = await scrollSteps(150, 0);
    out.push({ name: "table scroll h (ms/step avg|worst)", ms: Math.round(h.avg * 10) / 10, freeze: Math.round(h.worst * 10) / 10 });
    out.push({ name: "table DOM nodes after scroll", ms: document.getElementById("tp-body").getElementsByTagName("*").length, freeze: 0 });
    Table.close();

    // KML read on the main thread.
    let kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>';
    for (let i = 0; i < Number(BENCH_KML); i++) kml += "<Placemark><name>P" + i + "</name><ExtendedData><Data name=\"k\"><value>" + i + "</value></Data></ExtendedData><Point><coordinates>" + (-4 + rnd()) + "," + (55.5 + rnd()) + "</coordinates></Point></Placemark>";
    kml += "</Document></kml>";
    await measure("load " + BENCH_KML + "-placemark KML", () => handleFiles([new File([kml], "big.kml")]));
    return out;
  }, [N_POINTS, N_POLYS, process.env.BENCH_WIDE_COLS || 120, process.env.BENCH_KML || 50000]);
  console.log("operation".padEnd(34) + "wall ms   longest freeze ms");
  for (const r of results) console.log(r.name.padEnd(34) + String(r.ms).padStart(7) + String(r.freeze).padStart(12));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
