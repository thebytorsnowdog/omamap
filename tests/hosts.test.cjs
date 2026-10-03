"use strict";
/* The tile hosts are listed in three places: core/basemaps.js (what the app
   asks for), the page CSP (core/index.html, and the same policy sent as a
   header by host/scheme.cpp) and the native RequestFilter allow-list. A host
   missing from any of them silently breaks a basemap; an extra one widens
   what the app may contact. Usage: npm test */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function basemapHosts() {
  const ctx = {};
  vm.runInNewContext(read("core/basemaps.js") + "\n;this.list = OMAMAP_BASEMAPS;", ctx);
  const hosts = new Set();
  for (const b of ctx.list) {
    for (const u of [b.url, b.labels]) {
      if (!u) continue;
      const host = u.match(/^https:\/\/([^/]+)\//)[1];
      const subs = typeof b.subdomains === "string" ? b.subdomains.split("") : Array.isArray(b.subdomains) ? b.subdomains : ["a", "b", "c"];   // Leaflet's default
      if (host.includes("{s}")) subs.forEach((s) => hosts.add(host.replace("{s}", s)));
      else hosts.add(host);
    }
  }
  return [...hosts].sort();
}

function metaPolicy() {
  const m = read("core/index.html").match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, "index.html has a CSP meta tag");
  return m[1];
}

function headerPolicy() {
  const src = read("host/scheme.cpp");
  const m = src.match(/ContentSecurityPolicy\s*=\s*((?:\s*"(?:[^"\\]|\\.)*")+)\s*;/);
  assert.ok(m, "scheme.cpp defines ContentSecurityPolicy");
  return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]).join("");
}

const directives = (policy) => new Map(policy.split(";").map((d) => d.trim()).filter(Boolean)
  .map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));
const imgHosts = (policy) => directives(policy).get("img-src").filter((s) => s.startsWith("https://")).map((s) => new URL(s).host).sort();

function filterRegex() {
  const src = read("host/scheme.cpp");
  const m = src.match(/QRegularExpression allowed\(QStringLiteral\(\s*"((?:[^"\\]|\\.)*)"\)\)/);
  assert.ok(m, "scheme.cpp has the RequestFilter allow-list");
  return new RegExp(m[1].replace(/\\\\/g, "\\"));
}

test("every basemap host is in the page CSP, the header CSP and the native allow-list", () => {
  const hosts = basemapHosts();
  assert.ok(hosts.length >= 3, "found the basemap hosts");
  assert.deepEqual(imgHosts(metaPolicy()), hosts, "index.html img-src lists exactly the basemap hosts");
  assert.deepEqual(imgHosts(headerPolicy()), hosts, "scheme.cpp img-src lists exactly the basemap hosts");
  const allowed = filterRegex();
  for (const h of hosts) assert.match(h, allowed, h + " passes the RequestFilter");
  for (const h of ["example.com", "tile.openstreetmap.org.evil.com", "d.tile.opentopomap.org", "xserver.arcgisonline.com"])
    assert.doesNotMatch(h, allowed, h + " is blocked");
});

test("the CSP header and meta tag are the same policy, plus frame-ancestors", () => {
  const meta = directives(metaPolicy()), header = directives(headerPolicy());
  assert.deepEqual(header.get("frame-ancestors"), ["'none'"]);
  header.delete("frame-ancestors");
  assert.deepEqual([...header.entries()].sort(), [...meta.entries()].sort());
});
