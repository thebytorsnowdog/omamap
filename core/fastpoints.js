"use strict";
/* ---------------------------------------------------------------------------
   Fast point rendering for point-only datasets.

   Leaflet draws one canvas path per CircleMarker, which becomes slow with tens
   of thousands of points. FastPoints keeps one lightweight object per feature
   (same surface the app uses: options, setStyle, getLatLng, bringToFront,
   _containsPoint) and draws them on its own canvas: with WebGL when available
   (one draw call for every point, circles shaded on the GPU), otherwise with
   a 2D canvas that stamps one pre-drawn sprite per style.

   Positioning and zoom animation follow Leaflet's own L.Renderer.
--------------------------------------------------------------------------- */

function FastPoint(group, slot, latlng, feature, index) {
  this._group = group;
  this._slot = slot;          // position within the group
  this._latlng = latlng;
  this.feature = feature;
  this._omaIndex = index;     // feature index in the dataset
  this.isFastPoint = true;
  this.options = DEFAULT_POINT_STYLE.__full;
  this._style = DEFAULT_POINT_STYLE;
  this._key = DEFAULT_POINT_STYLE.__key;
}
FastPoint.prototype.getLatLng = function () { return this._latlng; };
// Styles are shared between points and never mutated, so a point keeps a
// reference rather than a copy. Each distinct style is prepared once: an
// identity key for batching and its colours as GPU-ready floats.
let styleSeq = 0;
function prepareStyle(style) {
  if (style.__key === undefined) {
    const full = Object.assign({ radius: 5, fillColor: "#888888", fillOpacity: 0.9, color: "#000000", weight: 1, opacity: 1 }, style);
    Object.defineProperty(style, "__key", { value: ++styleSeq });
    Object.defineProperty(style, "__full", { value: full });
    Object.defineProperty(style, "__fill", { value: colour(full.fillColor) });
    Object.defineProperty(style, "__stroke", { value: colour(full.color) });
  }
  return style;
}
FastPoint.prototype.setStyle = function (style) {
  if (this._style === style) return this;
  prepareStyle(style);
  this._group._dirtyStart = Math.min(this._group._dirtyStart ?? Infinity, this._slot);
  this._group._dirtyEnd = Math.max(this._group._dirtyEnd ?? -1, this._slot);
  this.options = style.__full;
  this._style = style;
  this._key = style.__key;
  this._group._requestRedraw();
  return this;
};
FastPoint.prototype.setRadius = function (r) { return this.setStyle(Object.assign({}, this.options, { radius: r })); };
FastPoint.prototype.bringToFront = function () { this._group._front = this; this._group._requestRedraw(); return this; };
FastPoint.prototype._containsPoint = function (p) {
  const pt = this._group._layerPoint(this._slot);
  if (!pt) return false;
  const r = this.options.radius + this._group.options.tolerance;
  const dx = p.x - pt.x, dy = p.y - pt.y;
  return dx * dx + dy * dy <= r * r;
};

