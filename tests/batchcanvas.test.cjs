"use strict";
/* Geometry of the large-layer fast path (core/batchcanvas.js): a tiny shape
   becomes one rectangle with the same centre and painted area as what
   Leaflet would draw. Usage: npm test */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const B = require(path.join(__dirname, "..", "core", "batchcanvas.js"));

const pt = (x, y) => ({ x, y });
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const rectOf = (parts, closed, paint) => { const out = [0, 0, 0, 0]; return B.tinyRect(parts, closed, paint.grow, paint.filled, out) ? out : null; };
const area = (r) => r[2] * r[3];
const centre = (r) => [r[0] + r[2] / 2, r[1] + r[3] / 2];

test("a polygon simplified to two points is painted like Leaflet's round-capped line", () => {
  const paint = { grow: 1, filled: true };   // weight 2
  const r = rectOf([[pt(10, 10), pt(11, 10.5)]], true, paint);
  const len = Math.hypot(1, 0.5);
  close(area(r), len * 2 + Math.PI, 1e-9, "capsule area");
  assert.deepEqual(centre(r), [10.5, 10.25]);
  assert.ok(r[2] >= r[3], "keeps the shape's proportions");
});

test("a small filled square with an outline matches its round-joined outline area", () => {
  const paint = { grow: 0.75, filled: true };
  const sq = [[pt(0, 0), pt(2, 0), pt(2, 2), pt(0, 2)]];
  const r = rectOf(sq, true, paint);
  close(area(r), 4 + 8 * 0.75 + Math.PI * 0.75 * 0.75, 1e-9, "area");
  assert.deepEqual(centre(r), [1, 1]);
  close(r[2], r[3], 1e-12, "square stays square");
});

test("an open line is outlined on both sides; an unoutlined line paints nothing", () => {
  const line = [[pt(0, 0), pt(2, 0)]];
  close(area(rectOf(line, false, { grow: 1, filled: false })), 2 * 2 * 1 + Math.PI, 1e-9, "line area");
  assert.equal(rectOf(line, false, { grow: 0, filled: false }), null);
  // A fill-only polygon collapsed to a line has no area, as in Leaflet.
  assert.equal(rectOf([[pt(0, 0), pt(1, 1)]], true, { grow: 0, filled: true }), null);
});

test("a fill-only triangle shrinks to its own area inside its box", () => {
  const r = rectOf([[pt(0, 0), pt(3, 0), pt(0, 3)]], true, { grow: 0, filled: true });
  close(area(r), 4.5, 1e-9, "area");
  assert.ok(r[2] <= 3 && r[3] <= 3);
  assert.equal(rectOf([], true, { grow: 1, filled: true }), null);
});

test("only datasets with many shapes, and only shapes a few pixels across, take the fast path", () => {
  assert.ok(B.MIN_FEATURES >= 1000, "small layers keep Leaflet's drawing");
  assert.ok(B.TINY_PX > 0 && B.TINY_PX <= 3);
});
