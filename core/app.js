"use strict";
/* ---------------------------------------------------------------------------
   OmaMap: view spatial datasets over a background map and inspect features.
   Parsing lives in parse.js (normally in a worker), styling in style.js and
   the attribute table in table.js; this file owns the map, dataset list,
   selection and attribute inspector.
--------------------------------------------------------------------------- */

const MAX_DATASETS = 50;
const MAX_FILES_PER_DROP = 100;
const STORAGE_KEYS = { basemap: "omamap.basemap", view: "omamap.view" };

const STATE = {
  map: null,
  renderer: null,
  baseLayer: null,
  basemapPref: "auto",    // "auto" follows the theme: light or dark
  basemapId: null,        // effective basemap
  mode: "dark",
  palette: [],
  themeColors: {},
  datasets: [],           // { id, name, slot, layer, features, layers, style, featureCount, geomTypes, visible, warnings }
  styleOpenId: null,      // dataset whose style editor is open
  nextId: 1,
  nextSlot: 0,
  hits: [],               // [{ ds, layer }] under the last click, topmost first
  hitIndex: 0,
  themeVersion: 0         // bumped on every theme change; invalidates colour caches
};

/* ------------------------------ Utilities -------------------------------- */
function el(id) { return document.getElementById(id); }

function storageGet(key) {
  try { return window.localStorage.getItem(key); } catch (e) { return null; }
}
function storageSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
}

function toast(title, message, kind) {
  const t = document.createElement("div");
  t.className = "toast " + (kind || "info");
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  const tt = document.createElement("div"); tt.textContent = title;
  t.appendChild(tt);
  if (message) { const tm = document.createElement("div"); tm.className = "t-msg"; tm.textContent = message; t.appendChild(tm); }
  const close = document.createElement("button");
  close.type = "button"; close.className = "icon-btn"; close.setAttribute("aria-label", "Dismiss"); close.textContent = "×";
  close.addEventListener("click", function () { t.remove(); });
  t.appendChild(close);
  el("toasts").appendChild(t);
  setTimeout(function () { t.remove(); }, kind === "err" ? 12000 : 5000);
}

function setStatus(text) { el("status-text").textContent = text; }

function setLoading(on, msg) {
  el("loading").hidden = !on;
  if (msg) el("loading-msg").textContent = msg;
}

function plural(n, word) { return n.toLocaleString() + " " + word + (n === 1 ? "" : "s"); }

/* ------------------------------- Theme ----------------------------------- */
// Keys from Omarchy's colors.toml mapped to CSS variables.
const THEME_VARS = {
  background: "--bg", dark_background: "--bg-alt", darker_background: "--bg-deep",
  lighter_background: "--bg-raised", foreground: "--fg", dark_foreground: "--fg-dim",
  muted: "--muted", accent: "--accent", selection: "--selection",
  red: "--red", green: "--green", yellow: "--yellow"
};
const PALETTE_KEYS = ["blue", "green", "magenta", "cyan", "yellow", "red", "orange", "brown",
  "bright_blue", "bright_green", "bright_magenta", "bright_cyan", "bright_yellow", "bright_red"];
const FALLBACK_PALETTE = ["#7aa2f7", "#9ece6a", "#bb9af7", "#7dcfff", "#e0af68", "#f7768e", "#ff9e64", "#c0a36e"];

function isHex(v) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v); }

// Theme values are read for every feature when styling, so cache them; the
// cache is cleared whenever the theme changes.
const cssCache = new Map();
function cssVar(name) {
  let v = cssCache.get(name);
  if (v === undefined) {
    v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    cssCache.set(name, v);
  }
  return v;
}

/* Called by the host with the parsed colors.toml, mode and UI font. */
function applyTheme(theme) {
  theme = theme || {};
  const colors = theme.colors || {};
  const rootStyle = document.documentElement.style;
  cssCache.clear();
  STATE.themeVersion++;
  // Keys missing from this theme fall back to the stylesheet defaults rather
  // than keeping the previous theme's value.
  Object.keys(THEME_VARS).forEach(function (key) {
    if (isHex(colors[key])) rootStyle.setProperty(THEME_VARS[key], colors[key]);
    else rootStyle.removeProperty(THEME_VARS[key]);
  });
  if (typeof theme.font === "string" && /^[\w .,'"-]{1,80}$/.test(theme.font)) {
    rootStyle.setProperty("--font", '"' + theme.font.replace(/["']/g, "") + '", ui-monospace, monospace');
  }
  STATE.mode = theme.mode === "light" ? "light" : "dark";
  STATE.themeColors = colors;
  document.documentElement.setAttribute("data-mode", STATE.mode);
  // Dataset colours: the theme's hues, minus the accent (reserved for selection).
  const accent = String(colors.accent || cssVar("--accent")).toLowerCase();
  const palette = [];
  PALETTE_KEYS.forEach(function (key) {
    const c = colors[key];
    if (isHex(c) && c.toLowerCase() !== accent && palette.indexOf(c.toLowerCase()) < 0) palette.push(c.toLowerCase());
  });
  STATE.palette = palette.length >= 4 ? palette : FALLBACK_PALETTE.filter(function (c) { return c !== accent; });
  STATE.datasets.forEach(applyDatasetStyle);
  highlightSelection();
  if (typeof Table !== "undefined" && Table.onThemeChanged) Table.onThemeChanged();
  renderLayerList();
  renderLegend();
  if (STATE.map) setBasemap(STATE.basemapPref, false);
}

function datasetColour(ds) {
  return (ds.style && ds.style.colour) || STATE.palette[ds.slot % STATE.palette.length];
}

/* ------------------------------ Basemaps --------------------------------- */
function effectiveBasemap(pref) {
  if (pref === "auto") return STATE.mode === "light" ? "light" : "dark";
  return OMAMAP_BASEMAPS.some(function (b) { return b.id === pref; }) ? pref : "dark";
}

function setBasemap(pref, remember) {
  STATE.basemapPref = pref;
  if (remember) storageSet(STORAGE_KEYS.basemap, pref);
  const id = effectiveBasemap(pref);
  if (id !== STATE.basemapId) {
    if (STATE.baseLayer) STATE.map.removeLayer(STATE.baseLayer);
    STATE.baseLayer = null;
    const def = OMAMAP_BASEMAPS.find(function (b) { return b.id === id; });
    if (def && def.url) {
      const options = {
        subdomains: def.subdomains || "abc",
        maxNativeZoom: def.maxNativeZoom || 19,
        maxZoom: 22,
        crossOrigin: true
      };
      const base = L.tileLayer(def.url, Object.assign({ attribution: def.attribution }, options));
      const layers = [base];
      // Labels sit above the data so place names stay readable.
      if (def.labels) layers.push(L.tileLayer(def.labels, Object.assign({ pane: "labels" }, options)));
      STATE.baseLayer = L.layerGroup(layers).addTo(STATE.map);
    }
    STATE.basemapId = id;
  }
  document.querySelectorAll("#basemaps button").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.id === id));
  });
}

