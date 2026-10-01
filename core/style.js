"use strict";
/* ---------------------------------------------------------------------------
   Dataset styling: per-dataset symbology, colour-by-field classification
   (categories or numeric ranges) and the map legend.

   Colours are never stored as fixed values for classes: each class records
   what it means (palette slot, semantic yes/no/pending, ramp position) and is
   resolved against the current Omarchy theme, so switching theme recolours
   classified data too.
--------------------------------------------------------------------------- */

const MAX_CATEGORIES = 24;
const CLASS_OTHER = 32766;
const CLASS_MISSING = 32767;
const FIELD_SAMPLE = 5000;

// Values with an obvious meaning get the theme's green / yellow / red. Applied
// only when every category in a field is recognised, so a field never ends up
// half semantic and half arbitrary.
const SEMANTIC = {
  good: ["yes", "y", "true", "pass", "passed", "compliant", "completed", "complete", "done", "ok",
    "in service", "active", "operational", "resolved", "metered", "operable", "approved", "open for use"],
  warn: ["pending", "in progress", "planned", "standby", "scheduled", "partially metered", "partial",
    "crew assigned", "due", "due soon", "review", "under review", "maintenance"],
  bad: ["no", "n", "false", "fail", "failed", "failure", "non compliant", "not compliant", "overdue",
    "out of service", "abandoned", "decommissioned", "inactive", "unmetered", "rejected", "closed for use"]
};
const SEMANTIC_ORDER = { good: 0, warn: 1, bad: 2 };

function defaultStyle(ds) {
  const polygons = ds.geomTypes.some(function (t) { return /Polygon/.test(t); });
  return {
    colour: null,               // null: the dataset's theme palette colour
    fillOpacity: polygons ? 0.35 : 0.9,
    weight: polygons ? 2 : 2.5,
    radius: 5.5,
    outline: "auto",            // auto | fg | bg | none
    byField: null               // { field, mode: "categories" | "ranges", reverse, classes, counts }
  };
}

function normalizeValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).trim().toLowerCase().replace(/[_\-\s]+/g, " ");
}

function numericValue(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function isMissing(v) { return v === null || v === undefined || (typeof v === "string" && v.trim() === ""); }

/* Property names, in first-seen order, from a sample of features. */
function datasetFields(ds) {
  if (ds.fields) return ds.fields;
  const seen = new Set();
  const n = Math.min(ds.features.length, FIELD_SAMPLE);
  for (let i = 0; i < n; i++) {
    const p = ds.features[i].properties;
    for (const k in p) if (Object.prototype.hasOwnProperty.call(p, k)) seen.add(k);
  }
  ds.fields = Array.from(seen);
  return ds.fields;
}

function fieldIsNumeric(ds, field) {
  let numbers = 0, present = 0;
  const distinct = new Set();
  const n = Math.min(ds.features.length, FIELD_SAMPLE);
  for (let i = 0; i < n; i++) {
    const v = ds.features[i].properties[field];
    if (isMissing(v)) continue;
    present++;
    const x = numericValue(v);
    if (x !== null) { numbers++; if (distinct.size < 50) distinct.add(x); }
  }
  return present > 0 && numbers / present >= 0.95 && distinct.size >= 2;
}

/* --------------------------- Classification ------------------------------ */

function buildCategories(ds, field) {
  const byKey = new Map();
  ds.features.forEach(function (f) {
    const v = f.properties[field];
    if (isMissing(v)) return;
    const key = normalizeValue(v);
    const entry = byKey.get(key);
    if (entry) entry.count++;
    else byKey.set(key, { key: key, label: typeof v === "object" ? JSON.stringify(v) : String(v).trim(), count: 1 });
  });
  let entries = Array.from(byKey.values());
  const allNumeric = entries.length > 0 && entries.every(function (e) { return numericValue(e.key) !== null; });

  // Semantic meaning applies only when every value is recognised. 1/0 count as
  // yes/no only for a pure 1/0 field.
  const binary = entries.length <= 2 && entries.every(function (e) { return e.key === "1" || e.key === "0"; });
  const meaningOf = function (key) {
    if (binary) return key === "1" ? "good" : "bad";
    for (const m in SEMANTIC) if (SEMANTIC[m].indexOf(key) >= 0) return m;
    return null;
  };
  const semantic = entries.length > 0 && entries.every(function (e) { return meaningOf(e.key) !== null; });

  if (semantic) {
    entries.forEach(function (e) { e.meaning = meaningOf(e.key); });
    entries.sort(function (a, b) { return SEMANTIC_ORDER[a.meaning] - SEMANTIC_ORDER[b.meaning] || b.count - a.count; });
  } else if (allNumeric) {
    entries.sort(function (a, b) { return numericValue(a.key) - numericValue(b.key); });
  } else {
    entries.sort(function (a, b) { return b.count - a.count || a.label.localeCompare(b.label); });
  }

  const kept = entries.slice(0, MAX_CATEGORIES);
  const otherCount = entries.slice(MAX_CATEGORIES).reduce(function (s, e) { return s + e.count; }, 0);
  // Ordered numbers (e.g. condition grades 1–5) read best as a colour ramp.
  const colouring = semantic ? "semantic" : (allNumeric && kept.length > 2 ? "ramp" : "palette");
  return { classes: kept, otherCount: otherCount, colouring: colouring };
}

function niceNumber(x) {
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x).toLocaleString();
  if (a >= 100) return String(Math.round(x));
  if (a >= 1) return String(Math.round(x * 10) / 10);
  return String(Math.round(x * 1000) / 1000);
}

