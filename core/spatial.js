"use strict";
// A bounded adaptive grid narrows hit tests before the renderer performs the
// exact geometry test. Geometries that would fill too many fine cells go into
// a coarser grid, and only geometries that cover that coarser grid as well
// stay on the overflow list checked for every query. Feature indices preserve
// stacking order. Search results are the same set a full bounding-box scan
// would return.
class SpatialIndex {
  constructor(features) {
    this.boxes = new Float64Array(features.length * 4);
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    features.forEach((feature, i) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const coordinates = (c) => {
        if (typeof c[0] === "number") { x0 = Math.min(x0,c[0]); y0 = Math.min(y0,c[1]); x1 = Math.max(x1,c[0]); y1 = Math.max(y1,c[1]); }
        else c.forEach(coordinates);
      };
      const geometry = (g) => { if (g.type === "GeometryCollection") g.geometries.forEach(geometry); else coordinates(g.coordinates); };
      geometry(feature.geometry);
      this.boxes.set([x0,y0,x1,y1],i*4);
      west = Math.min(west,x0); south = Math.min(south,y0); east = Math.max(east,x1); north = Math.max(north,y1);
    });
    this.west = west; this.south = south;
    this.size = Math.max(1,Math.min(256,Math.ceil(Math.sqrt(features.length / 8))));
    this.dx = (east-west || 1) / this.size; this.dy = (north-south || 1) / this.size;
    this.coarse = Math.max(1,Math.min(32,this.size));
    this.cdx = (east-west || 1) / this.coarse; this.cdy = (north-south || 1) / this.coarse;
    this.cells = new Map(); this.coarseCells = new Map(); this.wide = [];
    for (let i = 0; i < features.length; i++) {
      const b = this.boxes.subarray(i*4,i*4+4);
      const fine = this.range(b[0],b[1],b[2],b[3]);
      if (this.span(fine) <= 64) { this.fill(this.cells, this.size, fine, i); continue; }
      const coarse = this.coarseRange(b[0],b[1],b[2],b[3]);
      if (this.span(coarse) <= 64) this.fill(this.coarseCells, this.coarse, coarse, i);
      else this.wide.push(i);
    }
  }
  span(r) { return (r[2]-r[0]+1)*(r[3]-r[1]+1); }
  fill(cells, stride, r, i) {
    for (let y=r[1]; y<=r[3]; y++) for (let x=r[0]; x<=r[2]; x++) {
      const key=y*stride+x;
      let list=cells.get(key);
      if (!list) cells.set(key, list=[]);
      list.push(i);
    }
  }
  clampRange(w,s,e,n,size,dx,dy) {
    const clamp = (v) => Math.max(0,Math.min(size-1,v));
    return [clamp(Math.floor((w-this.west)/dx)),clamp(Math.floor((s-this.south)/dy)),
      clamp(Math.floor((e-this.west)/dx)),clamp(Math.floor((n-this.south)/dy))];
  }
  range(w,s,e,n) { return this.clampRange(w,s,e,n,this.size,this.dx,this.dy); }
  coarseRange(w,s,e,n) { return this.clampRange(w,s,e,n,this.coarse,this.cdx,this.cdy); }
  collect(found, cells, stride, r) {
    for (let y=r[1]; y<=r[3]; y++) for (let x=r[0]; x<=r[2]; x++) {
      const cell=cells.get(y*stride+x);
      if (cell) for (const i of cell) found.add(i);
    }
  }
  search(w,s,e,n) {
    const found=new Set(this.wide);
    this.collect(found, this.cells, this.size, this.range(w,s,e,n));
    this.collect(found, this.coarseCells, this.coarse, this.coarseRange(w,s,e,n));
    const out=[];
    for (const i of found) {
      const k=i*4,b=this.boxes;
      if (b[k]<=e && b[k+2]>=w && b[k+1]<=n && b[k+3]>=s) out.push(i);
    }
    return out.sort((a,b)=>b-a);
  }
}
if (typeof module === "object") module.exports = SpatialIndex;