function cycleBasemap(step) {
  const ids = OMAMAP_BASEMAPS.map(function (b) { return b.id; });
  const i = ids.indexOf(STATE.basemapId);
  const next = ids[(i + step + ids.length) % ids.length];
  setBasemap(next, true);
  setStatus("Basemap: " + OMAMAP_BASEMAPS.find(function (b) { return b.id === next; }).label + ".");
}

function renderBasemapButtons() {
  const group = el("basemaps");
  OMAMAP_BASEMAPS.forEach(function (b, i) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.id = b.id;
    button.title = b.label + " (" + (i + 1) + ")";
    const num = document.createElement("span"); num.className = "num"; num.textContent = String(i + 1);
    button.appendChild(num);
    button.appendChild(document.createTextNode(b.label));
    button.addEventListener("click", function () { setBasemap(b.id, true); });
    group.appendChild(button);
  });
}

/* ------------------------------ Styling ---------------------------------- */
function eachLeaf(layer, fn) {
  if (typeof layer.eachLayer === "function" && !(layer instanceof L.Path)) layer.eachLayer(function (child) { eachLeaf(child, fn); });
  else fn(layer);
}

function leafStyle(leaf, colour, style, selected) {
  const accent = cssVar("--accent");
  const outline = style.outline === "fg" ? cssVar("--fg") : style.outline === "bg" ? cssVar("--bg-deep") : null;
  if (leaf.isFastPoint || leaf instanceof L.CircleMarker) {
    if (selected) return { radius: style.radius + 3.5, color: accent, weight: 3, fillColor: colour, fillOpacity: 1, opacity: 1 };
    return {
      radius: style.radius, fillColor: colour, fillOpacity: style.fillOpacity,
      color: outline || cssVar("--bg-deep"), weight: style.outline === "none" ? 0 : 1.5, opacity: 0.9
    };
  }
  if (leaf instanceof L.Polygon) {
    if (selected) return { color: accent, weight: Math.max(3.5, style.weight + 1.5), fillColor: colour, fillOpacity: Math.min(1, style.fillOpacity + 0.2), opacity: 1 };
    return {
      color: outline || colour, weight: style.outline === "none" ? 0 : style.weight, opacity: 0.95,
      fillColor: colour, fillOpacity: style.fillOpacity
    };
  }
  if (selected) return { color: accent, weight: style.weight + 3, opacity: 1 };
  return { color: colour, weight: style.weight, opacity: 0.95 };
}

function leafKind(leaf) {
  return leaf.isFastPoint || leaf instanceof L.CircleMarker ? "p" : leaf instanceof L.Polygon ? "a" : "l";
}

// Features that look the same share one style object (treated as read-only),
// so restyling a large dataset allocates per class, not per feature.
function styleFeatureLayer(layer, ds, selected, cache) {
  const colour = featureColour(ds, layer._omaIndex);
  eachLeaf(layer, function (leaf) {
    if (!leaf.setStyle) return;
    const kind = leafKind(leaf);
    const key = kind + colour + (selected ? "!" : "");
    let st = cache && cache.get(key);
    if (!st) {
      st = leafStyle(leaf, colour, ds.style, selected);
      if (cache) cache.set(key, st);
    }
    leaf.setStyle(st);
  });
}

function applyDatasetStyle(ds) {
  const cache = new Map();
  const layers = ds.layers;
  for (let i = 0; i < layers.length; i++) styleFeatureLayer(layers[i], ds, false, cache);
}

/* ------------------------------ Datasets --------------------------------- */
function findDs(id) { return STATE.datasets.find(function (d) { return d.id === id; }); }

function geometrySummary(geojson) {
  const set = {};
  geojson.features.forEach(function (f) {
    const g = f.geometry;
    if (g.type === "GeometryCollection") g.geometries.forEach(function (gg) { set[gg.type] = true; });
    else set[g.type] = true;
  });
  return Object.keys(set);
}

// Drive a generator in short slices so painting, input and Cancel can run
// between them. Cancel stops it at the next slice.
async function runSliced(job) {
  let started = performance.now();
  while (true) {
    if (cancelledLoad) { job.return(); throw new LoadCancelled("Loading cancelled."); }
    const step = job.next();
    if (step.done) return step.value;
    if (performance.now() - started >= 8) {
      await new Promise(resolve => setTimeout(resolve, 0)); started = performance.now();
    }
  }
}

// The synchronous wrapper serves small programmatic additions; file imports
// drive the same generator in short batches so painting and Cancel can run.
function addDataset(parsed) {
  const job = prepareDataset(parsed);
  let step;
  do { step = job.next(); } while (!step.done);
  attachDataset(step.value);
  return step.value;
}

async function addDatasetAsync(parsed) {
  const ds = await runSliced(prepareDataset(parsed));
  attachDataset(ds);
  return ds;
}

// Put a prepared dataset on the map and in the dataset list.
function attachDataset(ds) {
  if (ds.visible) ds.layer.addTo(STATE.map);
  STATE.datasets.push(ds);
}

/* Build a dataset's layers without touching the map or the dataset list, so
   a cancelled or failed load leaves the workspace as it was. `base` is the
   set of datasets it will join (the open ones, or a profile being staged);
   `parsed.style`, `parsed.visible` and `parsed.slot` restore a saved state. */