/* Quantile ranges (up to 5 classes) for numeric fields. */
function buildRanges(ds, field) {
  const values = [];
  ds.features.forEach(function (f) { const x = numericValue(f.properties[field]); if (x !== null) values.push(x); });
  values.sort(function (a, b) { return a - b; });
  const breaks = [];
  const k = Math.min(5, new Set(values).size);
  for (let i = 1; i < k; i++) {
    const b = values[Math.floor(values.length * i / k)];
    if (breaks.indexOf(b) < 0 && b > values[0]) breaks.push(b);
  }
  const edges = [values[0]].concat(breaks).concat([values[values.length - 1]]);
  const classes = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const last = i === edges.length - 2;
    classes.push({ min: lo, max: hi, inclusiveMax: last, label: niceNumber(lo) + " – " + niceNumber(hi), count: 0 });
  }
  return { classes: classes, otherCount: 0, colouring: "ramp" };
}

function classifyValue(byField, v) {
  if (isMissing(v)) return CLASS_MISSING;
  if (byField.mode === "ranges") {
    const x = numericValue(v);
    if (x === null) return CLASS_OTHER;
    const cs = byField.classes;
    for (let i = 0; i < cs.length; i++) {
      if (x >= cs[i].min && (x < cs[i].max || (cs[i].inclusiveMax && x <= cs[i].max))) return i;
    }
    return CLASS_OTHER;
  }
  const idx = byField.index.get(normalizeValue(v));
  return idx === undefined ? CLASS_OTHER : idx;
}

/* Set or clear colour-by-field on a dataset. */
function setColourBy(ds, field, mode, reverse) {
  if (!field) { ds.style.byField = null; ds.classOf = null; return; }
  const built = mode === "ranges" ? buildRanges(ds, field) : buildCategories(ds, field);
  const byField = { field: field, mode: mode, reverse: !!reverse, classes: built.classes, colouring: built.colouring, index: new Map() };
  if (mode !== "ranges") built.classes.forEach(function (c, i) { byField.index.set(c.key, i); });
  const classOf = new Uint16Array(ds.features.length);
  let missing = 0, other = 0;
  if (mode === "ranges") byField.classes.forEach(function (c) { c.count = 0; });
  ds.features.forEach(function (f, i) {
    const c = classifyValue(byField, f.properties[field]);
    classOf[i] = c;
    if (c === CLASS_MISSING) missing++;
    else if (c === CLASS_OTHER) other++;
    else if (mode === "ranges") byField.classes[c].count++;
  });
  byField.missingCount = missing;
  byField.otherCount = other;
  ds.style.byField = byField;
  ds.classOf = classOf;
}

