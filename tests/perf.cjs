"use strict";
/* Rough load/click timings for large datasets. Usage: node tests/perf.cjs */
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const { chromium } = require("playwright-core");
const CORE = path.join(__dirname, "..", "core"), OUT = path.join(__dirname, "output");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function points(n) {
  const f = [];
  for (let i = 0; i < n; i++) f.push({ type: "Feature", properties: { id: i, name: "Asset " + i, status: i % 3 ? "ok" : "check" },
    geometry: { type: "Point", coordinates: [-4.5 + Math.random() * 2, 55.5 + Math.random() * 1] } });
  return { type: "FeatureCollection", features: f };
}
function squares(n) {
  const f = [];
  for (let i = 0; i < n; i++) {
    const x = -4.5 + Math.random() * 2, y = 55.5 + Math.random(), d = 0.002;
    f.push({ type: "Feature", properties: { id: i, zone: "Z" + (i % 50) },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]] } });
  }
  return { type: "FeatureCollection", features: f };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const files = { "points-100k.geojson": points(100000), "polygons-20k.geojson": squares(20000) };
  for (const [name, fc] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), JSON.stringify(fc));
  const server = http.createServer((req, res) => {
    const file = path.join(CORE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(CORE) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(/^https:\/\//, (r) => r.fulfill({ status: 204 }));
  await page.goto("http://127.0.0.1:" + server.address().port + "/index.html");
  await page.waitForFunction(() => window.OmaMap);
  for (const name of Object.keys(files)) {
    const size = (fs.statSync(path.join(OUT, name)).size / 1048576).toFixed(1);
    const t0 = Date.now();
    await page.setInputFiles("#file-input", path.join(OUT, name));
    await page.waitForFunction((n) => STATE.datasets.some((d) => d.name === n) && document.getElementById("loading").hidden, name.replace(".geojson", ""), { timeout: 120000 });
    console.log(`${name} (${size} MiB): loaded and drawn in ${Date.now() - t0} ms`);
  }
  const click = await page.evaluate(() => {
    const t = performance.now();
    const hits = identify(STATE.map.latLngToLayerPoint(STATE.map.getCenter()));
    return { ms: Math.round(performance.now() - t), hits: hits.length };
  });
  console.log(`identify across 120k features: ${click.ms} ms (${click.hits} hits)`);
  const pan = await page.evaluate(() => new Promise((resolve) => {
    const t = performance.now();
    STATE.map.once("moveend", () => requestAnimationFrame(() => resolve(Math.round(performance.now() - t))));
    STATE.map.panBy([300, 0], { animate: false });
  }));
  console.log(`pan redraw: ${pan} ms`);
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
