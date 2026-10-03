"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function keyboard() {
  let handler;
  const context = vm.createContext({
    document: { addEventListener(name, fn) { if (name === "keydown") handler = fn; } },
    window: {}, Event
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "core", "app.js"), "utf8") + `
    this.actions = [];
    cycleBasemap = function () { actions.push("basemap"); };
    clearSelection = function () { actions.push("selection"); };
    renderAttributes = function () {};
    wireKeys();
  `, context);
  return {
    actions: context.actions,
    press(key, target) { handler({ key, target, preventDefault() {} }); }
  };
}

test("Escape notifies search listeners after clearing a query", () => {
  const keys = keyboard();
  let query = "roads", blurred = false;
  const target = {
    tagName: "INPUT", type: "search", value: query,
    dispatchEvent(event) {
      assert.equal(event.type, "input");
      assert.equal(event.bubbles, true);
      query = this.value;
    },
    blur() { blurred = true; }
  };
  keys.press("Escape", target);
  assert.equal(target.value, "");
  assert.equal(query, "", "search state follows the visible empty input");
  assert.equal(blurred, true);
  assert.equal(keys.actions.length, 0);
});

test("native select key presses do not activate map shortcuts", () => {
  const keys = keyboard();
  keys.press("b", { tagName: "SELECT" });
  assert.equal(keys.actions.length, 0);
  keys.press("b", { tagName: "DIV" });
  assert.deepEqual(Array.from(keys.actions), ["basemap"]);
});

test("Escape leaves non-text form controls unchanged", () => {
  const keys = keyboard();
  for (const target of [
    { tagName: "INPUT", type: "range", value: "8" },
    { tagName: "INPUT", type: "color", value: "#ff0000" },
    { tagName: "SELECT", value: "roads" }
  ]) {
    let blurred = false;
    const original = target.value;
    target.blur = () => { blurred = true; };
    keys.press("Escape", target);
    assert.equal(target.value, original);
    assert.equal(blurred, true);
  }
  assert.equal(keys.actions.length, 0);
});