/* ------------------------------ Colours ---------------------------------- */

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex(r) { return "#" + r.map(function (x) { return Math.round(x).toString(16).padStart(2, "0"); }).join(""); }
function mix(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map(function (v, i) { return v + (y[i] - v) * t; })); }

function themeColour(key, fallback) {
  const c = STATE.themeColors && STATE.themeColors[key];
  return isHex(c) ? c : fallback;
}

function rampColours() {
  return ["blue", "cyan", "green", "yellow", "orange", "red"].map(function (k, i) {
    return themeColour(k, ["#7aa2f7", "#7dcfff", "#9ece6a", "#e0af68", "#ff9e64", "#f7768e"][i]);
  });
}

function rampAt(t) {
  const stops = rampColours();
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}

function classColour(byField, c) {
  if (c === CLASS_MISSING) return cssVar("--muted");
  if (c === CLASS_OTHER) return cssVar("--fg-dim");
  const cls = byField.classes[c];
  if (byField.colouring === "semantic") {
    return cls.meaning === "good" ? themeColour("green", "#9ece6a") : cls.meaning === "warn" ? themeColour("yellow", "#e0af68") : themeColour("red", "#f7768e");
  }
  if (byField.colouring === "ramp") {
    const n = byField.classes.length;
    const t = n === 1 ? 0.5 : c / (n - 1);
    return rampAt(byField.reverse ? 1 - t : t);
  }
  const palette = categoryPalette();
  return palette[c % palette.length];
}

// The theme palette, extended with blends when a field has many categories.
function categoryPalette() {
  const base = STATE.palette;
  if (base.length >= MAX_CATEGORIES) return base;
  const out = base.slice();
  for (let i = 0; out.length < MAX_CATEGORIES; i++) out.push(mix(base[i % base.length], base[(i + 3) % base.length], 0.5));
  return out;
}

/* Colour of one feature (by index) under its dataset's current style.
   Class colours are resolved once per theme / ramp direction and cached on
   the classification, because this runs for every feature on every restyle. */
function featureColour(ds, index) {
  const bf = ds.style.byField;
  if (!bf || !ds.classOf) return datasetColour(ds);
  const c = ds.classOf[index];
  const cache = classColourCache(bf);
  return c === CLASS_MISSING ? cache.missing : c === CLASS_OTHER ? cache.other : cache.colours[c];
}

function classColourCache(bf) {
  const cache = bf.colourCache;
  if (cache && cache.theme === STATE.themeVersion && cache.reverse === bf.reverse) return cache;
  const colours = bf.classes.map(function (_, i) { return classColour(bf, i); });
  bf.colourCache = { theme: STATE.themeVersion, reverse: bf.reverse, colours: colours,
    missing: classColour(bf, CLASS_MISSING), other: classColour(bf, CLASS_OTHER) };
  return bf.colourCache;
}

/* ---------------------------- Style editor ------------------------------- */

function control(labelText, input, extra) {
  const row = document.createElement("label");
  row.className = "st-row";
  const l = document.createElement("span"); l.className = "st-label"; l.textContent = labelText;
  row.appendChild(l);
  row.appendChild(input);
  if (extra) row.appendChild(extra);
  return row;
}

function slider(min, max, step, value, format, onInput) {
  const wrap = document.createElement("span"); wrap.className = "st-slider";
  const input = document.createElement("input");
  input.type = "range"; input.min = min; input.max = max; input.step = step; input.value = value;
  const out = document.createElement("span"); out.className = "st-value"; out.textContent = format(value);
  input.addEventListener("input", function () { out.textContent = format(Number(input.value)); onInput(Number(input.value)); });
  wrap.appendChild(input); wrap.appendChild(out);
  return wrap;
}

function selectBox(options, value, onChange) {
  const s = document.createElement("select");
  options.forEach(function (o) {
    const opt = document.createElement("option");
    opt.value = o.value; opt.textContent = o.label; opt.disabled = !!o.disabled;
    if (o.value === value) opt.selected = true;
    s.appendChild(opt);
  });
  s.addEventListener("change", function () { onChange(s.value); });
  return s;
}

