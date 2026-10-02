"use strict";
/* Faster drawing for large vector layers.

   With tens of thousands of polygons, Leaflet's canvas renderer spends most
   of a redraw rasterising shapes that are only a pixel or two across: each
   one is filled and stroked as a full path. Measured in Chromium (see the PR
   and tests/bench.cjs), the per-shape cost is in rasterising, not in the
   JavaScript calls, so merging shapes into one big path does not help (one
   Path2D of 50,000 squares took over 12 s to fill and stroke; chunks of 32
   saved under 15%).

   What does help is drawing a shape that covers at most TINY_PX pixels each
   way as a single filled rectangle: what the eye sees at that size anyway.
   This renderer does that for paths that opt in (layer._omaBatch, set by the
   app for datasets with at least MIN_FEATURES shapes). Runs of such shapes
   with the same colour share one fill state. Draw order is unchanged, and
   everything else (small datasets, larger shapes, circle markers, the
   highlighted selection) is drawn by Leaflet exactly as before.

   Visible difference, only for shapes at most TINY_PX across in a large
   dataset: the shape is a solid rectangle with the same centre and painted
   area as the round-cornered blob Leaflet would draw, in the outline colour
   and opacity (or the fill's, when it has no outline). Zoom in
   and shapes are drawn exactly as before. Hit-testing is unchanged: it uses
   each layer's own geometry. */
const OmaBatch = (function () {
  const MIN_FEATURES = 2000;
  const TINY_PX = 3;

  /* The rectangle with the same centre, proportions and area as what Leaflet
     would paint: the shape grown by r = half the outline width with round
     joins (a Minkowski sum: area + perimeter × r + π r²). Leaflet has usually
     simplified a tiny shape to two or three points by now, so this uses its
     drawn parts, not the original geometry. Writes [x, y, w, h] into `out`;
     returns false if nothing would show. */
  function tinyRect(parts, closed, r, filled, out) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, twiceArea = 0, perimeter = 0;
    for (let i = 0; i < parts.length; i++) {
      const ring = parts[i], n = ring.length;
      for (let j = 0; j < n; j++) {
        const a = ring[j];
        if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
        if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
        if (j === n - 1 && !closed) break;
        const b = ring[(j + 1) % n];
        twiceArea += a.x * b.y - b.x * a.y;
        perimeter += Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
      }
    }
    if (minX === Infinity) return false;
    const w = maxX - minX, h = maxY - minY;
    // An open line's outline runs along both sides.
    const area = (closed && filled ? Math.abs(twiceArea) / 2 : 0) + (r ? (closed ? perimeter : 2 * perimeter) * r + Math.PI * r * r : 0);
    if (area <= 0) return false;
    const g = (-(w + h) + Math.sqrt((w + h) * (w + h) - 4 * (w * h - area))) / 4;
    const sx = Math.max(0, w + 2 * g), sy = Math.max(0, h + 2 * g);
    out[0] = minX + w / 2 - sx / 2; out[1] = minY + h / 2 - sy / 2; out[2] = sx; out[3] = sy;
    return true;
  }

  function isTiny(layer) {
    const b = layer._rawPxBounds;
    return !!b && b.max.x - b.min.x <= TINY_PX && b.max.y - b.min.y <= TINY_PX;
  }

  function canvas(options) {
    const Batched = L.Canvas.extend({
      // Same contract as L.Canvas#_draw: clip to the dirty rectangle and draw,
      // in order, every path that intersects it.
      _draw: function () {
        const bounds = this._redrawBounds, ctx = this._ctx;
        ctx.save();
        if (bounds) {
          const size = bounds.getSize();
          ctx.beginPath();
          ctx.rect(bounds.min.x, bounds.min.y, size.x, size.y);
          ctx.clip();
        }
        this._drawing = true;
        let colour = null, alpha = -1;
        const rect = this._omaRect || (this._omaRect = new Float64Array(4));
        for (let order = this._drawFirst; order; order = order.next) {
          const layer = order.layer;
          if (bounds && !(layer._pxBounds && layer._pxBounds.intersects(bounds))) continue;
          if (layer._omaBatch && !layer._omaHighlight && layer._parts && layer._parts.length && isTiny(layer)) {
            // Painted in the outline's colour and opacity, or the fill's when
            // there is no outline.
            const o = layer.options, stroked = o.stroke && o.weight > 0;
            if (!stroked && !o.fill) continue;
            if (!tinyRect(layer._parts, layer instanceof L.Polygon, stroked ? o.weight / 2 : 0, !!o.fill, rect)) continue;
            const c = stroked ? o.color : (o.fillColor || o.color), a = stroked ? o.opacity : o.fillOpacity;
            if (c !== colour || a !== alpha) {
              colour = c; alpha = a;
              ctx.fillStyle = c; ctx.globalAlpha = a;
            }
            ctx.fillRect(rect[0], rect[1], rect[2], rect[3]);
          } else {
            layer._updatePath();
            colour = null;   // Leaflet changed the fill state
          }
        }
        this._drawing = false;
        ctx.restore();
      }
    });
    return new Batched(options);
  }

  return { MIN_FEATURES: MIN_FEATURES, TINY_PX: TINY_PX, canvas: canvas, tinyRect: tinyRect };
})();

if (typeof module !== "undefined" && module.exports) module.exports = OmaBatch;
