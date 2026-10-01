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

  // Draw a row of points with each renderer and check the pixels land where
  // Leaflet says the points are.
  for (const renderer of ["webgl", "2d"]) {
    await check("point renderer (" + renderer + ") draws points where they are", async () => {
      const result = await page.evaluate(async (mode) => {
        FastPoints.disableWebGL = mode === "2d";
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
        return { mode: layer._mode, hits: hits, misses: misses };
      }, renderer);
      assert.equal(result.mode, renderer);
      assert.ok(result.hits.every((a) => a > 150), "point centres not drawn: " + result.hits);
      assert.ok(result.misses.every((a) => a === 0), "pixels drawn where no point is: " + result.misses);
    });
  }

  await check("no page errors", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  console.log(results.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