let restyleFrame = 0;
function scheduleRestyle(ds) {
  cancelAnimationFrame(restyleFrame);
  restyleFrame = requestAnimationFrame(function () { applyDatasetStyle(ds); highlightSelection(); renderLegend(); refreshSwatches(); });
}

function renderStyleEditor(ds) {
  const box = document.createElement("div");
  box.className = "style-editor";
  const st = ds.style;
  const hasPoints = ds.geomTypes.some(function (t) { return /Point/.test(t); });
  const hasPolygons = ds.geomTypes.some(function (t) { return /Polygon/.test(t); });
  const hasLines = ds.geomTypes.some(function (t) { return /Line/.test(t); });
  const byField = !!st.byField;

  // Single colour: theme palette swatches plus a custom picker.
  const swatches = document.createElement("span"); swatches.className = "st-swatches";
  const current = datasetColour(ds).toLowerCase();
  STATE.palette.slice(0, 10).forEach(function (c) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "st-swatch" + (c.toLowerCase() === current ? " on" : "");
    b.style.background = c; b.title = c; b.setAttribute("aria-label", "Colour " + c);
    b.addEventListener("click", function (e) { e.preventDefault(); st.colour = c; scheduleRestyle(ds); renderLayerList(); });
    swatches.appendChild(b);
  });
  const custom = document.createElement("input");
  custom.type = "color"; custom.value = current; custom.title = "Custom colour"; custom.className = "st-custom";
  custom.addEventListener("input", function () { st.colour = custom.value; scheduleRestyle(ds); });
  custom.addEventListener("change", function () { renderLayerList(); });
  swatches.appendChild(custom);
  const colourRow = control("Colour", swatches);
  if (byField) colourRow.classList.add("st-disabled");
  box.appendChild(colourRow);

  if (hasPolygons || hasPoints) {
    box.appendChild(control("Opacity", slider(0, 1, 0.05, st.fillOpacity, function (v) { return Math.round(v * 100) + "%"; },
      function (v) { st.fillOpacity = v; scheduleRestyle(ds); })));
  }
  if (hasPolygons || hasLines) {
    box.appendChild(control(hasLines && !hasPolygons ? "Width" : "Outline width", slider(0.5, 8, 0.5, st.weight, function (v) { return v + " px"; },
      function (v) { st.weight = v; scheduleRestyle(ds); })));
  }
  if (hasPoints) {
    box.appendChild(control("Point size", slider(2, 16, 0.5, st.radius, function (v) { return v + " px"; },
      function (v) { st.radius = v; scheduleRestyle(ds); })));
  }
  if (hasPolygons || hasPoints) {
    box.appendChild(control("Outline", selectBox([
      { value: "auto", label: hasPolygons ? "Same as fill" : "Halo" },
      { value: "fg", label: "Light / text colour" },
      { value: "bg", label: "Dark / background" },
      { value: "none", label: "None" }
    ], st.outline, function (v) { st.outline = v; scheduleRestyle(ds); })));
  }

  // Colour by field.
  const fields = datasetFields(ds);
  const fieldSelect = selectBox([{ value: "", label: "— one colour —" }].concat(fields.map(function (f) { return { value: f, label: f }; })),
    byField ? st.byField.field : "",
    function (field) {
      const mode = field && fieldIsNumeric(ds, field) && !smallCategoryCount(ds, field) ? "ranges" : "categories";
      setColourBy(ds, field, mode, false);
      scheduleRestyle(ds);
      renderLayerList();
    });
  box.appendChild(control("Colour by", fieldSelect));

  if (byField) {
    const bf = st.byField;
    const numeric = fieldIsNumeric(ds, bf.field);
    box.appendChild(control("Method", selectBox([
      { value: "categories", label: "Each value" },
      { value: "ranges", label: "Number ranges", disabled: !numeric }
    ], bf.mode, function (mode) { setColourBy(ds, bf.field, mode, bf.reverse); scheduleRestyle(ds); renderLayerList(); })));
    if (bf.colouring === "ramp") {
      const rev = document.createElement("input"); rev.type = "checkbox"; rev.checked = bf.reverse;
      rev.addEventListener("change", function () { bf.reverse = rev.checked; scheduleRestyle(ds); });
      box.appendChild(control("Reverse ramp", rev));
    }
    const note = document.createElement("p"); note.className = "st-note";
    const parts = [plural(bf.classes.length, bf.mode === "ranges" ? "range" : "value")];
    if (bf.otherCount) parts.push(bf.otherCount.toLocaleString() + " in “other”");
    if (bf.missingCount) parts.push(bf.missingCount.toLocaleString() + " missing");
    if (bf.colouring === "semantic") parts.push("coloured by meaning");
    note.textContent = parts.join(" · ") + ". See the legend.";
    box.appendChild(note);
  }

  const reset = document.createElement("button");
  reset.type = "button"; reset.className = "btn subtle"; reset.textContent = "Reset style";
  reset.addEventListener("click", function () { ds.style = defaultStyle(ds); ds.classOf = null; scheduleRestyle(ds); renderLayerList(); });
  const foot = document.createElement("div"); foot.className = "st-foot"; foot.appendChild(reset);
  box.appendChild(foot);
  return box;
}