function* prepareDataset(parsed, base) {
  base = base || STATE.datasets;
  if (base.length >= MAX_DATASETS) throw new Error("Dataset limit reached (" + MAX_DATASETS + "). Remove one first.");
  const geojson = parsed.geojson.estimatedBytes === undefined ? OmaParse.validateFeatureCollection(parsed.geojson) : parsed.geojson;
  OmaParse.checkWorkspace(base.map(function (ds) { return ds.geojson; }).concat([geojson]));
  const layers = new Array(geojson.features.length), points = [];
  let featureIndex = 0;
  const paths = L.geoJSON(null, {
    renderer: STATE.renderer, interactive: false,
    pointToLayer: function (feature, latlng) { return L.circleMarker(latlng, { renderer: STATE.renderer, interactive: false }); },
    onEachFeature: function (feature, lyr) { lyr._omaIndex = featureIndex; layers[featureIndex] = lyr; }
  });
  for (let i = 0; i < geojson.features.length; i++) {
    const f = geojson.features[i];
    if (f.geometry.type === "Point") points.push({latlng:L.latLng(f.geometry.coordinates[1],f.geometry.coordinates[0]), feature:f, index:i});
    else { featureIndex = i; paths.addData(f); }
    if (i % 512 === 0) yield;
  }
  let layer = paths;
  if (points.length) {
    const fast = new FastPoints(points, {deferred:true});
    for (let i = 0; i < points.length; i += 1024) {
      fast.fillItems(points, i, Math.min(points.length,i+1024)); yield;
    }
    fast.getLayers().forEach(function (p) { layers[p._omaIndex] = p; });
    if (points.length === geojson.features.length) layer = fast;
    else {
      layer = L.featureGroup([paths, fast]);
      layer.dispose = function () { fast.dispose(); STATE.map.removeLayer(layer); };
    }
  }
  const ds = {
    id: "ds-" + (STATE.nextId++),
    name: String(parsed.name || "Untitled").slice(0, 200),
    slot: Number.isInteger(parsed.slot) && parsed.slot >= 0 ? parsed.slot : STATE.nextSlot++,
    layer: layer,
    features: geojson.features,
    geojson: geojson,
    fields: geojson.fields,
    spatial: new SpatialIndex(geojson.features),
    layers: layers,           // per feature, in file order
    featureCount: geojson.features.length,
    geomTypes: geometrySummary(geojson),
    visible: parsed.visible !== false,
    warnings: parsed.warnings || []
  };
  ds.style = defaultStyle(ds);
  if (parsed.style) applySavedStyle(ds, parsed.style);
  const cache = new Map();
  for (let i = 0; i < layers.length; i++) {
    styleFeatureLayer(layers[i], ds, false, cache);
    if (i % 1024 === 0) yield;
  }
  return ds;
}

// A cleaned profile style (see OmaParse.cleanStyle) applied before the first draw.
function applySavedStyle(ds, st) {
  ["colour", "fillOpacity", "weight", "radius", "outline"].forEach(function (k) { if (st[k] !== null && st[k] !== undefined) ds.style[k] = st[k]; });
  if (st.byField && datasetFields(ds).indexOf(st.byField.field) >= 0) {
    const mode = st.byField.mode === "ranges" && fieldIsNumeric(ds, st.byField.field) ? "ranges" : "categories";
    setColourBy(ds, st.byField.field, mode, st.byField.reverse);
  }
}

function restack() {
  // Canvas draw order follows add order; re-raise everything above a re-shown layer.
  STATE.datasets.forEach(function (ds) { if (ds.visible) ds.layer.bringToFront(); });
  highlightSelection();
}

function toggleVisible(id) {
  const ds = findDs(id); if (!ds) return;
  ds.visible = !ds.visible;
  if (ds.visible) { ds.layer.addTo(STATE.map); restack(); }
  else {
    STATE.map.removeLayer(ds.layer);
    if (STATE.hits.some(function (h) { return h.ds === ds; })) clearSelection();
  }
  renderLayerList();
  renderLegend();
  setStatus((ds.visible ? "Showing " : "Hid ") + ds.name + ".");
}

function fitBounds(bounds, maxZoom) {
  if (bounds && bounds.isValid()) STATE.map.fitBounds(bounds, { padding: [40, 40], maxZoom: maxZoom || 16 });
}

function zoomToDataset(id) {
  const ds = findDs(id); if (!ds) return;
  if (!ds.visible) toggleVisible(id);
  fitBounds(ds.layer.getBounds());
}

function fitAll() {
  const visible = STATE.datasets.filter(function (d) { return d.visible; });
  if (!visible.length) return;
  const bounds = L.latLngBounds([]);
  visible.forEach(function (d) { bounds.extend(d.layer.getBounds()); });
  fitBounds(bounds);
}

function removeDataset(id) {
  const index = STATE.datasets.findIndex(function (d) { return d.id === id; });
  if (index < 0) return;
  const ds = STATE.datasets[index];
  if (STATE.hits.some(function (h) { return h.ds === ds; })) clearSelection();
  disposeDataset(ds);
  STATE.datasets.splice(index, 1);
  if (STATE.styleOpenId === ds.id) STATE.styleOpenId = null;
  renderLayerList();
  renderLegend();
  Table.onDatasetsChanged();
  setStatus("Removed " + ds.name + ".");
}

// Remove a dataset's layer from the map and free what it holds (GPU context).
function disposeDataset(ds) {
  Table.forget(ds);
  if (typeof ds.layer.dispose === "function") ds.layer.dispose();
  else STATE.map.removeLayer(ds.layer);
}

function clearAll() {
  clearSelection();
  STATE.datasets.forEach(disposeDataset);
  STATE.datasets = [];
  STATE.nextSlot = 0;
  STATE.styleOpenId = null;
  renderLayerList();
  renderLegend();
  Table.onDatasetsChanged();
  setStatus("Cleared all datasets.");
}

function swatchSvg(ds) {
  const bf = ds.style.byField;
  const colour = bf ? "url(#sw-" + ds.id + ")" : datasetColour(ds);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "14"); svg.setAttribute("height", "14"); svg.setAttribute("viewBox", "0 0 14 14");
  let shape;
  const types = ds.geomTypes.join(" ");
  if (/Polygon/.test(types)) {
    shape = document.createElementNS(ns, "rect");
    shape.setAttribute("x", "1.5"); shape.setAttribute("y", "1.5"); shape.setAttribute("width", "11"); shape.setAttribute("height", "11");
    shape.setAttribute("fill", colour); shape.setAttribute("fill-opacity", "0.35"); shape.setAttribute("stroke", colour); shape.setAttribute("stroke-width", "1.5");
  } else if (/Line/.test(types)) {
    shape = document.createElementNS(ns, "path");
    shape.setAttribute("d", "M1 11 L5 5 L9 9 L13 3"); shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", colour); shape.setAttribute("stroke-width", "2");
  } else {
    shape = document.createElementNS(ns, "circle");
    shape.setAttribute("cx", "7"); shape.setAttribute("cy", "7"); shape.setAttribute("r", "5"); shape.setAttribute("fill", colour);
  }
  if (bf) {
    // Several class colours side by side, so a styled dataset reads as such.
    const defs = document.createElementNS(ns, "defs");
    const grad = document.createElementNS(ns, "linearGradient");
    grad.setAttribute("id", "sw-" + ds.id);
    const n = Math.min(4, bf.classes.length) || 1;
    for (let i = 0; i < n; i++) {
      const c = classColour(bf, Math.round(i * (bf.classes.length - 1) / Math.max(1, n - 1)));
      [i / n, (i + 1) / n].forEach(function (off) {
        const stop = document.createElementNS(ns, "stop");
        stop.setAttribute("offset", String(off)); stop.setAttribute("stop-color", c);
        grad.appendChild(stop);
      });
    }
    defs.appendChild(grad);
    svg.appendChild(defs);
  }
  svg.appendChild(shape);
  return svg;
}

