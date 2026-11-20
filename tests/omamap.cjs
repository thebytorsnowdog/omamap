"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("playwright-core");

const ORIGIN = "http://omamap.invalid";
const CORE = path.join(__dirname, "..", "core");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const POINTS = {
  type: "FeatureCollection",
  features: ["Keep this row", "Omit this row"].map((name, i) => ({
    type: "Feature", properties: { name }, geometry: { type: "Point", coordinates: [i, 1] }
  }))
};

test("OmaMap keeps tile choice local to the user and exports the latest filter", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium" });
  try {
    const context = await browser.newContext();
    const tileAttempts = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) {
        tileAttempts.push(url.hostname);
        return route.fulfill({ status: 204 });
      }
      const file = path.resolve(CORE, "." + url.pathname);
      if (!file.startsWith(CORE + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile())
        return route.fulfill({ status: 404 });
      return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] });
    });
    await context.addInitScript(() => localStorage.setItem("omamap.basemap", "satellite"));

    const page = await context.newPage();
    const choose = (id) => page.locator('#basemaps button[data-id="' + id + '"]').click();
    const basemap = () => page.evaluate(() => STATE.basemapId);
    const importProfile = async (name, content) => {
      await page.setInputFiles("#file-input", { name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(content)) });
      await page.evaluate(() => loadQueue);
    };
    const ready = async () => {
      await page.goto(ORIGIN + "/index.html");
      await page.waitForFunction(() => STATE.basemapId !== null);
    };
    const profile = {
      omamap: "profile", version: 1, basemap: "topo", view: { lat: 20, lng: 10, zoom: 9 },
      datasets: [{ name: "Fixture", geojson: POINTS }]
    };

    await ready();
    assert.equal(await basemap(), "none", "legacy preferences could come from a profile");
    await choose("none");
    await importProfile("old.omamap", profile);
    assert.equal(await basemap(), "none");
    assert.equal(await page.evaluate(() => STATE.datasets[0].features.length), 2);
    assert.equal(await page.evaluate(() => STATE.map.getZoom()), 9);
    assert.deepEqual(tileAttempts, [], "opening an online profile with None issues no tile requests");

    await ready();
    assert.equal(await basemap(), "none", "the choice survives a reload");
    await Promise.all([
      page.waitForRequest((request) => new URL(request.url()).hostname === "tile.openstreetmap.org", { timeout: 5000 }),
      choose("streets")
    ]);
    await importProfile("old.sdv-profile.json", {
      __sdv_profile: true, map: { center: [10, 20], zoom: 8, basemap: "none" },
      datasets: profile.datasets
    });
    assert.equal(await basemap(), "streets");
    assert.equal(await page.evaluate(() => STATE.map.getZoom()), 8);
    assert.ok(tileAttempts.every((host) => host === "tile.openstreetmap.org"));

    await page.evaluate(async () => {
      Table.open(STATE.datasets[0]);
      await Table.pending;
    });
    assert.equal(await page.locator("#tp-count").textContent(), "2 rows");
    const download = page.waitForEvent("download", { timeout: 5000 });
    await page.evaluate(() => {
      const input = document.getElementById("tp-search");
      input.value = "Keep this";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("tp-export-csv").click();
    });
    const csv = fs.readFileSync(await (await download).path(), "utf8");
    assert.match(csv, /Keep this row/);
    assert.doesNotMatch(csv, /Omit this row/);

    await ready();
    assert.equal(await basemap(), "streets", "an explicitly chosen provider survives a reload");
  } finally {
    await browser.close();
  }
});
