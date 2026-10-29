"use strict";
// A bounded adaptive grid narrows hit tests before the renderer performs the
// exact geometry test. Geometries that would fill too many fine cells go into
// a coarser grid, and only geometries that cover that coarser grid as well
// stay on the overflow list checked for every query. Feature indices preserve
// stacking order. Search results are the same set a full bounding-box scan
// would return.
//
// Construction yields every 512 features and every 8192 positions, so an
// import can paint and Cancel between slices. The stack tracks an index into
// each coordinate array, so one long ring is not copied onto the stack.
class SpatialIndex {
  constructor(features) {
    Object.assign(this, SpatialIndex.finish(SpatialIndex.steps(features)));
  }

  static finish(steps) {
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  static *steps(features) {
    const index = Object.create(SpatialIndex.prototype);
    index.boxes = new Float64Array(features.length * 4);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    let since = 0;
    for (let i = 0; i < features.length; i++) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const stack = [];
      const pushGeometry = (g) => {
        if (g.type === "GeometryCollection") stack.push({ kind: "geoms", arr: g.geometries, at: 0 });
        // A Point's coordinates array is the position. Every other type's
        // coordinates array contains positions or deeper arrays.
        else if (typeof g.coordinates[0] === "number") stack.push({ kind: "pos", pos: g.coordinates });
        else stack.push({ kind: "coords", arr: g.coordinates, at: 0 });
      };
      const take = (child) => {
        if (child[0] < x0) x0 = child[0];
        if (child[1] < y0) y0 = child[1];
        if (child[0] > x1) x1 = child[0];
        if (child[1] > y1) y1 = child[1];
      };
      pushGeometry(features[i].geometry);
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.kind === "pos") {
          take(frame.pos);
          stack.pop();
          if (++since === 8192) { since = 0; yield; }
          continue;
        }
        if (frame.at >= frame.arr.length) { stack.pop(); continue; }
        const child = frame.arr[frame.at++];
        if (typeof child[0] === "number") {
          take(child);
          if (++since === 8192) { since = 0; yield; }
        } else if (frame.kind === "geoms") pushGeometry(child);
        else stack.push({ kind: "coords", arr: child, at: 0 });
      }
      index.boxes.set([x0, y0, x1, y1], i * 4);
      if (x0 < west) west = x0;
      if (y0 < south) south = y0;
      if (x1 > east) east = x1;
      if (y1 > north) north = y1;
      if ((i & 511) === 511) yield;
    }
    index.west = west; index.south = south;
    index.size = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(features.length / 8))));
    index.dx = (east - west || 1) / index.size; index.dy = (north - south || 1) / index.size;
    index.coarse = Math.max(1, Math.min(32, index.size));
    index.cdx = (east - west || 1) / index.coarse; index.cdy = (north - south || 1) / index.coarse;
    index.cells = new Map(); index.coarseCells = new Map(); index.wide = [];
    for (let i = 0; i < features.length; i++) {
      const b = index.boxes.subarray(i * 4, i * 4 + 4);
      const fine = index.range(b[0], b[1], b[2], b[3]);
      if (index.span(fine) <= 64) index.fill(index.cells, index.size, fine, i);
      else {
        const coarse = index.coarseRange(b[0], b[1], b[2], b[3]);
        if (index.span(coarse) <= 64) index.fill(index.coarseCells, index.coarse, coarse, i);
        else index.wide.push(i);
      }
      if ((i & 511) === 511) yield;
    }
    return index;
  }

  span(r) { return (r[2] - r[0] + 1) * (r[3] - r[1] + 1); }
  fill(cells, stride, r, i) {
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const key = y * stride + x;
      let list = cells.get(key);
      if (!list) cells.set(key, list = []);
      list.push(i);
    }
  }
  clampRange(w, s, e, n, size, dx, dy) {
    const clamp = (v) => Math.max(0, Math.min(size - 1, v));
    return [clamp(Math.floor((w - this.west) / dx)), clamp(Math.floor((s - this.south) / dy)),
      clamp(Math.floor((e - this.west) / dx)), clamp(Math.floor((n - this.south) / dy))];
  }
  range(w, s, e, n) { return this.clampRange(w, s, e, n, this.size, this.dx, this.dy); }
  coarseRange(w, s, e, n) { return this.clampRange(w, s, e, n, this.coarse, this.cdx, this.cdy); }
  collect(found, cells, stride, r) {
    for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) {
      const cell = cells.get(y * stride + x);
      if (cell) for (const i of cell) found.add(i);
    }
  }
  search(w, s, e, n) {
    const found = new Set(this.wide);
    this.collect(found, this.cells, this.size, this.range(w, s, e, n));
    this.collect(found, this.coarseCells, this.coarse, this.coarseRange(w, s, e, n));
    const out = [];
    for (const i of found) {
      const k = i * 4, b = this.boxes;
      if (b[k] <= e && b[k + 2] >= w && b[k + 1] <= n && b[k + 3] >= s) out.push(i);
    }
    return out.sort((a, b) => b - a);
  }
}
if (typeof module === "object") module.exports = SpatialIndex;