function iconButton(label, text, onClick, extra) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "icon-btn" + (extra ? " " + extra : "");
  b.setAttribute("aria-label", label); b.title = label; b.textContent = text;
  b.addEventListener("click", function (e) { e.stopPropagation(); onClick(); });
  return b;
}

function renderLayerList() {
  const list = el("layer-list");
  list.textContent = "";
  const selectedDs = STATE.hits.length ? STATE.hits[STATE.hitIndex].ds : null;
  // Topmost (last drawn) first.
  STATE.datasets.slice().reverse().forEach(function (ds) {
    const row = document.createElement("div");
    row.className = "layer" + (ds.visible ? "" : " hidden-layer") + (ds === selectedDs ? " has-selection" : "");
    row.dataset.id = ds.id;
    const sw = document.createElement("span"); sw.className = "layer-swatch"; sw.appendChild(swatchSvg(ds));
    const text = document.createElement("div"); text.className = "layer-text"; text.title = "Zoom to " + ds.name;
    const name = document.createElement("div"); name.className = "layer-name"; name.textContent = ds.name;
    const sub = document.createElement("div"); sub.className = "layer-sub";
    sub.textContent = plural(ds.featureCount, "feature") + " · " + ds.geomTypes.join(", ");
    text.appendChild(name); text.appendChild(sub);
    text.addEventListener("click", function () { zoomToDataset(ds.id); });
    const actions = document.createElement("div"); actions.className = "layer-actions";
    const styling = STATE.styleOpenId === ds.id;
    const styleBtn = iconButton((styling ? "Close style for " : "Style ") + ds.name, "◐", function () {
      STATE.styleOpenId = styling ? null : ds.id;
      renderLayerList();
    });
    if (styling) styleBtn.classList.add("on");
    actions.appendChild(styleBtn);
    const tableBtn = iconButton("Attribute table for " + ds.name, "▦", function () {
      if (Table.isOpen() && Table.ds === ds) Table.close(); else Table.open(ds);
    });
    if (Table.isOpen() && Table.ds === ds) tableBtn.classList.add("on");
    actions.appendChild(tableBtn);
    actions.appendChild(iconButton(ds.visible ? "Hide " + ds.name : "Show " + ds.name, ds.visible ? "◉" : "○", function () { toggleVisible(ds.id); }));
    actions.appendChild(iconButton("Remove " + ds.name, "×", function () { removeDataset(ds.id); }, "danger"));
    row.appendChild(sw); row.appendChild(text); row.appendChild(actions);
    ds.warnings.forEach(function (w) {
      const warn = document.createElement("div"); warn.className = "layer-warn"; warn.textContent = "⚠ " + w;
      row.appendChild(warn);
    });
    if (styling) row.appendChild(renderStyleEditor(ds));
    list.appendChild(row);
  });
  const n = STATE.datasets.length;
  el("layer-empty").hidden = n > 0;
  el("btn-clear-all").disabled = !n;
  el("btn-fit-all").disabled = !n;
  el("btn-save").disabled = !n;
  el("meta-layers").textContent = n;
  el("meta-features").textContent = STATE.datasets.reduce(function (a, d) { return a + d.featureCount; }, 0).toLocaleString();
}

/* --------------------------- Hit-testing --------------------------------- */
/* Leaflet's canvas renderer already knows how to test a pixel against a
   rendered path or marker (_containsPoint). We use it directly so a click can
   report every feature under the cursor, not just the topmost. */
function layerContains(layer, point) {
  if (layer.isFastPoint) return layer._containsPoint(point);
  if (layer instanceof L.Path) return typeof layer._containsPoint === "function" && !!layer._containsPoint(point);
  if (typeof layer.getLayers === "function") return layer.getLayers().some(function (child) { return layerContains(child, point); });
  return false;
}

function identify(layerPoint) {
  const hits = [];
  // Include the largest point radius, selection halo and hit tolerance.
  const a = STATE.map.layerPointToLatLng(layerPoint.subtract([26, 26]));
  const b = STATE.map.layerPointToLatLng(layerPoint.add([26, 26]));
  for (let d = STATE.datasets.length - 1; d >= 0; d--) {
    const ds = STATE.datasets[d];
    if (!ds.visible) continue;
    const layers = ds.layers;
    const candidates = ds.spatial.search(a.lng, b.lat, b.lng, a.lat);
    for (const i of candidates) {
      if (layerContains(layers[i], layerPoint)) hits.push({ ds: ds, layer: layers[i] });
    }
  }
  return hits;
}

function onMapClick(e) {
  const hits = identify(e.layerPoint);
  if (!hits.length) { clearSelection(); return; }
  clearHighlight();
  STATE.hits = hits;
  STATE.hitIndex = 0;
  showSelection();
}

/* ------------------------------ Selection -------------------------------- */
function currentHit() { return STATE.hits.length ? STATE.hits[STATE.hitIndex] : null; }

function clearHighlight() {
  const hit = currentHit();
  if (hit) styleFeatureLayer(hit.layer, hit.ds, false);
}

function highlightSelection() {
  const hit = currentHit();
  if (!hit) return;
  styleFeatureLayer(hit.layer, hit.ds, true);
  if (hit.layer.bringToFront) hit.layer.bringToFront();
}

function showSelection() {
  highlightSelection();
  renderInspector();
  renderLayerList();
  Table.onSelection();
  const hit = currentHit();
  setStatus("Selected " + featureLabel(hit.layer.feature, hit.layer._omaIndex) + " in " + hit.ds.name + ".");
}

function stepHit(step) {
  if (STATE.hits.length < 2) return;
  clearHighlight();
  STATE.hitIndex = (STATE.hitIndex + step + STATE.hits.length) % STATE.hits.length;
  showSelection();
}

function clearSelection() {
  if (!STATE.hits.length) return;
  clearHighlight();
  STATE.hits = [];
  STATE.hitIndex = 0;
  el("inspector").hidden = true;
  renderLayerList();
  Table.onSelection();
  setStatus("Selection cleared.");
}

