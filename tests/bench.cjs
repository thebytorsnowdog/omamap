"use strict";
/* Interaction benchmark on large synthetic data, measured inside the page.
   Reports wall time per operation and the longest main-thread freeze.
   Usage: node tests/bench.cjs  (BENCH_POINTS / BENCH_POLYGONS to resize) */
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

  const results = await page.evaluate(async ([nPoints, nPolys]) => {
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
    await measure("click identify", async () => { const c = STATE.map.getSize().divideBy(2); onMapClick({ layerPoint: STATE.map.containerPointToLayerPoint(c) }); });
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
    return out;
  }, [N_POINTS, N_POLYS]);
  console.log("operation".padEnd(34) + "wall ms   longest freeze ms");
  for (const r of results) console.log(r.name.padEnd(34) + String(r.ms).padStart(7) + String(r.freeze).padStart(12));
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