const FastPoints = L.Layer.extend({
  options: { pane: "overlayPane", padding: 0.5, tolerance: 4 },

  // items: [{ latlng, feature, index }]
  initialize: function (items, options) {
    L.setOptions(this, options);
    this._points = new Array(items.length);
    this._xy0 = new Float64Array(items.length * 2);    // projected at zoom 0
    this._bounds = L.latLngBounds([]);
    this._front = null;
    this._frame = 0;
    if (!this.options.deferred) this.fillItems(items, 0, items.length);
  },

  fillItems: function (items, start, end) {
    const crs = L.CRS.EPSG3857;
    for (let i = start; i < end; i++) {
      const it = items[i];
      this._points[i] = new FastPoint(this, i, it.latlng, it.feature, it.index);
      const p = crs.latLngToPoint(it.latlng, 0);
      this._xy0[2 * i] = p.x;
      this._xy0[2 * i + 1] = p.y;
      this._bounds.extend(it.latlng);
    }
  },

  getLayers: function () { return this._points; },
  eachLayer: function (fn, ctx) { this._points.forEach(fn, ctx); return this; },
  getBounds: function () { return this._bounds; },

  bringToFront: function () {
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.appendChild(this._canvas);
    return this;
  },

  getEvents: function () {
    const events = { viewreset: this._reset, zoom: this._onZoom, moveend: this._update, zoomend: this._update, resize: this._update };
    if (this._zoomAnimated) events.zoomanim = this._onAnimZoom;
    return events;
  },

  onAdd: function () {
    // Hiding and showing a dataset reuses its canvas and GPU context.
    if (this._canvas) {
      this.getPane().appendChild(this._canvas);
      this._update();
      return;
    }
    const make = () => {
      const c = L.DomUtil.create("canvas", "omamap-points");
      if (this._zoomAnimated) L.DomUtil.addClass(c, "leaflet-zoom-animated");
      c.style.pointerEvents = "none";
      return c;
    };
    let canvas = make();
    // Browsers cap live WebGL contexts per page (about 16) and drop the oldest
    // beyond that, so the GPU is kept for layers big enough to need it.
    const wantGL = !FastPoints.disableWebGL && this._points.length >= FastPoints.glMinPoints && FastPoints.glLive < FastPoints.glMaxLayers;
    this._gl = wantGL ? initGL(canvas) : null;
    if (this._gl) FastPoints.glLive++;
    // A canvas that tried WebGL can't give a 2D context; start again.
    if (!this._gl) { canvas = make(); this._ctx = canvas.getContext("2d"); }
    this._canvas = canvas;
    this._mode = this._gl ? "webgl" : "2d";
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      if (this._gl) FastPoints.glLive--;
      this._gl = null; this._mode = "2d";
      if (!this._disposed) this._replaceCanvas();
    });
    this.getPane().appendChild(canvas);
    this._update();
  },

  // A lost WebGL context cannot become 2D in place; swap in a fresh canvas.
  _replaceCanvas: function () {
    const old = this._canvas;
    const canvas = this._canvas = L.DomUtil.create("canvas", old.className);
    canvas.style.pointerEvents = "none";
    this._ctx = canvas.getContext("2d");
    if (old.parentNode) old.parentNode.replaceChild(canvas, old);
    this._update();
  },

  onRemove: function () {
    cancelAnimationFrame(this._frame);
    this._frame = 0;
    L.DomUtil.remove(this._canvas);   // kept for re-adding; see dispose()
  },

  // Release the GPU context when the dataset is removed for good.
  dispose: function () {
    this._disposed = true;
    if (this._map) this._map.removeLayer(this);
    if (this._gl) {
      FastPoints.glLive--;
      const ext = this._gl.getExtension("WEBGL_lose_context");
      this._gl = null;
      if (ext) ext.loseContext();
    }
    this._canvas = null;
    this._ctx = null;
  },

  _reset: function () { this._update(); this._updateTransform(this._center, this._zoom); },

  _onZoom: function () { this._updateTransform(this._map.getCenter(), this._map.getZoom()); },

  _onAnimZoom: function (ev) { this._updateTransform(ev.center, ev.zoom); },

  _updateTransform: function (center, zoom) {
    if (!this._canvas || !this._center) return;
    const map = this._map;
    const scale = map.getZoomScale(zoom, this._zoom);
    const viewHalf = map.getSize().multiplyBy(0.5 + this.options.padding);
    const currentCenterPoint = map.project(this._center, zoom);
    const topLeftOffset = viewHalf.multiplyBy(-scale).add(currentCenterPoint).subtract(map._getNewPixelOrigin(center, zoom));
    L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
  },

  _update: function () {
    const map = this._map;
    if (!map || !this._canvas || (map._animatingZoom && this._pxBounds)) return;
    const p = this.options.padding, size = map.getSize();
    const min = map.containerPointToLayerPoint(size.multiplyBy(-p)).round();
    this._pxBounds = L.bounds(min, min.add(size.multiplyBy(1 + p * 2)).round());
    this._center = map.getCenter();
    this._zoom = map.getZoom();
    this._scale = map.getZoomScale(this._zoom, 0);
    this._origin = map.getPixelOrigin();
    const b = this._pxBounds, s = b.getSize(), dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this._canvas, b.min);
    const width = Math.round(dpr * s.x), height = Math.round(dpr * s.y);
    if (this._canvas.width !== width) this._canvas.width = width;
    if (this._canvas.height !== height) this._canvas.height = height;
    this._canvas.style.width = s.x + "px";
    this._canvas.style.height = s.y + "px";
    this._draw();
  },

  // Layer point of a point (same space as map.latLngToLayerPoint).
  _layerPoint: function (slot) {
    if (!this._map || this._scale === undefined) return null;
    return L.point(this._xy0[2 * slot] * this._scale - this._origin.x, this._xy0[2 * slot + 1] * this._scale - this._origin.y);
  },

  _requestRedraw: function () {
    if (!this._map || this._frame) return;
    this._frame = requestAnimationFrame(() => { this._frame = 0; this._draw(); });
  },

  _draw: function () {
    if (!this._canvas || !this._pxBounds) return;
    if (this._gl) { this._drawGL(); return; }
    const ctx = this._ctx, b = this._pxBounds, dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, -b.min.x * dpr, -b.min.y * dpr);

    // Group visible points by style, preserving draw order of first appearance.
    const groups = new Map();
    const xy = this._xy0, s = this._scale, ox = this._origin.x, oy = this._origin.y;
    const minX = b.min.x - 20, minY = b.min.y - 20, maxX = b.max.x + 20, maxY = b.max.y + 20;
    const pts = this._points;
    for (let i = 0; i < pts.length; i++) {
      const x = xy[2 * i] * s - ox, y = xy[2 * i + 1] * s - oy;
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      const pt = pts[i];
      if (pt === this._front) continue;
      let g = groups.get(pt._key);
      if (!g) { g = { style: pt.options, xs: [], ys: [] }; groups.set(pt._key, g); }
      g.xs.push(x); g.ys.push(y);
    }
    groups.forEach(function (g) {
      if (g.xs.length > 30) stamp(ctx, g.style, g.xs, g.ys, dpr);
      else paint(ctx, g.style, g.xs, g.ys);
    });
    if (this._front && this._front._group === this) {
      const f = this._front, slot = f._slot;
      paint(ctx, f.options, [xy[2 * slot] * s - ox], [xy[2 * slot + 1] * s - oy]);
    }
  },

  _drawGL: function () {
    const gl = this._gl, b = this._pxBounds, dpr = window.devicePixelRatio || 1;
    const size = b.getSize();
    // Canvas coordinates: layer point minus the canvas's top-left layer point.
    const xy = this._xy0, s = this._scale, ox = this._origin.x + b.min.x, oy = this._origin.y + b.min.y;
    const pts = this._points;
    const fresh = gl.omaData.length !== pts.length * FLOATS;
    if (fresh) {
      gl.omaData = new Float32Array(pts.length * FLOATS);
      this._dirtyStart = 0; this._dirtyEnd = pts.length - 1;
    }
    const data = gl.omaData;
    const start = this._dirtyStart ?? Infinity, end = this._dirtyEnd ?? -1;
    for (let i = start; i <= end; i++) {
      const pt = pts[i], o = pt.options, f = pt._style.__fill, c = pt._style.__stroke, k = i * FLOATS;
      const x = xy[2*i], y = xy[2*i+1];
      data[k] = x; data[k+1] = y;
      // Split coordinates preserve precision at high zoom without uploading
      // every point again when the map pans or zooms.
      data[k+12] = x - data[k]; data[k+13] = y - data[k+1];
      data[k+2] = f[0]; data[k+3] = f[1]; data[k+4] = f[2]; data[k+5] = o.fillOpacity;
      data[k+6] = c[0]; data[k+7] = c[1]; data[k+8] = c[2]; data[k+9] = o.weight > 0 ? o.opacity : 0;
      data[k+10] = o.radius; data[k+11] = o.weight;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.omaBuffer);
    if (fresh) gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    else if (end >= start) gl.bufferSubData(gl.ARRAY_BUFFER, start * FLOATS * 4, data.subarray(start * FLOATS, (end+1) * FLOATS));
    this._dirtyStart = Infinity; this._dirtyEnd = -1;
    gl.viewport(0, 0, this._canvas.width, this._canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(gl.omaUniforms.resolution, size.x, size.y);
    gl.uniform1f(gl.omaUniforms.dpr, dpr);
    const x0 = ox / s, y0 = oy / s, hx = Math.fround(x0), hy = Math.fround(y0);
    gl.uniform2f(gl.omaUniforms.originHigh, hx, hy);
    gl.uniform2f(gl.omaUniforms.originLow, x0-hx, y0-hy);
    gl.uniform1f(gl.omaUniforms.scale, s);
    if (this._front) {
      const slot = this._front._slot;
      if (slot) gl.drawArrays(gl.POINTS, 0, slot);
      if (slot+1 < pts.length) gl.drawArrays(gl.POINTS, slot+1, pts.length-slot-1);
      gl.drawArrays(gl.POINTS, slot, 1);
    } else gl.drawArrays(gl.POINTS, 0, pts.length);
  }
});