function zoomToSelection() {
  const hit = currentHit();
  if (!hit) return;
  const layer = hit.layer;
  if (layer.getBounds) {
    const b = layer.getBounds();
    if (b.isValid() && !b.getNorthEast().equals(b.getSouthWest())) { fitBounds(b, 18); return; }
    if (b.isValid()) { STATE.map.setView(b.getCenter(), Math.max(16, STATE.map.getZoom())); return; }
  }
  if (layer.getLatLng) STATE.map.setView(layer.getLatLng(), Math.max(16, STATE.map.getZoom()));
}

// Bring the selection into view without zooming out; zoom in to small features.
function panToSelection() {
  const hit = currentHit();
  if (!hit) return;
  const layer = hit.layer;
  const view = STATE.map.getBounds();
  if (layer.getLatLng) {
    const ll = layer.getLatLng();
    if (STATE.map.getZoom() < 13) STATE.map.setView(ll, 15);
    else if (!view.pad(-0.1).contains(ll)) STATE.map.panTo(ll);
    return;
  }
  const b = layer.getBounds();
  if (!b.isValid()) return;
  const viewSize = STATE.map.latLngToLayerPoint(view.getNorthEast()).distanceTo(STATE.map.latLngToLayerPoint(view.getSouthWest()));
  const size = STATE.map.latLngToLayerPoint(b.getNorthEast()).distanceTo(STATE.map.latLngToLayerPoint(b.getSouthWest()));
  if (!view.contains(b) || size < 12 || size > viewSize) fitBounds(b, 17);
}

/* ------------------------------ Measures --------------------------------- */
const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;

function haversine(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversine(coords[i - 1], coords[i]);
  return total;
}

// Spherical ring area (Chamberlain & Duquette), as used by turf.
function ringArea(coords) {
  const n = coords.length;
  if (n <= 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = coords[i], middle = coords[(i + 1) % n], upper = coords[(i + 2) % n];
    total += (upper[0] * RAD - lower[0] * RAD) * Math.sin(middle[1] * RAD);
  }
  return Math.abs(total * 6378137 * 6378137 / 2);
}

function polygonArea(rings) {
  if (!rings.length) return 0;
  return Math.max(0, ringArea(rings[0]) - rings.slice(1).reduce(function (s, r) { return s + ringArea(r); }, 0));
}

function measureGeometry(g) {
  const m = { length: 0, area: 0 };
  (function walk(geom) {
    if (geom.type === "LineString") m.length += lineLength(geom.coordinates);
    else if (geom.type === "MultiLineString") geom.coordinates.forEach(function (c) { m.length += lineLength(c); });
    else if (geom.type === "Polygon") m.area += polygonArea(geom.coordinates);
    else if (geom.type === "MultiPolygon") geom.coordinates.forEach(function (p) { m.area += polygonArea(p); });
    else if (geom.type === "GeometryCollection") geom.geometries.forEach(walk);
  })(g);
  return m;
}

function formatLength(m) { return m >= 1000 ? (m / 1000).toFixed(m >= 100000 ? 0 : 2) + " km" : m.toFixed(1) + " m"; }
function formatArea(a) {
  if (a >= 1e6) return (a / 1e6).toFixed(a >= 1e8 ? 0 : 2) + " km²";
  if (a >= 1e4) return (a / 1e4).toFixed(2) + " ha";
  return a.toFixed(1) + " m²";
}

/* ------------------------------ Inspector -------------------------------- */
const LABEL_KEYS = ["name", "Name", "NAME", "title", "Title", "TITLE", "label", "Label", "id", "ID", "Id"];

function featureLabel(feature, index) {
  const p = (feature && feature.properties) || {};
  for (let i = 0; i < LABEL_KEYS.length; i++) {
    const v = p[LABEL_KEYS[i]];
    const text = v !== null && typeof v === "object" ? JSON.stringify(v) : (v == null ? "" : String(v));
    if (text.trim() !== "") return text.slice(0, 80);
  }
  if (feature && feature.id != null) return String(feature.id);
  return "Feature " + ((index || 0) + 1);
}

function safeExternalUrl(value) {
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.href;
  } catch (e) { return null; }
}

function renderInspector() {
  const hit = currentHit();
  if (!hit) return;
  const feature = hit.layer.feature;
  const g = feature.geometry;
  el("inspector").hidden = false;
  el("insp-swatch").style.background = featureColour(hit.ds, hit.layer._omaIndex);
  el("insp-ds").textContent = featureLabel(feature, hit.layer._omaIndex);
  const bits = [hit.ds.name, g.type, "#" + (hit.layer._omaIndex + 1) + " of " + hit.ds.featureCount.toLocaleString()];
  if (g.type === "Point") bits.push(g.coordinates[1].toFixed(6) + ", " + g.coordinates[0].toFixed(6));
  const m = measureGeometry(g);
  if (m.area) bits.push(formatArea(m.area));
  if (m.length) bits.push(formatLength(m.length));
  el("insp-sub").textContent = bits.join(" · ");

  const hits = el("insp-hits");
  hits.textContent = "";
  hits.hidden = STATE.hits.length < 2;
  if (STATE.hits.length > 1) {
    hits.appendChild(iconButton("Previous feature here ([)", "‹", function () { stepHit(-1); }));
    const label = document.createElement("span"); label.className = "hit-label";
    label.textContent = (STATE.hitIndex + 1) + " of " + STATE.hits.length + " features here";
    hits.appendChild(label);
    hits.appendChild(iconButton("Next feature here (])", "›", function () { stepHit(1); }));
  }
  renderAttributes();
}

function renderAttributes() {
  const hit = currentHit();
  if (!hit) return;
  const props = hit.layer.feature.properties || {};
  const filter = el("attr-filter").value.trim().toLowerCase();
  const tbody = el("insp-attrs");
  tbody.textContent = "";
  const keys = Object.keys(props);
  let shown = 0;
  keys.forEach(function (k) {
    const v = props[k];
    const text = v === null || v === undefined ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
    if (filter && k.toLowerCase().indexOf(filter) < 0 && text.toLowerCase().indexOf(filter) < 0) return;
    shown++;
    const tr = document.createElement("tr");
    const th = document.createElement("th"); th.scope = "row"; th.textContent = k;
    const td = document.createElement("td");
    if (v === null || v === undefined) {
      const s = document.createElement("span"); s.className = "nullish"; s.textContent = "null"; td.appendChild(s);
    } else if (text === "") {
      const s = document.createElement("span"); s.className = "nullish"; s.textContent = "empty"; td.appendChild(s);
    } else if (typeof v === "string" && /^https?:\/\//i.test(v.trim()) && safeExternalUrl(v)) {
      const a = document.createElement("a");
      a.href = safeExternalUrl(v); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = v;
      td.appendChild(a);
    } else {
      td.textContent = text;
    }
    tr.appendChild(th); tr.appendChild(td);
    tbody.appendChild(tr);
  });
  if (!shown) {
    const tr = document.createElement("tr"); tr.className = "none-row";
    const td = document.createElement("td"); td.colSpan = 2;
    td.textContent = keys.length ? "No attributes match the filter." : "This feature has no attributes.";
    tr.appendChild(td); tbody.appendChild(tr);
  }
}

