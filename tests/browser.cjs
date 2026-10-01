"use strict";
/* End-to-end check of the web core in headless Chromium.
   Serves core/ locally, stubs every external tile request, loads real files
   through the file picker, then clicks features on the map.
   Usage: node tests/browser.cjs   (CHROMIUM=/path/to/chromium to override) */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

const CORE = path.join(__dirname, "..", "core");
const OUT = path.join(__dirname, "output");
const FIX = path.join(__dirname, "fixtures");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

// 1x1 transparent PNG, standing in for every basemap tile.
const TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = path.join(CORE, rel);
    if (!file.startsWith(CORE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // A park polygon with a café point inside it and a path crossing both.
  const park = {
    type: "FeatureCollection", features: [{
      type: "Feature", properties: { name: "Holyrood Park", area_type: "Royal park", url: "https://example.org/holyrood" },
      geometry: { type: "Polygon", coordinates: [[[-3.18, 55.94], [-3.15, 55.94], [-3.15, 55.955], [-3.18, 55.955], [-3.18, 55.94]]] }
    }]
  };
  const cafes = {
    type: "FeatureCollection", features: [
      { type: "Feature", properties: { name: "Park Café", seats: 24, wifi: null }, geometry: { type: "Point", coordinates: [-3.165, 55.9475] } },
      { type: "Feature", properties: { name: "Far Café", seats: 8 }, geometry: { type: "Point", coordinates: [-3.30, 55.90] } }
    ]
  };
  fs.writeFileSync(path.join(dir, "park.geojson"), JSON.stringify(park));
  fs.writeFileSync(path.join(dir, "cafes.geojson"), JSON.stringify(cafes));
  fs.writeFileSync(path.join(dir, "stations.csv"), "Station,lat,lon\nWaverley,55.952,-3.189\nHaymarket,55.946,-3.218\n");
  fs.writeFileSync(path.join(dir, "walk.gpx"),
    '<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Arthur\'s Seat walk</name><trkseg>' +
    '<trkpt lat="55.944" lon="-3.175"/><trkpt lat="55.946" lon="-3.165"/><trkpt lat="55.951" lon="-3.160"/></trkseg></trk></gpx>');
  fs.writeFileSync(path.join(dir, "broken.geojson"), '{"type":"Point","coordinates":[999,999]}');
  return ["park.geojson", "cafes.geojson", "stations.csv", "walk.gpx", "broken.geojson"].map((f) => path.join(dir, f));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const external = new Set();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.route(/^https:\/\//, (route) => {
    external.add(new URL(route.request().url()).host);
    route.fulfill({ status: 200, contentType: "image/png", body: TILE });
  });

  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push("✔ " + name); }
    catch (e) { results.push("✖ " + name + "\n    " + e.message.split("\n").filter(Boolean).slice(0, 5).join(" ")); process.exitCode = 1; }
  };

  await page.goto(origin + "/index.html");
  await page.waitForFunction(() => window.OmaMap && document.querySelectorAll("#basemaps button").length === 6);

  await check("loads with no errors and the dark basemap by default", async () => {
    assert.equal(await page.evaluate(() => STATE.basemapId), "dark");
    assert.deepEqual(errors, []);
  });

  const files = writeFixtures(path.join(OUT, "fixtures"));
  files.push(path.join(FIX, "point.zip"));
  // Loose shapefile parts from the projected fixture.
  await page.evaluate(() => 0);
  const loose = path.join(OUT, "fixtures", "loose");
  fs.mkdirSync(loose, { recursive: true });
  globalThis.self = globalThis;
  globalThis.fflate = require(path.join(CORE, "vendor/fflate.js"));
  const P = require(path.join(CORE, "parse.js"));
  const buf = fs.readFileSync(path.join(FIX, "projected-components.zip"));
  for (const [name, data] of P.extractZip(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))) {
    if (P.SHAPE_PARTS.includes(P.extOf(name))) {
      const out = path.join(loose, "projected." + P.extOf(name));
      fs.writeFileSync(out, data);
      files.push(out);
    }
  }

  await check("loads GeoJSON, CSV, GPX, zipped and loose shapefiles; rejects bad file", async () => {
    await page.setInputFiles("#file-input", files);
    await page.waitForFunction(() => document.getElementById("loading").hidden && STATE.datasets.length >= 6, null, { timeout: 15000 });
    const names = await page.evaluate(() => STATE.datasets.map((d) => d.name));
    assert.deepEqual(names.sort(), ["cafes", "park", "point", "projected", "stations", "walk"].sort());
    const toastText = await page.locator(".toast.err").allTextContents();
    assert.ok(toastText.some((t) => /broken\.geojson/.test(t) && /WGS84/.test(t)), "expected rejection toast for broken.geojson, got " + JSON.stringify(toastText));
    assert.equal(await page.evaluate(() => Parser.failed), false, "worker should be in use");
    assert.equal(await page.locator("#meta-layers").textContent(), "6");
  });

  const clickAt = async (lat, lng) => {
    const pt = await page.evaluate(([la, ln]) => {
      const p = STATE.map.latLngToContainerPoint([la, ln]);
      const r = document.getElementById("map").getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, [lat, lng]);
    await page.mouse.click(pt.x, pt.y);
  };

  // Move the map and wait for the canvas to redraw before clicking.
  const setView = async (lat, lng, zoom) => {
    await page.waitForFunction(() => !STATE.map._animatingZoom);
    await page.evaluate(([la, ln, z]) => new Promise((resolve) => {
    STATE.map.once("moveend", () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    STATE.map.setView([la, ln], z, { animate: false });
  }), [lat, lng, zoom]);
  };

  await check("clicking a point inside a polygon selects the point and reports both", async () => {
    await setView(55.9475, -3.165, 14);
    await clickAt(55.9475, -3.165);
    await page.waitForSelector("#inspector:not([hidden])");
    assert.equal(await page.locator("#insp-ds").textContent(), "Park Café");
    assert.match(await page.locator("#insp-hits").textContent(), /1 of [23] features here/);
    const rows = await page.locator("#insp-attrs tr").allTextContents();
    assert.ok(rows.some((r) => r.includes("seats") && r.includes("24")));
    assert.ok(rows.some((r) => r.includes("wifi") && r.includes("null")));
  });

  await check("] cycles to the next feature under the cursor", async () => {
    await page.keyboard.press("]");
    const label = await page.locator("#insp-ds").textContent();
    assert.ok(["Holyrood Park", "Arthur's Seat walk"].includes(label), "got " + label);
  });

  await check("polygon selection shows area and a safe external link", async () => {
    await page.keyboard.press("Escape");
    await clickAt(55.942, -3.177);
    assert.equal(await page.locator("#insp-ds").textContent(), "Holyrood Park");
    assert.match(await page.locator("#insp-sub").textContent(), /ha|km²/);
    assert.equal(await page.locator("#insp-attrs a").getAttribute("href"), "https://example.org/holyrood");
  });

  await check("attribute filter narrows rows", async () => {
    await page.fill("#attr-filter", "area");
    const rows = await page.locator("#insp-attrs tr").allTextContents();
    assert.equal(rows.length, 1);
    assert.match(rows[0], /area_type/);
    await page.fill("#attr-filter", "");
  });

  await page.screenshot({ path: path.join(OUT, "desktop-selected.png") });

  await check("Esc leaves the filter box first, then clears the selection; empty map click clears too", async () => {
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#inspector").isHidden(), false, "step 0");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#inspector").isHidden(), true, "step 1");
    await clickAt(55.9475, -3.165);
    assert.equal(await page.locator("#inspector").isHidden(), false, "step 2");
    await page.waitForTimeout(600); // a second click inside the double-click window would zoom instead
    await clickAt(55.935, -3.185);
    assert.equal(await page.locator("#inspector").isHidden(), true, "step 3");
  });

  await check("hiding a dataset removes it from hit-testing", async () => {
    await page.locator('button[aria-label="Hide cafes"]').click();
    await clickAt(55.9475, -3.165);
    assert.notEqual(await page.locator("#insp-ds").textContent(), "Park Café");
    await page.keyboard.press("Escape");
    await page.locator('button[aria-label="Show cafes"]').click();
  });

  await check("basemap keys switch providers (5 = satellite, 6 = none)", async () => {
    await page.keyboard.press("5");
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => STATE.basemapId), "satellite");
    assert.ok(external.has("server.arcgisonline.com"), "expected satellite tile requests, saw " + [...external]);
    await page.keyboard.press("6");
    assert.equal(await page.evaluate(() => STATE.baseLayer), null);
    await page.keyboard.press("1");
    assert.equal(await page.evaluate(() => STATE.basemapId), "streets");
  });

  await check("only known tile providers were contacted", async () => {
    const allowed = /^(tile\.openstreetmap\.org|[a-d]\.basemaps\.cartocdn\.com|server\.arcgisonline\.com|[a-c]\.tile\.opentopomap\.org)$/;
    for (const host of external) assert.match(host, allowed);
  });

  await check("light Omarchy theme recolours UI and auto basemap", async () => {
    await page.evaluate(() => { localStorage.removeItem("omamap.basemap"); STATE.basemapPref = "auto"; });
    await page.evaluate(() => OmaMap.applyTheme({ mode: "light", font: "JetBrainsMono Nerd Font", colors: {
      background: "#eff1f5", dark_background: "#e6e9ef", darker_background: "#dce0e8", lighter_background: "#ccd0da",
      foreground: "#4c4f69", dark_foreground: "#5c5f77", muted: "#8c8fa1", accent: "#1e66f5", selection: "#bcc0cc",
      red: "#d20f39", green: "#40a02b", yellow: "#df8e1d", blue: "#1e66f5", magenta: "#8839ef", cyan: "#179299", orange: "#fe640b", brown: "#dc8a78" } }));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(239, 241, 245)");
    assert.equal(await page.evaluate(() => STATE.basemapId), "light");
    assert.equal(await page.evaluate(() => STATE.palette.includes("#1e66f5")), false, "accent is reserved for selection");
    await setView(55.9475, -3.17, 13);
    await clickAt(55.9475, -3.165);
    await page.screenshot({ path: path.join(OUT, "desktop-light.png") });
  });

  await check("narrow window keeps the inspector usable", async () => {
    await page.setViewportSize({ width: 820, height: 700 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#inspector").isVisible(), true);
    await page.screenshot({ path: path.join(OUT, "narrow.png") });
  });

  await check("no page errors during the run", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  console.log(results.join("\n"));
  console.log("Screenshots in " + path.relative(process.cwd(), OUT));
})().catch((e) => { console.error(e); process.exit(1); });