function paint(ctx, o, xs, ys) {
  const r = o.radius;
  ctx.beginPath();
  for (let i = 0; i < xs.length; i++) {
    ctx.moveTo(xs[i] + r, ys[i]);
    ctx.arc(xs[i], ys[i], r, 0, Math.PI * 2);
  }
  if (o.fillOpacity > 0) {
    ctx.globalAlpha = o.fillOpacity;
    ctx.fillStyle = o.fillColor;
    ctx.fill();
  }
  if (o.weight > 0 && o.opacity > 0) {
    ctx.globalAlpha = o.opacity;
    ctx.strokeStyle = o.color;
    ctx.lineWidth = o.weight;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ------------------------------- WebGL ----------------------------------- */
// Per point: x, y (css px from canvas top-left), fill rgba, stroke rgba,
// radius, stroke width (css px).
const FLOATS = 14;

const VERTEX_SHADER = [
  "attribute vec2 a_pos; attribute vec2 a_low; attribute vec4 a_fill; attribute vec4 a_stroke; attribute vec2 a_size;",
  "uniform vec2 u_resolution; uniform vec2 u_originHigh; uniform vec2 u_originLow; uniform float u_scale; uniform mediump float u_dpr;",   // same precision as the fragment shader
  "varying vec4 v_fill; varying vec4 v_stroke; varying vec3 v_shape;",
  "void main() {",
  "  vec2 pos = ((a_pos - u_originHigh) + (a_low - u_originLow)) * u_scale;",
  "  vec2 clip = pos / u_resolution * 2.0 - 1.0;",
  "  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);",
  "  float outer = a_size.x + a_size.y * 0.5 + 1.0;",
  "  gl_PointSize = outer * 2.0 * u_dpr;",
  "  v_fill = a_fill; v_stroke = a_stroke; v_shape = vec3(a_size, outer);",
  "}"
].join("\n");

// Leaflet semantics: fill inside the radius, stroke centred on the edge.
const FRAGMENT_SHADER = [
  "precision mediump float;",
  "uniform float u_dpr;",
  "varying vec4 v_fill; varying vec4 v_stroke; varying vec3 v_shape;",
  "void main() {",
  "  float r = v_shape.x, w = v_shape.y, outer = v_shape.z;",
  "  float d = length((gl_PointCoord - 0.5) * 2.0 * outer);",
  "  float aa = 0.6 / u_dpr + 0.25;",
  "  float fillA = (1.0 - smoothstep(r - aa, r + aa, d)) * v_fill.a;",
  "  float strokeA = 0.0;",
  "  if (w > 0.0) strokeA = smoothstep(r - w * 0.5 - aa, r - w * 0.5 + aa, d) * (1.0 - smoothstep(r + w * 0.5 - aa, r + w * 0.5 + aa, d)) * v_stroke.a;",
  "  float a = strokeA + fillA * (1.0 - strokeA);",
  "  if (a < 0.004) discard;",
  "  vec3 rgb = v_stroke.rgb * strokeA + v_fill.rgb * fillA * (1.0 - strokeA);",
  "  gl_FragColor = vec4(rgb, a);",   // premultiplied
  "}"
].join("\n");

function initGL(canvas) {
  let gl;
  try { gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true, depth: false, stencil: false }); }
  catch (e) { return null; }
  if (!gl) return null;
  const compile = function (type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  try {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.omaBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.omaBuffer);
    const stride = FLOATS * 4;
    [["a_pos", 2, 0], ["a_fill", 4, 2], ["a_stroke", 4, 6], ["a_size", 2, 10], ["a_low", 2, 12]].forEach(function (a) {
      const loc = gl.getAttribLocation(prog, a[0]);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a[1], gl.FLOAT, false, stride, a[2] * 4);
    });
    gl.omaUniforms = {};
    ["resolution", "dpr", "originHigh", "originLow", "scale"].forEach(function (key) { gl.omaUniforms[key] = gl.getUniformLocation(prog, "u_" + key); });
    gl.omaData = new Float32Array(0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Points larger than the GPU allows would be clipped; fall back to 2D.
    if (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] < 64) throw new Error("GPU point size limit too small.");
    return gl;
  } catch (e) {
    FastPoints.glError = String(e && e.message || e);   // kept for diagnosis; drawing falls back to 2D
    return null;
  }
}