// Spreadsheet-safe: neutralise leading formula characters.
function tabularCell(value) {
  let s = String(value).replace(/[\t\r\n]+/g, " ");
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function copyAttributes() {
  const hit = currentHit();
  if (!hit) return;
  const props = hit.layer.feature.properties || {};
  const text = Object.keys(props).map(function (k) {
    let v = props[k];
    if (v === null || v === undefined) v = "";
    else if (typeof v === "object") v = JSON.stringify(v);
    return tabularCell(k) + "\t" + tabularCell(v);
  }).join("\n");
  const done = function () { toast("Copied", Object.keys(props).length + " attributes copied as tab-separated text.", "ok"); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
  } else fallbackCopy(text, done);
}

function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch (e) { toast("Copy failed", "The clipboard is unavailable.", "err"); }
  ta.remove();
}

/* ------------------------------- Parsing --------------------------------- */
class LoadCancelled extends Error {}

/* Parsing runs in a worker. In-flight files have their bytes transferred to
   it, so if the worker dies (e.g. a file too large for memory) or is
   cancelled, those files fail with a clear error and a fresh worker serves
   the next ones. If workers cannot run at all, parsing falls back to the
   main thread. */
const Parser = {
  worker: null,
  failed: false,
  crashes: 0,
  jobs: new Map(),
  nextJob: 1,
  fallbackReady: null,

  start: function () {
    if (this.failed) return;
    let worker;
    try { worker = new Worker("parse-worker.js"); }
    catch (e) { this.failed = true; return; }
    this.worker = worker;
    worker.onmessage = (e) => {
      const job = this.jobs.get(e.data && e.data.id);
      if (!job) return;
      this.jobs.delete(e.data.id);
      if (e.data.ok) job.resolve(e.data.datasets); else job.reject(new Error(e.data.error));
    };
    worker.onmessageerror = () => this.stop(new Error("The parsed data could not be passed back to the map."));
    worker.onerror = (e) => {
      e.preventDefault();
      // Before any job has run this means workers are unusable here.
      if (!this.jobs.size && !this.everRan) { this.worker = null; this.failed = true; worker.terminate(); return; }
      this.crashes++;
      this.stop(new Error("The file reader stopped unexpectedly. The file may be too large for the available memory."));
    };
  },

  // Fail every in-flight job and start a fresh worker for later ones.
  stop: function (reason) {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    const pending = Array.from(this.jobs.values());
    this.jobs.clear();
    pending.forEach(function (job) { job.reject(reason); });
    if (this.crashes > 3) this.failed = true;   // keep crashing: stop trying workers
    else this.start();
  },

  cancel: function () {
    if (this.jobs.size) this.stop(new LoadCancelled("Loading cancelled."));
  },

  loadFallback: function () {
    if (this.fallbackReady) return this.fallbackReady;
    const scripts = ["vendor/fflate.js", "vendor/shp.js", "vendor/papaparse.min.js"];
    this.fallbackReady = scripts.reduce(function (chain, src) {
      return chain.then(function () {
        return new Promise(function (resolve, reject) {
          const s = document.createElement("script");
          s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error("Could not load " + src)); };
          document.head.appendChild(s);
        });
      });
    }, Promise.resolve());
    return this.fallbackReady;
  },

  runLocal: function (message) {
    return this.loadFallback().then(function () {
      if (message.kind === "shapefile-set") return OmaParse.parseShapefileSet(message.name, message.parts);
      return OmaParse.parseBytes(message.name, message.buffer);
    });
  },

  run: function (message, transfer) {
    if (!this.worker || this.failed) return this.runLocal(message);
    return new Promise((resolve, reject) => {
      const id = this.nextJob++;
      message.id = id;
      this.everRan = true;
      this.jobs.set(id, { resolve: resolve, reject: reject });
      this.worker.postMessage(message, transfer || []);
    });
  }
};

function readBuffer(file) {
  if (typeof file.arrayBuffer === "function") return Promise.resolve(file.arrayBuffer());
  return Promise.reject(new Error("Cannot read this file."));
}

async function parseOne(file) {
  const ext = OmaParse.extOf(file.name);
  const limit = ext === "zip" || ext === "kmz" ? OmaParse.LIMITS.zipBytes : OmaParse.LIMITS.fileBytes;
  if (typeof file.size === "number" && file.size > limit) throw new Error("File is too large (limit " + Math.round(limit / 1048576) + " MiB).");
  const buffer = await readBuffer(file);
  if (ext === "kml" || ext === "gpx") {
    // XML formats need DOMParser, which workers lack: convert on the page,
    // in slices so the window stays responsive and Cancel works.
    if (buffer.byteLength > OmaParse.LIMITS.fileBytes) throw new Error("File is too large.");
    const text = new TextDecoder("utf-8").decode(buffer);
    return [{ name: OmaParse.baseName(file.name), geojson: await runSliced(OmaParse.xmlToGeoJSONSteps(text, ext)) }];
  }
  // KML / GPX inside a ZIP or KMZ come back as text for the page to convert.
  return OmaParse.resolveXmlLayers(await Parser.run({ kind: "file", name: file.name, buffer: buffer }, [buffer]), runSliced);
}

async function parseShapefileSet(stem, group) {
  const parts = {};
  // Check sizes before reading anything into memory, as parseOne does.
  for (const ext of Object.keys(group)) {
    if (typeof group[ext].size === "number" && group[ext].size > OmaParse.LIMITS.fileBytes) throw new Error("Shapefile part ." + ext + " is too large (limit " + Math.round(OmaParse.LIMITS.fileBytes / 1048576) + " MiB).");
  }
  for (const ext of Object.keys(group)) parts[ext] = await readBuffer(group[ext]);
  return Parser.run({ kind: "shapefile-set", name: stem, parts: parts }, Object.values(parts));
}

/* Accepts File objects (drop / picker) or host-supplied { name, size, arrayBuffer }.
   Batches load one after another, so a second drop waits for the first. */
