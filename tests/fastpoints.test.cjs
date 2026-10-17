"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function renderer(styles, front = -1) {
  const context = vm.createContext({
    L: { Layer: { extend: (definition) => definition } },
    window: { devicePixelRatio: 1 }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", "fastpoints.js"), "utf8") + "\nthis.render = FastPoints._draw;", context);
  const fills = [], arcs = [];
  const ctx = {
    setTransform() {}, clearRect() {}, beginPath() { arcs.length = 0; }, moveTo() {},
    arc(x, y) { arcs.push([x, y]); },
    fill() { fills.push({ colour: this.fillStyle, positions: arcs.slice() }); }
  };
  const group = {
    _ctx: ctx, _canvas: { width: 100, height: 100 },
    _pxBounds: { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } },
    _scale: 1, _origin: { x: 0, y: 0 },
    _xy0: new Float64Array(styles.flatMap(() => [50, 50]))
  };
  group._points = styles.map((colour, i) => ({
    _key: colour, _slot: i, _group: group,
    options: { radius: 5, fillColor: colour, fillOpacity: 1, weight: 0 }
  }));
  group._front = front < 0 ? null : group._points[front];
  return { draw: () => context.render.call(group), fills };
}

test("2D points preserve feature stacking when a style repeats after another style", () => {
  const r = renderer(["#ff0000", "#0000ff", "#ff0000"]);
  r.draw();
  assert.deepEqual(r.fills.map((f) => f.colour), ["#ff0000", "#0000ff", "#ff0000"]);
  assert.deepEqual(r.fills.map((f) => f.positions), [[[50, 50]], [[50, 50]], [[50, 50]]]);
});

test("zoomed-in 2D drawing skips distant points and keeps feature order", () => {
  const count = 2000;
  const styles = Array.from({ length: count }, (_, i) => (i % 2 ? "#0000ff" : "#ff0000"));
  const context = vm.createContext({
    L: { Layer: { extend: (definition) => definition } },
    window: { devicePixelRatio: 1 }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", "fastpoints.js"), "utf8") + "\nthis.render = FastPoints._draw;", context);
  const fills = [];
  const ctx = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {},
    arc(x) { fills.push(x); },
    fill() {}
  };
  const group = {
    _ctx: ctx, _canvas: { width: 100, height: 40 },
    _pxBounds: { min: { x: 0, y: 0 }, max: { x: 40, y: 10 } },
    _scale: 1, _origin: { x: 0, y: 0 },
    _xy0: new Float64Array(count * 2),
    _front: null
  };
  for (let i = 0; i < count; i++) group._xy0[2 * i] = i * 10;
  group._points = styles.map((colour, i) => ({
    _key: colour, _slot: i, _group: group,
    options: { radius: 5, fillColor: colour, fillOpacity: 1, weight: 0 }
  }));
  context.render.call(group);
  // Padded view is x -20..60. Points sit at 0, 10, ... so 0 through 60.
  assert.deepEqual(fills, [0, 10, 20, 30, 40, 50, 60]);
});

test("2D points batch consecutive styles while keeping the selected feature on top", () => {
  const r = renderer(["#ff0000", "#ff0000", "#0000ff", "#00ff00"], 2);
  r.draw();
  assert.deepEqual(r.fills.map((f) => f.colour), ["#ff0000", "#00ff00", "#0000ff"]);
  assert.deepEqual(r.fills.map((f) => f.positions.length), [2, 1, 1]);
});