const colourCache = new Map();
function colour(hex) {
  let c = colourCache.get(hex);
  if (!c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    const n = m ? parseInt(m[1], 16) : 0x888888;
    c = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    colourCache.set(hex, c);
  }
  return c;
}

/* ------------------------------ 2D fallback ------------------------------ */
/* Rasterising one path of thousands of circles is slow, so each style is
   drawn once into a small sprite and stamped at every point. */
const spriteCache = new Map();
function sprite(o, dpr) {
  const key = o.fillColor + "|" + o.fillOpacity + "|" + o.color + "|" + o.weight + "|" + o.opacity + "|" + o.radius + "|" + dpr;
  let s = spriteCache.get(key);
  if (s) return s;
  if (spriteCache.size > 500) spriteCache.clear();
  const half = Math.ceil(o.radius + o.weight / 2 + 1);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.ceil(2 * half * dpr);
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  paint(c, o, [half], [half]);
  s = { canvas: canvas, half: half };
  spriteCache.set(key, s);
  return s;
}

function stamp(ctx, o, xs, ys, dpr) {
  const s = sprite(o, dpr), size = 2 * s.half;
  for (let i = 0; i < xs.length; i++) ctx.drawImage(s.canvas, xs[i] - s.half, ys[i] - s.half, size, size);
}

FastPoints.glLive = 0;          // WebGL contexts currently held
FastPoints.glMaxLayers = 8;     // stay well under the browser's context cap
FastPoints.glMinPoints = 1000;  // smaller layers draw quickly enough in 2D

/* Build a FastPoints layer if every feature is a single Point. */
function fastPointsFor(features) {
  if (!features.length) return null;
  const items = new Array(features.length);
  for (let i = 0; i < features.length; i++) {
    const g = features[i].geometry;
    if (g.type !== "Point") return null;
    items[i] = { latlng: L.latLng(g.coordinates[1], g.coordinates[0]), feature: features[i], index: i };
  }
  return new FastPoints(items);
}

const DEFAULT_POINT_STYLE = prepareStyle({});
