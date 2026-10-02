"use strict";
/* Browser tests for dataset styling (colour by field, legend) and the
   attribute table. Usage: node tests/features.cjs */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

const CORE = path.join(__dirname, "..", "core");
const OUT = path.join(__dirname, "output");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const THEME = { mode: "dark", colors: {
  background: "#1a1b26", dark_background: "#16161e", darker_background: "#101014", lighter_background: "#24283b",
  foreground: "#c0caf5", dark_foreground: "#a9b1d6", muted: "#565f89", accent: "#ff9e64", selection: "#33467c",
  red: "#f7768e", green: "#9ece6a", yellow: "#e0af68", blue: "#7aa2f7", cyan: "#7dcfff", magenta: "#bb9af7", orange: "#ff9e64", brown: "#c0a36e" } };

function fixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const statuses = ["In service", "In service", "In service", "Out of service", "Planned"];
  const assets = [];
  for (let i = 0; i < 300; i++) {
    assets.push({ type: "Feature", geometry: { type: "Point", coordinates: [-4.3 + rnd() * 1.2, 55.8 + rnd() * 0.3] },
      properties: { asset_id: "A-" + String(i).padStart(4, "0"), status: statuses[i % 5], compliant: i % 4 ? "Yes" : "No",
        condition_grade: 1 + (i % 5), risk_score: Math.round(rnd() * 1000) / 10, owner: i % 7 ? "Team " + (i % 3) : null } });
  }
  const sites = [];
  for (let i = 0; i < 12; i++) {
    const x = -4.2 + i * 0.08, y = 55.9;
    sites.push({ type: "Feature", properties: { name: "Site " + i, kind: i % 2 ? "Reservoir" : "Works" },
      geometry: { type: "Polygon", coordinates: [[[x, y], [x + 0.03, y], [x + 0.03, y + 0.02], [x, y + 0.02], [x, y]]] } });
  }
  fs.writeFileSync(path.join(dir, "assets.geojson"), JSON.stringify({ type: "FeatureCollection", features: assets }));
  fs.writeFileSync(path.join(dir, "sites.geojson"), JSON.stringify({ type: "FeatureCollection", features: sites }));
  return [path.join(dir, "assets.geojson"), path.join(dir, "sites.geojson")];
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(CORE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(CORE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.route(/^https:\/\//, (r) => r.fulfill({ status: 204 }));
  await page.goto("http://127.0.0.1:" + server.address().port + "/index.html");
  await page.waitForFunction(() => window.OmaMap);
  await page.evaluate((t) => OmaMap.applyTheme(t), THEME);

  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push("✔ " + name); }
    catch (e) { results.push("✖ " + name + "\n    " + e.message.split("\n").filter(Boolean).slice(0, 14).join(" ")); process.exitCode = 1; }
  };
  const leafStyle = (dsName, index) => page.evaluate(([n, i]) => {
    const ds = STATE.datasets.find((d) => d.name === n);
    const o = ds.layers[i].options;
    return { fillColor: o.fillColor, color: o.color, fillOpacity: o.fillOpacity, weight: o.weight, radius: o.radius };
  }, [dsName, index]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const setView = async (lat, lng, zoom) => {
    await page.waitForFunction(() => !STATE.map._animatingZoom);
    await page.evaluate(([la, ln, z]) => new Promise((resolve) => {
      STATE.map.once("moveend", () => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      STATE.map.setView([la, ln], z, { animate: false });
    }), [lat, lng, zoom]);
  };

  await page.setInputFiles("#file-input", fixtures(path.join(OUT, "fixtures-features")));
  await page.waitForFunction(() => STATE.datasets.length === 2 && document.getElementById("loading").hidden);

  await check("polygons default to a visible fill and outline", async () => {
    const s = await leafStyle("sites", 0);
    assert.equal(s.fillOpacity, 0.35);
    assert.equal(s.weight, 2);
  });

  await check("style editor opens and sliders restyle the dataset", async () => {
    await page.locator('button[aria-label="Style sites"]').click();
    assert.equal(await page.locator(".style-editor").count(), 1);
    await page.locator(".style-editor .st-row", { hasText: "Opacity" }).locator("input[type=range]").fill("0.7");
    await page.locator(".style-editor .st-row", { hasText: "Outline width" }).locator("input[type=range]").fill("4");
    await settle();
    const s = await leafStyle("sites", 3);
    assert.equal(s.fillOpacity, 0.7);
    assert.equal(s.weight, 4);
  });

  await check("outline option uses the theme's text colour", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Outline" }).locator("select").selectOption("fg");
    await settle();
    assert.equal((await leafStyle("sites", 0)).color, "#c0caf5");
  });

  await check("a palette swatch changes the dataset colour", async () => {
    await page.locator(".style-editor .st-swatch").nth(2).click();
    await settle();
    const chosen = await page.evaluate(() => STATE.palette[2]);
    assert.equal((await leafStyle("sites", 0)).fillColor, chosen);
  });

  await check("colour by a status field uses the theme's green / yellow / red", async () => {
    await page.locator('button[aria-label="Close style for sites"]').click();
    await page.locator('button[aria-label="Style assets"]').click();
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("status");
    await settle();
    assert.equal((await leafStyle("assets", 0)).fillColor, "#9ece6a");   // In service
    assert.equal((await leafStyle("assets", 3)).fillColor, "#f7768e");   // Out of service
    assert.equal((await leafStyle("assets", 4)).fillColor, "#e0af68");   // Planned
    const legend = await page.locator("#legend .lg-row").allTextContents();
    assert.deepEqual(legend, ["In service180", "Planned60", "Out of service60"]);
  });

  await check("Yes/No fields are green and red", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("compliant");
    await settle();
    assert.equal((await leafStyle("assets", 1)).fillColor, "#9ece6a");
    assert.equal((await leafStyle("assets", 0)).fillColor, "#f7768e");
  });

  await check("numeric grades read as an ordered ramp that can be reversed", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("condition_grade");
    await settle();
    const g1 = (await leafStyle("assets", 0)).fillColor, g5 = (await leafStyle("assets", 4)).fillColor;
    assert.equal(g1, "#7aa2f7");   // ramp starts at theme blue
    assert.equal(g5, "#f7768e");   // and ends at theme red
    await page.locator(".style-editor .st-row", { hasText: "Reverse ramp" }).locator("input").check();
    await settle();
    assert.equal((await leafStyle("assets", 0)).fillColor, "#f7768e");
    const labels = await page.locator("#legend .lg-label").allTextContents();
    assert.deepEqual(labels, ["1", "2", "3", "4", "5"]);
  });

  await check("continuous numbers use ranges whose counts add up", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("risk_score");
    await settle();
    assert.equal(await page.locator(".style-editor .st-row", { hasText: "Method" }).locator("select").inputValue(), "ranges");
    const counts = (await page.locator("#legend .lg-count").allTextContents()).map(Number);
    assert.ok(counts.length >= 3 && counts.length <= 5, "ranges: " + counts);
    assert.equal(counts.reduce((a, b) => a + b, 0), 300);
  });

  await check("missing values are counted and shown muted", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("owner");
    await settle();
    const missing = await page.locator("#legend .lg-row.muted").textContent();
    assert.match(missing, /Missing/);
    assert.equal((await leafStyle("assets", 0)).fillColor, "#565f89");   // owner null at i=0
  });

  await check("switching theme recolours classified data", async () => {
    await page.locator(".style-editor .st-row", { hasText: "Colour by" }).locator("select").selectOption("compliant");
    const t2 = JSON.parse(JSON.stringify(THEME)); t2.colors.green = "#00ff00";
    await page.evaluate((t) => OmaMap.applyTheme(t), t2);
    await settle();
    assert.equal((await leafStyle("assets", 1)).fillColor, "#00ff00");
    await page.evaluate((t) => OmaMap.applyTheme(t), THEME);
  });

  await page.screenshot({ path: path.join(OUT, "features-style.png") });

  await check("L collapses and expands the legend", async () => {
    await page.locator("#map").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("l");
    assert.equal(await page.locator("#legend .lg-row").count(), 0);
    await page.keyboard.press("l");
    assert.ok(await page.locator("#legend .lg-row").count() > 0);
  });

  await check("T opens the table with every row, drawn virtually", async () => {
    await page.keyboard.press("Escape");
    await page.keyboard.press("t");
    await page.waitForSelector("#table-panel:not([hidden])");
    assert.equal(await page.locator("#tp-count").textContent(), "12 rows");     // topmost dataset first
    await page.selectOption("#tp-dataset", { label: "assets (300)" });
    assert.equal(await page.locator("#tp-count").textContent(), "300 rows");
    await settle();
    const drawn = await page.locator(".tp-row").count();
    assert.ok(drawn > 10 && drawn < 300, "drawn rows: " + drawn);
    const headers = await page.locator(".tp-hcell").allTextContents();
    assert.deepEqual(headers, ["#", "asset_id", "status", "compliant", "condition_grade", "risk_score", "owner"]);
  });

  await check("search narrows rows", async () => {
    await page.fill("#tp-search", "out of service");
    await page.waitForFunction(() => document.getElementById("tp-count").textContent.startsWith("60 of"));
    await page.fill("#tp-search", "");
    await page.waitForFunction(() => document.getElementById("tp-count").textContent === "300 rows");
  });

  await check("sorting a numeric column orders numerically, then descending", async () => {
    await page.locator(".tp-hcell", { hasText: "risk_score" }).click();
    await settle();
    const first = Number(await page.locator(".tp-row").first().locator(".tp-cell").nth(5).textContent());
    const min = await page.evaluate(() => Math.min(...STATE.datasets.find((d) => d.name === "assets").features.map((f) => f.properties.risk_score)));
    assert.equal(first, min);
    await page.locator(".tp-hcell", { hasText: "risk_score" }).click();
    await settle();
    const top = Number(await page.locator(".tp-row").first().locator(".tp-cell").nth(5).textContent());
    const max = await page.evaluate(() => Math.max(...STATE.datasets.find((d) => d.name === "assets").features.map((f) => f.properties.risk_score)));
    assert.equal(top, max);
  });

  await check("clicking a row selects the feature and brings it into view", async () => {
    const row = page.locator(".tp-row").nth(2);
    const id = await row.locator(".tp-cell").nth(1).textContent();
    await row.click();
    await page.waitForFunction(() => !STATE.map._animatingZoom);
    assert.equal(await page.locator("#inspector").isHidden(), false);
    const shown = await page.locator("#insp-attrs tr", { hasText: "asset_id" }).textContent();
    assert.ok(shown.includes(id), shown + " vs " + id);
    const inView = await page.evaluate(() => { const h = currentHit(); return STATE.map.getBounds().contains(h.layer.getLatLng()); });
    assert.equal(inView, true);
    assert.equal(await page.locator(".tp-row.selected").count(), 1);
  });

  await check("arrow keys step through rows and follow on the map", async () => {
    const before = await page.evaluate(() => currentHit().layer._omaIndex);
    await page.locator("#tp-scroll").focus();
    await page.keyboard.press("ArrowDown");
    const after = await page.evaluate(() => currentHit().layer._omaIndex);
    assert.notEqual(after, before);
    assert.equal(await page.locator(".tp-row.selected .tp-num").textContent(), String(after + 1));
  });

  await check("selecting on the map switches the table and highlights the row", async () => {
    await setView(55.91, -4.185, 14);
    const pt = await page.evaluate(() => {
      const p = STATE.map.latLngToContainerPoint([55.91, -4.185]);
      const r = document.getElementById("map").getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.click(pt.x, pt.y);
    // The click switches the table to "sites" and redraws it asynchronously;
    // wait for the redraw so we don't read the stale assets row selected by
    // the previous arrow-key test.
    await page.waitForFunction(() => {
      const c = document.querySelectorAll(".tp-row.selected .tp-cell");
      return c.length > 1 && c[1].textContent === "Site 0";
    }, null, { timeout: 5000 });
    assert.match(await page.locator("#tp-dataset option:checked").textContent(), /^sites/);
    assert.equal(await page.locator(".tp-row.selected").count(), 1);
    assert.equal(await page.locator(".tp-row.selected .tp-cell").nth(1).textContent(), "Site 0");
  });

  await check("in view only filters rows to the visible map", async () => {
    await page.check("#tp-inview");
    await page.waitForFunction(() => /of 12 rows/.test(document.getElementById("tp-count").textContent));
    await page.uncheck("#tp-inview");
    await page.waitForFunction(() => document.getElementById("tp-count").textContent === "12 rows");
  });

  await page.screenshot({ path: path.join(OUT, "features-table.png") });

  await check("removing the table's dataset moves the table to another", async () => {
    await page.locator('button[aria-label="Remove sites"]').click();
    assert.match(await page.locator("#tp-dataset option:checked").textContent(), /^assets/);
    await page.keyboard.press("t");
    assert.equal(await page.locator("#table-panel").isHidden(), true);
  });

  await check("a saved profile reopens with data, styles, visibility, view and basemap", async () => {
    await page.evaluate(() => clearAll());
    await page.setInputFiles("#file-input", [path.join(OUT, "fixtures-features", "assets.geojson"), path.join(OUT, "fixtures-features", "sites.geojson")]);
    await page.waitForFunction(() => STATE.datasets.length === 2 && document.getElementById("loading").hidden);
    const before = await page.evaluate(() => {
      const assets = STATE.datasets.find((d) => d.name === "assets"), sites = STATE.datasets.find((d) => d.name === "sites");
      setColourBy(assets, "condition_grade", "categories", true);
      applyDatasetStyle(assets);
      sites.style.colour = "#123456"; sites.style.outline = "fg"; sites.style.fillOpacity = 0.6;
      applyDatasetStyle(sites);
      toggleVisible(sites.id);
      setBasemap("topo", true);
      return { order: STATE.datasets.map((d) => d.name), colours: assets.layers.slice(0, 5).map((l) => l.options.fillColor) };
    });
    await setView(55.95, -3.9, 12);
    const [download] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    assert.match(download.suggestedFilename(), /^OmaMap \d{4}-\d{2}-\d{2} \d{4}\.omamap$/);
    const saved = path.join(OUT, "roundtrip.omamap");
    await download.saveAs(saved);

    await page.evaluate(() => { clearAll(); setBasemap("streets", true); STATE.map.setView([50, 0], 5, { animate: false }); });
    await page.setInputFiles("#file-input", saved);
    await page.waitForFunction(() => STATE.datasets.length === 2 && document.getElementById("loading").hidden);
    const after = await page.evaluate(() => {
      const assets = STATE.datasets.find((d) => d.name === "assets"), sites = STATE.datasets.find((d) => d.name === "sites");
      const c = STATE.map.getCenter();
      return {
        order: STATE.datasets.map((d) => d.name), colours: assets.layers.slice(0, 5).map((l) => l.options.fillColor),
        byField: { field: assets.style.byField.field, mode: assets.style.byField.mode, reverse: assets.style.byField.reverse },
        sites: { visible: sites.visible, colour: sites.style.colour, outline: sites.style.outline, fillOpacity: sites.style.fillOpacity },
        view: [Math.round(c.lat * 100) / 100, Math.round(c.lng * 100) / 100, STATE.map.getZoom()], basemap: STATE.basemapId
      };
    });
    assert.deepEqual(after.order, before.order);
    assert.deepEqual(after.colours, before.colours);
    assert.deepEqual(after.byField, { field: "condition_grade", mode: "categories", reverse: true });
    assert.deepEqual(after.sites, { visible: false, colour: "#123456", outline: "fg", fillOpacity: 0.6 });
    assert.deepEqual(after.view, [55.95, -3.9, 12]);
    assert.equal(after.basemap, "topo");
  });

  await check("opening a profile over open datasets asks first", async () => {
    let asked = null;
    page.once("dialog", (d) => { asked = d.message(); d.dismiss(); });
    await page.setInputFiles("#file-input", path.join(OUT, "roundtrip.omamap"));
    await page.waitForFunction(() => document.getElementById("loading").hidden);
    await page.waitForTimeout(200);
    assert.match(asked || "", /replaces the 2 datasets/);
    assert.equal(await page.evaluate(() => STATE.datasets.length), 2);
  });

  /* ------------------------------ Reliability ------------------------------ */
  const makeFile = (name, n) => page.evaluateHandle(([name, n]) => {
    const f = []; for (let i = 0; i < n; i++) f.push({ type: "Feature", properties: { i: i }, geometry: { type: "Point", coordinates: [-3 + (i % 100) * 0.001, 56 + Math.floor(i / 100) * 0.001] } });
    return new File([JSON.stringify({ type: "FeatureCollection", features: f })], name);
  }, [name, n]);

  await check("drops made while a load is running are queued, not interleaved", async () => {
    await page.evaluate(() => clearAll());
    const a = await makeFile("first.geojson", 50000), b = await makeFile("second.geojson", 10);
    const order = await page.evaluate(async ([a, b]) => {
      await Promise.all([handleFiles([a]), handleFiles([b])]);
      return { seen: STATE.datasets.map(d => d.name), spinnerHidden: document.getElementById("loading").hidden };
    }, [a, b]);
    assert.deepEqual(order.seen, ["first", "second"]);
    assert.equal(order.spinnerHidden, true);
  });

  await check("a worker crash fails only the in-flight file, and loading keeps working", async () => {
    await page.evaluate(() => clearAll());
    const big = await makeFile("crashy.geojson", 200000), ok = await makeFile("after.geojson", 5);
    const result = await page.evaluate(async ([big, ok]) => {
      // Crash the worker the moment it receives the file: what a worker
      // crash (e.g. out of memory) delivers is an error event.
      const crashed = Parser.worker;
      const run = Parser.run;
      Parser.run = function (message, transfer) {
        Parser.run = run;
        const pending = run.call(Parser, message, transfer);
        crashed.onerror({ preventDefault: function () {} });
        return pending;
      };
      await handleFiles([big]);
      await handleFiles([ok]);
      return { names: STATE.datasets.map((d) => d.name), fresh: !!Parser.worker && Parser.worker !== crashed, spinnerHidden: document.getElementById("loading").hidden,
        toasts: Array.from(document.querySelectorAll(".toast.err")).map((t) => t.textContent) };
    }, [big, ok]);
    assert.deepEqual(result.names, ["after"]);
    assert.equal(result.fresh, true);
    assert.equal(result.spinnerHidden, true);
    assert.ok(result.toasts.some((t) => /crashy/.test(t) && /stopped unexpectedly/.test(t)), JSON.stringify(result.toasts));
  });

  await check("Cancel stops a slow load and the next load works", async () => {
    await page.evaluate(() => { clearAll(); document.querySelectorAll(".toast").forEach((t) => t.remove()); });
    const big = await makeFile("slow.geojson", 200000), next = await makeFile("next.geojson", 3);
    const loading = page.evaluate((big) => handleFiles([big]), big);
    await page.waitForSelector("#loading:not([hidden])");
    await page.click("#loading-cancel");
    await loading;
    assert.equal(await page.locator("#loading").isHidden(), true);
    assert.match(await page.locator(".toast.warn").first().textContent(), /cancelled/i);
    await page.evaluate((f) => handleFiles([f]), next);
    assert.deepEqual(await page.evaluate(() => STATE.datasets.map((d) => d.name)), ["next"]);
  });

  await check("cancelling a profile restore leaves the open workspace untouched", async () => {
    const r = await page.evaluate(async () => {
      clearAll();
      const pts = (n, x) => ({ type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [x + (i % 300) * 0.001, 55 + Math.floor(i / 300) * 0.001] }, properties: { id: i } })) });
      addDataset({ name: "keep A", geojson: pts(10, -4) });
      addDataset({ name: "keep B", geojson: pts(10, -3) });
      STATE.map.stop(); STATE.map.setView([55, -3.5], 8, { animate: false });
      const before = STATE.map.getCenter();
      const profile = { omamap: "profile", version: 1, view: { lat: 10, lng: 10, zoom: 5 }, basemap: "none",
        datasets: [{ name: "p1", geojson: pts(60000, 1) }, { name: "p2", geojson: pts(60000, 2) }, { name: "p3", geojson: pts(60000, 3) }] };
      const parsed = await OmaParse.parseBytes("w.omamap", new TextEncoder().encode(JSON.stringify(profile)).buffer);
      cancelledLoad = false;
      const restoring = restoreProfile(parsed);
      setTimeout(() => { cancelledLoad = true; }, 30);
      let error = null;
      try { await restoring; } catch (e) { error = e instanceof LoadCancelled ? "cancelled" : e.message; }
      cancelledLoad = false;
      const kept = STATE.datasets.map((d) => d.name);
      const onMap = STATE.datasets.every((d) => STATE.map.hasLayer(d.layer));
      const pointLayers = Object.values(STATE.map._layers).filter((l) => l instanceof FastPoints).length;
      const after = STATE.map.getCenter();
      // A complete restore still works afterwards.
      await restoreProfile(parsed);
      return { error, kept, onMap, pointLayers, moved: before.distanceTo(after) > 1, restored: STATE.datasets.map((d) => d.name) };
    });
    assert.equal(r.error, "cancelled");
    assert.deepEqual(r.kept, ["keep A", "keep B"]);
    assert.equal(r.onMap, true);
    assert.equal(r.pointLayers, 2, "no half-restored layers remain on the map");
    assert.equal(r.moved, false, "the saved view was not applied");
    assert.deepEqual(r.restored, ["p1", "p2", "p3"]);
  });

  await check("KML and GPX inside a ZIP, and KMZ files, open as datasets", async () => {
    const fflate = require(path.join(CORE, "vendor/fflate.js"));
    const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Pier</name><Point><coordinates>-3.2,55.9</coordinates></Point></Placemark><Placemark><LineString><coordinates>-3.2,55.9 -3.1,55.95</coordinates></LineString></Placemark></kml>';
    const gpx = '<?xml version="1.0"?><gpx version="1.1" creator="t"><wpt lat="55.9" lon="-3.3"><name>Start</name></wpt></gpx>';
    const dir = path.join(OUT, "fixtures-xml-zip"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "bundle.zip"), fflate.zipSync({ "doc.kml": fflate.strToU8(kml), "walk.gpx": fflate.strToU8(gpx) }));
    fs.writeFileSync(path.join(dir, "trip.kmz"), fflate.zipSync({ "doc.kml": fflate.strToU8(kml), "files/icon.png": new Uint8Array([1, 2, 3]) }));
    await page.evaluate(() => { clearAll(); document.querySelectorAll(".toast").forEach((t) => t.remove()); });
    await page.setInputFiles("#file-input", [path.join(dir, "bundle.zip"), path.join(dir, "trip.kmz")]);
    await page.waitForFunction(() => STATE.datasets.length === 3 && document.getElementById("loading").hidden);
    const r = await page.evaluate(() => ({ sets: STATE.datasets.map((d) => d.name + ":" + d.featureCount).sort(), errors: document.querySelectorAll(".toast.err").length }));
    assert.deepEqual(r.sets, ["bundle / doc:2", "bundle / walk:1", "trip:2"]);
    assert.equal(r.errors, 0);
  });

  await check("a large KML converts in slices and Cancel stops it", async () => {
    await page.evaluate(() => { clearAll(); document.querySelectorAll(".toast").forEach((t) => t.remove()); });
    const r = await page.evaluate(async () => {
      let kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>';
      for (let i = 0; i < 40000; i++) kml += "<Placemark><name>P" + i + "</name><Point><coordinates>" + (-4 + (i % 200) * 0.01) + "," + (55 + Math.floor(i / 200) * 0.005) + "</coordinates></Point></Placemark>";
      kml += "</Document></kml>";
      let frames = 0, counting = true;
      const tick = () => { frames++; if (counting) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const loading = handleFiles([new File([kml], "big.kml")]);
      await new Promise((res) => setTimeout(res, 150));
      cancelledLoad = true;
      await loading;
      counting = false;
      return { frames, datasets: STATE.datasets.length, warn: Array.from(document.querySelectorAll(".toast.warn")).map((t) => t.textContent).join(" ") };
    });
    assert.equal(r.datasets, 0);
    assert.match(r.warn, /cancelled/i);
    assert.ok(r.frames >= 2, "the page kept painting while the KML converted (" + r.frames + " frames)");
  });

  // Draw a row of points with each renderer and check the pixels land where
  // Leaflet says the points are.
  for (const renderer of ["webgl", "2d"]) {
    await check("point renderer (" + renderer + ") draws points where they are", async () => {
      const result = await page.evaluate(async (mode) => {
        FastPoints.disableWebGL = mode === "2d";
        FastPoints.glMinPoints = 1;   // exercise WebGL even for a small layer
        clearAll();
        const feats = [];
        for (let i = 0; i < 20; i++) feats.push({ type: "Feature", properties: { i: i }, geometry: { type: "Point", coordinates: [-3 + i * 0.02, 56] } });
        const ds = addDataset({ name: "px", geojson: { type: "FeatureCollection", features: feats } });
        await new Promise((r) => { STATE.map.once("moveend", r); STATE.map.setView([56, -2.8], 10, { animate: false }); });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const layer = ds.layer;
        // Copy the points canvas onto a 2D canvas so both modes read the same way.
        const copy = document.createElement("canvas");
        copy.width = layer._canvas.width; copy.height = layer._canvas.height;
        if (mode === "webgl") layer._draw();   // WebGL buffers are only readable in the frame they are drawn
        copy.getContext("2d").drawImage(layer._canvas, 0, 0);
        const ctx = copy.getContext("2d");
        const dpr = window.devicePixelRatio || 1;
        const alphaAt = (x, y) => ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data[3];
        const hits = [], misses = [];
        for (let i = 0; i < 20; i++) {
          const p = layer._layerPoint(i).subtract(layer._pxBounds.min);
          hits.push(alphaAt(p.x, p.y));
          misses.push(alphaAt(p.x, p.y + 30));   // well clear of any point
        }
        FastPoints.disableWebGL = false;
        FastPoints.glMinPoints = 1000;
        return { mode: layer._mode, hits: hits, misses: misses };
      }, renderer);
      assert.equal(result.mode, renderer);
      assert.ok(result.hits.every((a) => a > 150), "point centres not drawn: " + result.hits);
      assert.ok(result.misses.every((a) => a === 0), "pixels drawn where no point is: " + result.misses);
    });
  }

  await check("GPU contexts are reused on hide/show and released on remove", async () => {
    const r = await page.evaluate(async () => {
      clearAll();
      FastPoints.glMinPoints = 1;
      const make = (n) => ({ type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [-3 + i * 0.001, 56] } })) });
      const added = [];
      for (let i = 0; i < 12; i++) added.push(addDataset({ name: "L" + i, geojson: make(5) }));
      const live = FastPoints.glLive, modes = added.map((d) => d.layer._mode);
      const gl = added[0].layer._gl;
      toggleVisible(added[0].id); toggleVisible(added[0].id); toggleVisible(added[0].id); toggleVisible(added[0].id);
      const reused = added[0].layer._gl === gl && FastPoints.glLive === live;
      clearAll();
      FastPoints.glMinPoints = 1000;
      return { live: live, webgl: modes.filter((m) => m === "webgl").length, reused: reused, after: FastPoints.glLive };
    });
    assert.equal(r.webgl, 8, "at most 8 WebGL layers");
    assert.equal(r.live, 8);
    assert.equal(r.reused, true);
    assert.equal(r.after, 0, "contexts released after clearing");
  });

  await check("late fields, object labels and removed table data stay correct", async () => {
    const result = await page.evaluate(() => {
      clearAll();
      const features = Array.from({length:5001}, () => ({type:"Feature",geometry:{type:"Point",coordinates:[0,0]},properties:{}}));
      features[5000].properties.late = "present";
      features[0].properties.name = {toString:null,valueOf:null};
      const ds = addDataset({name:"regression",geojson:OmaParse.validateFeatureCollection({type:"FeatureCollection",features})});
      Table.open(ds); Table.choose(0,false);
      const late = Table.columns.some(c => c.field === "late");
      const label = el("insp-ds").textContent;
      Table.close(); removeDataset(ds.id);
      return {late,label,last:Table.last,ds:Table.ds,order:Table.order,cache:ds.rowText};
    });
    assert.equal(result.late,true);
    assert.equal(result.label,'{"toString":null,"valueOf":null}');
    assert.equal(result.last,null); assert.equal(result.ds,null); assert.equal(result.order,null); assert.equal(result.cache,null);
  });

  await check("mixed datasets keep fast points and reuse GPU uploads while navigating", async () => {
    const result = await page.evaluate(async () => {
      clearAll();
      const features = Array.from({length:1200}, (_,i) => ({type:"Feature",properties:{id:i},geometry:{type:"Point",coordinates:[-3+i*0.0000001,56]}}));
      features.push({type:"Feature",properties:{},geometry:{type:"Polygon",coordinates:[[[-3.01,55.99],[-2.99,55.99],[-2.99,56.01],[-3.01,56.01],[-3.01,55.99]]]}});
      const ds = addDataset({name:"mixed",geojson:{type:"FeatureCollection",features}});
      STATE.map.setView([56,-3],22,{animate:false});
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await frame();
      const group=ds.layers[0]._group, gl=group._gl;
      if (!gl) throw new Error("WebGL unavailable in mixed rendering regression");
      const center=STATE.map.latLngToLayerPoint([56,-3]);
      const x=Math.round((center.x-group._pxBounds.min.x)*(devicePixelRatio||1));
      const y=group._canvas.height-1-Math.round((center.y-group._pxBounds.min.y)*(devicePixelRatio||1));
      group._draw(); // read before the non-preserved WebGL buffer is presented
      const pixel=new Uint8Array(4); gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
      const hits=identify(center).length;
      let uploads=0;
      const data=gl.bufferData.bind(gl), sub=gl.bufferSubData.bind(gl);
      gl.bufferData=(...args)=>{uploads++;return data(...args)};
      gl.bufferSubData=(...args)=>{uploads++;return sub(...args)};
      STATE.map.panBy([15,0],{animate:false}); await frame();
      STATE.map.setZoom(21,{animate:false}); await frame();
      const fast=ds.layers.slice(0,1200).every(l=>l.isFastPoint);
      const live=FastPoints.glLive;
      clearAll();
      return {fast,uploads,alpha:pixel[3],hits,live,after:FastPoints.glLive};
    });
    assert.equal(result.fast,true); assert.equal(result.uploads,0);
    assert.ok(result.alpha>150,'split GPU coordinates stay accurate at zoom 22');
    assert.ok(result.hits>1); assert.ok(result.live>0); assert.equal(result.after,0);
  });

  await check("an old asynchronous table search cannot restore removed data", async () => {
    const result=await page.evaluate(async()=>{
      clearAll();
      const features=Array.from({length:20000},(_,i)=>({type:"Feature",geometry:{type:"Point",coordinates:[0,0]},properties:{id:i,name:"row "+i}}));
      const ds=addDataset({name:"table cancellation",geojson:{type:"FeatureCollection",features}});
      Table.open(ds); Table.query="row"; const pending=Table.refilter();
      clearAll(); await pending;
      return {last:Table.last,ds:Table.ds,order:Table.order};
    });
    assert.deepEqual(result,{last:null,ds:null,order:null});
  });

  await check("no page errors", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  console.log(results.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