let loadQueue = Promise.resolve();
let cancelledLoad = false;
function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  const run = loadQueue.then(function () { return loadFiles(files); });
  loadQueue = run.catch(function () {});
  return run;
}

async function loadFiles(files) {
  cancelledLoad = false;
  if (!files.length) return;
  if (files.length > MAX_FILES_PER_DROP) { toast("Too many files", "Add at most " + MAX_FILES_PER_DROP + " files at once.", "err"); return; }

  // Loose shapefile parts (.shp + .dbf + .prj + .cpg) are grouped by name.
  const shapeSets = new Map();
  const singles = [];
  files.forEach(function (f) {
    const ext = OmaParse.extOf(f.name);
    if (OmaParse.SHAPE_PARTS.indexOf(ext) >= 0) {
      const stem = OmaParse.baseName(f.name);
      const key = stem.toLowerCase();
      if (!shapeSets.has(key)) shapeSets.set(key, { stem: stem, parts: {} });
      shapeSets.get(key).parts[ext] = f;
    } else singles.push(f);
  });
  const jobs = singles.map(function (f) { return { label: f.name, run: function () { return parseOne(f); } }; });
  shapeSets.forEach(function (set) {
    if (!set.parts.shp) {
      toast("Skipped " + Object.keys(set.parts).map(function (e) { return set.stem + "." + e; }).join(", "), "No matching .shp file was included.", "warn");
      return;
    }
    jobs.push({ label: set.stem + ".shp", run: function () { return parseShapefileSet(set.stem, set.parts); } });
  });

  const added = [];
  let profileOpened = null;
  try {
  for (let i = 0; i < jobs.length; i++) {
    setLoading(true, "Reading " + jobs[i].label + (jobs.length > 1 ? " (" + (i + 1) + "/" + jobs.length + ")" : "") + "…");
    try {
      const result = await jobs[i].run();
      if (result && result.kind === "profile") {
        setLoading(false);
        if (STATE.datasets.length && !window.confirm("Open profile “" + jobs[i].label + "”?\n\nIt replaces the " + plural(STATE.datasets.length, "dataset") + " currently open.")) continue;
        setLoading(true, "Opening profile…");
        await restoreProfile(result);
        profileOpened = jobs[i].label;
        added.length = 0;
        continue;
      }
      for (const parsed of result) added.push(await addDatasetAsync(parsed));
    } catch (error) {
      if (error instanceof LoadCancelled) {
        toast("Loading cancelled", jobs.length - i > 1 ? "Skipped " + plural(jobs.length - i, "file") + "." : jobs[i].label, "warn");
        break;
      }
      toast("Could not load " + jobs[i].label, OmaParse.safeMessage(error, "The file was rejected."), "err");
    }
  }
  } finally {
    setLoading(false);
  }
  renderLayerList();
  Table.onDatasetsChanged();
  if (profileOpened) {
    setStatus("Opened profile " + profileOpened + " (" + plural(STATE.datasets.length, "dataset") + ").");
    toast("Profile opened", profileOpened + " · " + plural(STATE.datasets.length, "dataset"), "ok");
  }
  if (added.length) {
    const bounds = L.latLngBounds([]);
    added.forEach(function (ds) { bounds.extend(ds.layer.getBounds()); });
    fitBounds(bounds);
    const features = added.reduce(function (a, d) { return a + d.featureCount; }, 0);
    setStatus("Added " + plural(added.length, "dataset") + " (" + plural(features, "feature") + ").");
  }
}

/* ------------------------------- Profiles -------------------------------- */
/* A profile saves the workspace: every dataset with its data, style,
   visibility and stacking order, plus the map view and basemap. */

function buildProfile() {
  const c = STATE.map.getCenter();
  return {
    omamap: "profile",
    version: OmaParse.PROFILE_VERSION,
    app: window.OmaMap.version,
    savedAt: new Date().toISOString(),
    view: { lat: c.lat, lng: c.lng, zoom: STATE.map.getZoom() },
    basemap: STATE.basemapPref,
    datasets: STATE.datasets.map(function (ds) {
      const st = ds.style, bf = st.byField;
      return {
        name: ds.name,
        visible: ds.visible,
        slot: ds.slot,
        warnings: ds.warnings.slice(0, 20),
        style: {
          colour: st.colour, fillOpacity: st.fillOpacity, weight: st.weight, radius: st.radius, outline: st.outline,
          byField: bf ? { field: bf.field, mode: bf.mode, reverse: bf.reverse } : null
        },
        geojson: { type: "FeatureCollection", features: ds.features }
      };
    })
  };
}

function profileFileName() {
  const d = new Date();
  const pad = function (n) { return String(n).padStart(2, "0"); };
  return "OmaMap " + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + pad(d.getMinutes()) + ".omamap";
}