// Fields with a handful of numeric codes (grades 1–5) read better as values.
function smallCategoryCount(ds, field) {
  const distinct = new Set();
  for (let i = 0; i < ds.features.length && distinct.size <= 12; i++) {
    const v = ds.features[i].properties[field];
    if (!isMissing(v)) distinct.add(normalizeValue(v));
  }
  return distinct.size <= 12;
}

function refreshSwatches() {
  document.querySelectorAll(".layer[data-id]").forEach(function (row) {
    const ds = findDs(row.dataset.id);
    const holder = row.querySelector(".layer-swatch");
    if (ds && holder) { holder.textContent = ""; holder.appendChild(swatchSvg(ds)); }
  });
}

/* ------------------------------- Legend ---------------------------------- */

let legendCollapsed = false;

function renderLegend() {
  const box = el("legend");
  const styled = STATE.datasets.filter(function (ds) { return ds.visible && ds.style.byField; }).reverse();
  box.hidden = !styled.length;
  if (!styled.length) return;
  box.textContent = "";
  const head = document.createElement("div"); head.className = "lg-head";
  const title = document.createElement("span"); title.textContent = "Legend";
  head.appendChild(title);
  head.appendChild(iconButton(legendCollapsed ? "Expand legend (L)" : "Collapse legend (L)", legendCollapsed ? "+" : "−", toggleLegend));
  box.appendChild(head);
  if (legendCollapsed) return;
  styled.forEach(function (ds) {
    const bf = ds.style.byField;
    const section = document.createElement("div"); section.className = "lg-section";
    const t = document.createElement("div"); t.className = "lg-title";
    t.textContent = ds.name + " · " + bf.field;
    section.appendChild(t);
    const rows = bf.classes.map(function (c, i) { return { colour: classColour(bf, i), label: c.label, count: c.count }; });
    if (bf.otherCount) rows.push({ colour: classColour(bf, CLASS_OTHER), label: "Other", count: bf.otherCount });
    if (bf.missingCount) rows.push({ colour: classColour(bf, CLASS_MISSING), label: "Missing", count: bf.missingCount, muted: true });
    rows.forEach(function (r) {
      const row = document.createElement("div"); row.className = "lg-row" + (r.muted ? " muted" : "");
      const sw = document.createElement("span"); sw.className = "lg-sw"; sw.style.background = r.colour;
      const label = document.createElement("span"); label.className = "lg-label"; label.textContent = r.label;
      const count = document.createElement("span"); count.className = "lg-count"; count.textContent = r.count.toLocaleString();
      row.appendChild(sw); row.appendChild(label); row.appendChild(count);
      section.appendChild(row);
    });
    box.appendChild(section);
  });
}

function toggleLegend() { legendCollapsed = !legendCollapsed; renderLegend(); }
