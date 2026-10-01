"use strict";
// A bounded adaptive grid narrows hit tests before the renderer performs the
// exact geometry test. Very large geometries occupy a separate overflow list,
// avoiding an entry in every cell. Feature indices preserve stacking order.
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
    this.cells = new Map(); this.wide = [];
    for (let i = 0; i < features.length; i++) {
      const b = this.boxes.subarray(i*4,i*4+4), r = this.range(...b);
      if ((r[2]-r[0]+1)*(r[3]-r[1]+1)>64) { this.wide.push(i); continue; }
      for (let y=r[1]; y<=r[3]; y++) for (let x=r[0]; x<=r[2]; x++) {
        const key=y*this.size+x;
        if (!this.cells.has(key)) this.cells.set(key,[]);
        this.cells.get(key).push(i);
      }
    }
  }
  range(w,s,e,n) {
    const clamp = (v) => Math.max(0,Math.min(this.size-1,v));
    return [clamp(Math.floor((w-this.west)/this.dx)),clamp(Math.floor((s-this.south)/this.dy)),
      clamp(Math.floor((e-this.west)/this.dx)),clamp(Math.floor((n-this.south)/this.dy))];
  }
  search(w,s,e,n) {
    const r=this.range(w,s,e,n), found=new Set(this.wide);
    for (let y=r[1]; y<=r[3]; y++) for (let x=r[0]; x<=r[2]; x++) {
      const cell=this.cells.get(y*this.size+x);
      if (cell) for (const i of cell) found.add(i);
    }
    const out=[];
    for (const i of found) {
      const k=i*4,b=this.boxes;
      if (b[k]<=e && b[k+2]>=w && b[k+1]<=n && b[k+3]>=s) out.push(i);
    }
    return out.sort((a,b)=>b-a);
  }
}
if (typeof module === "object") module.exports = SpatialIndex;