let savingProfile = false;
async function saveProfile() {
  if (savingProfile) return;
  if (!STATE.datasets.length) { toast("Nothing to save", "Open some datasets first.", "warn"); return; }
  let blob;
  savingProfile = true;
  try { blob = await OmaParse.profileBlob(buildProfile()); }
  catch (e) { toast("Could not save", OmaParse.safeMessage(e), "err"); return; }
  finally { savingProfile = false; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = profileFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  // The desktop app asks where to save and reports back via profileSaved().
  if (!STATE.host) toast("Profile saved", a.download + " (" + plural(STATE.datasets.length, "dataset") + ")", "ok");
}

/* Every saved dataset is built off-map first; the open workspace is only
   replaced once all of them are ready, so Cancel or an error part-way
   through leaves it exactly as it was. */
async function restoreProfile(profile) {
  const staged = [], nextSlot = STATE.nextSlot;
  try {
    for (let i = 0; i < profile.datasets.length; i++) {
      const saved = profile.datasets[i];
      const ds = await runSliced(prepareDataset({ name: saved.name, geojson: saved.geojson, warnings: saved.warnings,
        style: saved.style, visible: saved.visible, slot: Number.isInteger(saved.slot) && saved.slot >= 0 ? saved.slot : i }, staged));
      staged.push(ds);
    }
  } catch (error) {
    staged.forEach(disposeDataset);
    STATE.nextSlot = nextSlot;
    throw error;
  }
  clearSelection();
  STATE.datasets.slice().forEach(disposeDataset);
  STATE.datasets = [];
  STATE.styleOpenId = null;
  staged.forEach(attachDataset);
  const added = staged;
  STATE.nextSlot = STATE.datasets.reduce(function (m, d) { return Math.max(m, d.slot + 1); }, 0);
  if (profile.basemap && (profile.basemap === "auto" || OMAMAP_BASEMAPS.some(function (b) { return b.id === profile.basemap; }))) setBasemap(profile.basemap, true);
  if (profile.view) STATE.map.setView([profile.view.lat, profile.view.lng], profile.view.zoom);
  else fitAll();
  renderLayerList();
  renderLegend();
  Table.onDatasetsChanged();
  (profile.notes || []).forEach(function (n) { toast("Profile note", n, "warn"); });
  return added;
}

/* ------------------------------ Host bridge ------------------------------ */
/* The native host serves files the user opened (CLI, file manager) at
   same-origin URLs and calls openUrls() with them. */
function openUrls(list) {
  const files = (Array.isArray(list) ? list : []).filter(function (item) {
    return item && typeof item.url === "string" && typeof item.name === "string";
  }).map(function (item) {
    return {
      name: item.name,
      size: typeof item.size === "number" ? item.size : undefined,
      arrayBuffer: function () {
        return fetch(item.url).then(function (r) {
          if (!r.ok) throw new Error("Could not read " + item.name + ".");
          return r.arrayBuffer();
        });
      }
    };
  });
  return handleFiles(files);
}

// Called by the desktop app when it starts and after it saves a profile.
function setHost(info) { STATE.host = info && typeof info === "object" ? info : { present: true }; }
function profileSaved(path) {
  const name = String(path || "").split("/").pop();
  toast("Profile saved", name, "ok");
  setStatus("Saved profile to " + String(path || "").slice(0, 300) + ".");
}

window.OmaMap = { applyTheme: applyTheme, openUrls: openUrls, setHost: setHost, profileSaved: profileSaved, version: "0.3.2" };

/* -------------------------------- Wiring --------------------------------- */
function wireDragDrop() {
  let depth = 0;
  const hasFiles = function (e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") >= 0; };
  window.addEventListener("dragenter", function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragover", function (e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove("dragging"); });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; document.body.classList.remove("dragging");
    handleFiles(e.dataTransfer.files);
  });
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

function wireKeys() {
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (isTyping(e)) { e.target.value = ""; e.target.blur(); renderAttributes(); return; }
      clearSelection(); return;
    }
    if (isTyping(e) || e.ctrlKey || e.altKey || e.metaKey) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); el("file-input").click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveProfile(); }
      return;
    }
    const k = e.key;
    if (k === "o" || k === "O") { e.preventDefault(); el("file-input").click(); }
    else if (k === "b") cycleBasemap(1);
    else if (k === "B") cycleBasemap(-1);
    else if (k === "f" || k === "F") fitAll();
    else if (k === "z" || k === "Z") zoomToSelection();
    else if (k === "t" || k === "T") Table.toggle();
    else if (k === "l" || k === "L") toggleLegend();
    else if (k === "]") stepHit(1);
    else if (k === "[") stepHit(-1);
    else if (k === "/" && !el("inspector").hidden) { e.preventDefault(); el("attr-filter").focus(); }
    else if (/^[1-9]$/.test(k) && Number(k) <= OMAMAP_BASEMAPS.length) setBasemap(OMAMAP_BASEMAPS[Number(k) - 1].id, true);
  });
}

function initMap() {
  STATE.renderer = L.canvas({ padding: 0.5, tolerance: 4 });
  STATE.map = L.map("map", {
    preferCanvas: true, renderer: STATE.renderer, zoomControl: true, attributionControl: true,
    worldCopyJump: true, minZoom: 2, maxZoom: 22, zoomSnap: 0.5, boxZoom: true
  });
  STATE.map.attributionControl.setPrefix(false);
  STATE.map.createPane("labels");
  STATE.map.getPane("labels").style.zIndex = 450;          // above overlays (400), below markers' tooltips
  STATE.map.getPane("labels").style.pointerEvents = "none";
  L.control.scale({ position: "bottomleft", maxWidth: 140 }).addTo(STATE.map);
  let view = null;
  try { view = JSON.parse(storageGet(STORAGE_KEYS.view) || "null"); } catch (e) { view = null; }
  if (view && Number.isFinite(view.lat) && Number.isFinite(view.lng) && Number.isFinite(view.zoom)) STATE.map.setView([view.lat, view.lng], view.zoom);
  else STATE.map.setView([30, 0], 3);
  let saveTimer = null;
  STATE.map.on("moveend", function () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      const c = STATE.map.getCenter();
      storageSet(STORAGE_KEYS.view, JSON.stringify({ lat: c.lat, lng: c.lng, zoom: STATE.map.getZoom() }));
    }, 400);
  });
  STATE.map.on("click", onMapClick);
  STATE.map.on("mousemove", function (e) {
    el("coords").textContent = e.latlng.lat.toFixed(5) + ", " + L.Util.wrapNum(e.latlng.lng, [-180, 180], true).toFixed(5);
  });
  STATE.map.on("mouseout", function () { el("coords").textContent = ""; });
  new ResizeObserver(function () { STATE.map.invalidateSize({ pan: false }); }).observe(el("map"));
}

function boot() {
  const pref = storageGet(STORAGE_KEYS.basemap);
  STATE.basemapPref = pref && (pref === "auto" || OMAMAP_BASEMAPS.some(function (b) { return b.id === pref; })) ? pref : "auto";
  renderBasemapButtons();
  initMap();
  applyTheme({});   // fallback colours until the host sends the Omarchy theme
  setBasemap(STATE.basemapPref, false);
  Parser.start();
  wireDragDrop();
  wireKeys();
  Table.wire();
  el("btn-open").addEventListener("click", function () { el("file-input").click(); });
  el("btn-save").addEventListener("click", saveProfile);
  el("loading-cancel").addEventListener("click", function () { cancelledLoad = true; Parser.cancel(); });
  el("layer-empty").addEventListener("click", function () { el("file-input").click(); });
  el("file-input").addEventListener("change", function () { const files = Array.from(this.files || []); this.value = ""; handleFiles(files); });
  el("btn-fit-all").addEventListener("click", fitAll);
  el("btn-clear-all").addEventListener("click", clearAll);
  el("insp-close").addEventListener("click", clearSelection);
  el("insp-zoom").addEventListener("click", zoomToSelection);
  el("insp-copy").addEventListener("click", copyAttributes);
  el("insp-table").addEventListener("click", function () { const hit = currentHit(); if (hit) { Table.open(hit.ds); Table.reveal(hit.layer._omaIndex); } });
  el("attr-filter").addEventListener("input", renderAttributes);
  renderLayerList();
  setStatus("Ready. Drop files anywhere or press O to open.");
}

document.addEventListener("DOMContentLoaded", boot);
