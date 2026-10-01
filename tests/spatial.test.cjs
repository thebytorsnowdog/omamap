const test = require('node:test');
const assert = require('node:assert/strict');
const SpatialIndex = require('../core/spatial.js');

test('spatial queries match brute force and preserve reverse feature order', () => {
  let seed = 17;
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
  const boxes = Array.from({length:10000}, () => {
    const x = random()*100, y = random()*100, width = random()*3;
    return [x,y,x+width,y+width];
  });
  boxes.push([-180,-90,180,90]); // overflow geometry
  const index = new SpatialIndex(boxes.map(b => ({geometry:{type:'LineString',coordinates:[[b[0],b[1]],[b[2],b[3]]]}})));
  for (let trial=0; trial<100; trial++) {
    const w = random()*140-20,s=random()*140-20,e=w+1,n=s+1;
    const want=boxes.flatMap((b,i)=>b[0]<=e && b[2]>=w && b[1]<=n && b[3]>=s ? [i] : []).reverse();
    assert.deepEqual(index.search(w,s,e,n),want);
  }
  assert.ok(index.wide.includes(boxes.length-1));
});

test('coincident points and nested geometries are searchable at boundaries', () => {
  const index=new SpatialIndex([{geometry:{type:'GeometryCollection',geometries:[{type:'Point',coordinates:[0,0]}]}},{geometry:{type:'Point',coordinates:[0,0]}}]);
  assert.deepEqual(index.search(0,0,0,0),[1,0]);
  assert.deepEqual(index.search(1,1,2,2),[]);
});
