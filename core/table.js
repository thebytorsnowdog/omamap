"use strict";
/* ---------------------------------------------------------------------------
   Attribute table: every row of one dataset, under the map. Rows are drawn
   on demand (virtual scrolling) so large datasets stay smooth. Selecting a
   row selects and zooms to the feature; selecting on the map highlights the
   row.
--------------------------------------------------------------------------- */

const ROW_HEIGHT = 26;
const TABLE_KEYS = { height: "omamap.tableHeight" };

const Table = {
  ds: null,
  order: null,        // feature indices after search / view filter / sort
  sort: null,         // { field, dir: 1 | -1 } or null
  query: "",
  inView: false,
  columns: [],        // [{ field, width }]
  selected: -1,       // feature index
  frame: 0,
  revision: 0,
  rows: new Map(),    // drawn row elements by position in `order`
  drawn: null,        // { order, c0, c1 } the drawn rows were built for
  colEdges: null,     // header cell [left, right] in px, measured lazily
  pending: Promise.resolve(),

  isOpen: function () { return !el("table-panel").hidden; },

  open: function (ds) {
    if (!ds) return;
    el("table-panel").hidden = false;
    if (this.ds !== ds) this.show(ds);
    else this.render();
    el("tp-scroll").focus({ preventScroll: true });
  },

  close: function () {
    this.revision++;
    cancelAnimationFrame(this.frame);
    el("table-panel").hidden = true;
    this.ds = null;
    this.order = null;
    this.columns = [];
    this.resetRows();
    el("tp-header").textContent = "";
    renderLayerList();
  },

  // Forget drawn rows; the next draw builds them again.
  resetRows: function () {
    this.rows = new Map();
    this.drawn = null;
    el("tp-body").textContent = "";
  },

  forget: function (ds) {
    if (this.last === ds) this.last = null;
    if (this.ds === ds) {
      this.revision++;
      cancelAnimationFrame(this.frame);
      this.ds = null; this.order = null; this.columns = [];
      this.resetRows();
      el("tp-header").textContent = "";
    }
    ds.rowText = null; ds.rowTextBytes = 0;
  },

  toggle: function () {
    if (this.isOpen()) { this.close(); return; }
    const hit = currentHit();
    const ds = hit ? hit.ds : (this.last && STATE.datasets.indexOf(this.last) >= 0 ? this.last : STATE.datasets[STATE.datasets.length - 1]);
    if (ds) this.open(ds);
  },

  show: function (ds) {
    this.ds = ds;
    this.order = null;
    this.last = ds;
    this.sort = null;
    this.selected = -1;
    this.query = "";
    el("tp-search").value = "";
    el("tp-scroll").scrollTop = 0;
    this.columns = this.measureColumns(ds);
    this.renderDatasetPicker();
    this.renderHeader();
    this.refilter();
    const hit = currentHit();
    if (hit && hit.ds === ds) this.reveal(hit.layer._omaIndex);
    renderLayerList();
  },

  // Column widths in ch from the header and a sample of values.
  measureColumns: function (ds) {
    const fields = datasetFields(ds);
    const n = Math.min(ds.features.length, 500);
    return fields.map(function (field) {
      let longest = field.length + 1;
      for (let i = 0; i < n; i++) {
        const v = propOf(ds.features[i].properties, field);
        const len = v === null || v === undefined ? 4 : (typeof v === "object" ? JSON.stringify(v).length : String(v).length);
        if (len > longest) longest = len;
      }
      return { field: field, width: Math.max(6, Math.min(40, longest + 3)) };   // + cell padding
    });
  },

  gridTemplate: function () {
    return "7ch " + this.columns.map(function (c) { return c.width + "ch"; }).join(" ");
  },

  renderDatasetPicker: function () {
    const sel = el("tp-dataset");
    sel.textContent = "";
    STATE.datasets.slice().reverse().forEach((ds) => {
      const o = document.createElement("option");
      o.value = ds.id; o.textContent = ds.name + " (" + ds.featureCount.toLocaleString() + ")";
      if (ds === this.ds) o.selected = true;
      sel.appendChild(o);
    });
  },

  renderHeader: function () {
    const head = el("tp-header");
    head.textContent = "";
    const template = this.gridTemplate();
    head.style.gridTemplateColumns = template;
    // Rows share the template through a custom property instead of each
    // carrying a copy of a string that can list a thousand columns.
    el("tp-body").style.setProperty("--tp-cols", template);
    this.colEdges = null;
    this.resetRows();
    const make = (label, field) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "tp-hcell";
      const active = this.sort && this.sort.field === field;
      b.textContent = label + (active ? (this.sort.dir > 0 ? " ▲" : " ▼") : "");
      b.title = field === null ? "Original order" : "Sort by " + label;
      b.addEventListener("click", () => this.toggleSort(field));
      head.appendChild(b);
    };
    make("#", null);
    this.columns.forEach(function (c) { make(c.field, c.field); });
  },

  toggleSort: function (field) {
    if (field === null) this.sort = null;
    else if (!this.sort || this.sort.field !== field) this.sort = { field: field, dir: 1 };
    else if (this.sort.dir === 1) this.sort.dir = -1;
    else this.sort = null;
    this.renderHeader();
    this.refilter();
  },

  rowText: function (i) {
    const ds = this.ds;
    if (!ds.rowText) ds.rowText = new Array(ds.features.length);
    let t = ds.rowText[i];
    if (t === undefined) {
      const p = ds.features[i].properties;
      t = Object.keys(p).map(function (k) { const v = p[k]; return v === null || v === undefined ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); }).join("\u0001").toLowerCase();
      // Bound the extra text cache independently of dataset size.
      const bytes = (ds.rowTextBytes || 0) + t.length * 2;
      if (bytes <= 16 * 1024 * 1024) { ds.rowText[i] = t; ds.rowTextBytes = bytes; }
    }
    return t;
  },

  inViewTest: function () {
    const bounds = STATE.map.getBounds();
    return function (layer) {
      if (layer.getLatLng) return bounds.contains(layer.getLatLng());
      if (layer.getBounds) { const b = layer.getBounds(); return b.isValid() && bounds.intersects(b); }
      return true;
    };
  },

  refilter: function () {
    this.pending = this.computeOrder();
    return this.pending;
  },

  computeOrder: async function () {
    const revision = ++this.revision;
    const ds = this.ds;
    if (!ds) return;
    const q = this.query.trim().toLowerCase();
    const visible = this.inView ? this.inViewTest() : null;
    let order = [];
    let started = performance.now();
    const pause = async () => { await new Promise(r => setTimeout(r, 0)); started = performance.now(); };
    for (let i = 0; i < ds.features.length; i++) {
      if (i % 256 === 0 && performance.now() - started > 8) {
        await pause(); if (this.revision !== revision || this.ds !== ds) return;
      }
      if (q && this.rowText(i).indexOf(q) < 0) continue;
      if (visible && !visible(ds.layers[i])) continue;
      order.push(i);
    }
    if (this.sort) {
      const field = this.sort.field, dir = this.sort.dir;
      const feats = ds.features;
      let keyed = new Array(order.length);
      for (let k = 0; k < order.length; k++) {
        const i = order[k], v = propOf(feats[i].properties, field);
        keyed[k] = { i: i, n: numericValue(v), s: isMissing(v) ? null : (typeof v === "object" ? JSON.stringify(v) : String(v)) };
        if (k % 256 === 0 && performance.now() - started > 8) {
          await pause(); if (this.revision !== revision || this.ds !== ds) return;
        }
      }
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      const compare = function (a, b) {
        if (a.s === null || b.s === null) return a.s === b.s ? a.i - b.i : (a.s === null ? 1 : -1);   // missing last
        if (a.n !== null && b.n !== null) return (a.n - b.n) * dir || a.i - b.i;
        return collator.compare(a.s, b.s) * dir || a.i - b.i;
      };
      // Native sort on small runs is faster than a full JavaScript merge
      // sort, while bounded runs and cooperative merging keep it responsive.
      const runSize = 2048;
      for (let lo = 0; lo < keyed.length; lo += runSize) {
        const run = keyed.slice(lo, lo + runSize).sort(compare);
        for (let i = 0; i < run.length; i++) keyed[lo+i] = run[i];
        if (performance.now() - started > 8) {
          await pause(); if (this.revision !== revision || this.ds !== ds) return;
        }
      }
      let scratch = new Array(keyed.length);
      for (let width = runSize; width < keyed.length; width *= 2) {
        for (let lo = 0; lo < keyed.length; lo += width * 2) {
          const mid = Math.min(lo + width, keyed.length), hi = Math.min(lo + width * 2, keyed.length);
          let a = lo, b = mid;
          for (let k = lo; k < hi; k++) {
            scratch[k] = b >= hi || (a < mid && compare(keyed[a], keyed[b]) <= 0) ? keyed[a++] : keyed[b++];
            if (k % 1024 === 0 && performance.now() - started > 8) {
              await pause(); if (this.revision !== revision || this.ds !== ds) return;
            }
          }
        }
        const previous = keyed; keyed = scratch; scratch = previous;
      }
      order = keyed.map(function (k) { return k.i; });
    }
    if (this.revision !== revision || this.ds !== ds) return;
    this.order = order;
    const count = el("tp-count");
    count.textContent = order.length === ds.features.length
      ? plural(order.length, "row")
      : order.length.toLocaleString() + " of " + plural(ds.features.length, "row");
    el("tp-body").style.height = (order.length * ROW_HEIGHT) + "px";
    el("tp-body").style.width = el("tp-header").scrollWidth + "px";
    this.render();
  },

  render: function () {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  },

  // Header cell edges in px, read once per header (one layout).
  measureEdges: function () {
    const cells = el("tp-header").children, edges = new Array(Math.max(0, cells.length - 1));
    for (let k = 1; k < cells.length; k++) edges[k - 1] = [cells[k].offsetLeft, cells[k].offsetLeft + cells[k].offsetWidth];
    this.colEdges = edges;
  },

  // Columns overlapping the horizontal viewport, with one either side.
  visibleColumns: function (left, width) {
    if (!this.colEdges || this.colEdges.length !== this.columns.length) this.measureEdges();
    const e = this.colEdges, n = e.length;
    if (!n) return [0, -1];
    if (!e[n - 1][1]) return [0, n - 1];   // not laid out (hidden): draw every column
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid][1] <= left) lo = mid + 1; else hi = mid; }
    let c1 = lo;
    while (c1 < n - 1 && e[c1 + 1][0] < left + width) c1++;
    return [Math.max(0, lo - 1), Math.min(n - 1, c1 + 1)];
  },

  makeRow: function (pos, c0, c1) {
    const i = this.order[pos];
    const p = this.ds.features[i].properties;
    const row = document.createElement("div");
    row.className = "tp-row" + (i === this.selected ? " selected" : "") + (pos % 2 ? " odd" : "");
    row.style.top = (pos * ROW_HEIGHT) + "px";
    row.dataset.index = i;
    const num = document.createElement("span"); num.className = "tp-cell tp-num"; num.textContent = String(i + 1);
    row.appendChild(num);
    for (let k = c0; k <= c1; k++) {
      const v = propOf(p, this.columns[k].field);
      const cell = document.createElement("span");
      cell.className = v === null || v === undefined ? "tp-cell nullish" : "tp-cell";
      // Off-screen columns to the left are not drawn: place the first one.
      if (k === c0 && c0 > 0) cell.style.gridColumn = String(k + 2);
      const text = v === null ? "null" : v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      cell.textContent = text;
      cell.title = text;
      row.appendChild(cell);
    }
    return row;
  },

  /* Only rows and columns in view are drawn. Scrolling keeps the rows that
     stay in view and adds or removes the ones at the edges; the full set is
     rebuilt only when the row order or the visible columns change. */
  draw: function () {
    const ds = this.ds;
    if (!ds || !this.order) return;
    const scroll = el("tp-scroll");
    const body = el("tp-body");
    const top = Math.max(0, scroll.scrollTop - el("tp-header").offsetHeight);
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 10);
    const last = Math.min(this.order.length, first + Math.ceil(scroll.clientHeight / ROW_HEIGHT) + 20);
    const cols = this.visibleColumns(scroll.scrollLeft, scroll.clientWidth);
    const c0 = cols[0], c1 = cols[1];
    const d = this.drawn;
    if (!d || d.order !== this.order || d.c0 !== c0 || d.c1 !== c1) {
      this.rows = new Map();
      body.textContent = "";
      this.drawn = { order: this.order, c0: c0, c1: c1 };
    }
    let lowest = Infinity;
    for (const [pos, row] of this.rows) {
      if (pos < first || pos >= last) { row.remove(); this.rows.delete(pos); }
      else {
        if (pos < lowest) lowest = pos;
        row.classList.toggle("selected", Number(row.dataset.index) === this.selected);
      }
    }
    const before = document.createDocumentFragment(), after = document.createDocumentFragment();
    for (let pos = first; pos < last; pos++) {
      if (this.rows.has(pos)) continue;
      const row = this.makeRow(pos, c0, c1);
      this.rows.set(pos, row);
      (pos < lowest ? before : after).appendChild(row);
    }
    // Keep document order = visual order.
    if (before.firstChild) body.insertBefore(before, body.firstChild);
    if (after.firstChild) body.appendChild(after);
  },

  // Column widths are in ch, so a font change moves the edges.
  onThemeChanged: function () {
    this.colEdges = null;
    if (this.isOpen()) { this.resetRows(); this.render(); }
  },

  // Select the feature for a row and show it on the map.
  choose: function (index, zoom) {
    const ds = this.ds;
    if (!ds) return;
    if (!ds.visible) toggleVisible(ds.id);
    clearHighlight();
    STATE.hits = [{ ds: ds, layer: ds.layers[index] }];
    STATE.hitIndex = 0;
    showSelection();
    if (zoom) zoomToSelection();
    else panToSelection();
  },

  // Highlight and scroll to a feature's row (after a map selection).
  reveal: function (index) {
    this.selected = index;
    const pos = this.order ? this.order.indexOf(index) : -1;
    if (pos >= 0) {
      const scroll = el("tp-scroll");
      const head = el("tp-header").offsetHeight;
      const y = pos * ROW_HEIGHT + head;
      if (y < scroll.scrollTop + head || y + ROW_HEIGHT > scroll.scrollTop + scroll.clientHeight) {
        scroll.scrollTop = Math.max(0, y - head - scroll.clientHeight / 3);
      }
    }
    this.render();
  },

  onSelection: function () {
    if (!this.isOpen()) return;
    const hit = currentHit();
    if (!hit) { this.selected = -1; this.render(); return; }
    if (hit.ds !== this.ds) this.show(hit.ds);
    this.reveal(hit.layer._omaIndex);
  },

  onDatasetsChanged: function () {
    if (!this.isOpen()) return;
    if (!this.ds || STATE.datasets.indexOf(this.ds) < 0) {
      if (STATE.datasets.length) this.show(STATE.datasets[STATE.datasets.length - 1]);
      else this.close();
      return;
    }
    this.renderDatasetPicker();
  },

  step: function (delta) {
    if (!this.order || !this.order.length) return;
    let pos = this.order.indexOf(this.selected);
    pos = pos < 0 ? 0 : Math.max(0, Math.min(this.order.length - 1, pos + delta));
    this.choose(this.order[pos], false);
  },

  wire: function () {
    const saved = Number(storageGet(TABLE_KEYS.height));
    if (saved >= 120) el("table-panel").style.height = saved + "px";
    el("tp-close").addEventListener("click", () => this.close());
    el("tp-dataset").addEventListener("change", (e) => { const ds = findDs(e.target.value); if (ds) this.show(ds); });
    let searchTimer = 0;
    el("tp-search").addEventListener("input", (e) => {
      this.query = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.refilter(), 120);
    });
    el("tp-inview").addEventListener("change", (e) => { this.inView = e.target.checked; this.refilter(); });
    STATE.map.on("moveend", () => { if (this.isOpen() && this.inView) this.refilter(); });
    el("tp-scroll").addEventListener("scroll", () => this.render(), { passive: true });
    el("tp-body").addEventListener("click", (e) => {
      const row = e.target.closest(".tp-row");
      if (row) this.choose(Number(row.dataset.index), false);
    });
    el("tp-body").addEventListener("dblclick", (e) => {
      const row = e.target.closest(".tp-row");
      if (row) this.choose(Number(row.dataset.index), true);
    });
    el("tp-scroll").addEventListener("keydown", (e) => {
      const page = Math.max(1, Math.floor(el("tp-scroll").clientHeight / ROW_HEIGHT) - 2);
      if (e.key === "ArrowDown") { e.preventDefault(); this.step(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); this.step(-1); }
      else if (e.key === "PageDown") { e.preventDefault(); this.step(page); }
      else if (e.key === "PageUp") { e.preventDefault(); this.step(-page); }
      else if (e.key === "Enter") { e.preventDefault(); zoomToSelection(); }
    });
    new ResizeObserver(() => { this.colEdges = null; this.render(); }).observe(el("tp-scroll"));

    // Drag the top edge to resize.
    const handle = el("tp-resize");
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const panel = el("table-panel");
      const startY = e.clientY, startH = panel.offsetHeight;
      const max = el("center").offsetHeight - 120;
      const move = (ev) => { panel.style.height = Math.max(120, Math.min(max, startH + startY - ev.clientY)) + "px"; };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        storageSet(TABLE_KEYS.height, String(panel.offsetHeight));
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  }
};
