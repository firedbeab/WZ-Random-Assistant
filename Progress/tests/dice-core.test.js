const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HALF, SIZE, measure, faces, geometry, output, dot } = require('../build-dice-core.cjs');
const root = path.resolve(__dirname, '../..');
const key = vertex => vertex.join(',');

test('骰子内芯的六面、十二边、八角构成封闭凸体，没有开口、反面或越出外层面的顶点', () => {
  assert.equal(faces.length, 114);
  assert.equal(faces.filter(face => face.length === 3).length, 24);
  const vertices = new Map(), edges = new Map();
  for (const face of faces) {
    const g = geometry(face), plane = dot(g.normal, g.center);
    assert(plane > 0); assert(g.width > 0 && g.height > 0);
    for (const vertex of faces.flat()) assert(dot(g.normal, vertex) <= plane + 1e-8, '每个面朝外，所有顶点在其内侧');
    face.forEach((vertex, index) => {
      assert(vertex.every(value => Math.abs(value) <= HALF && Math.abs(value) < 67));
      vertices.set(key(vertex), vertex);
      const edge = [key(vertex), key(face[(index + 1) % face.length])].sort().join('|');
      edges.set(edge, (edges.get(edge) || 0) + 1);
    });
  }
  assert.equal(vertices.size, 104); assert.equal(edges.size, 216);
  assert([...edges.values()].every(count => count === 2), '每条边必须由两个面严密共享');
  assert.equal(vertices.size - edges.size + faces.length, 2);
});

test('单一尺寸换算后再计算内外深度，窄屏及非整数像素尺寸不会将两层取整成共面', () => {
  assert.equal(SIZE,134);
  assert(!/\d(?:\.\d+)?rpx/.test(output()),'内芯所有尺寸/位置只由统一尺寸推导');
  const ratio=Number(measure(HALF).match(/\* ([\d.]+)/)[1]);
  for(const width of [54,57.5,67,69,71.25,80,96]) {
    const outer=width/2,inner=width*ratio;
    assert(inner<outer);assert(outer-inner>.19);
    for(const vertices of faces){const g=geometry(vertices);assert(Math.abs(width*g.width/SIZE/2+width*(-g.width/2)/SIZE)<1e-8);}
  }
});

test('即使加上补缝覆盖，实体所有面片仍严格在点阵层以内，六面均使用同一安全间距', () => {
  const css=fs.readFileSync(path.join(root,'components/easter-dice/easter-dice.wxss'),'utf8');
  assert(css.includes('--dice-pip-depth: calc(var(--dice-size) / 2 + 1px)'));
  assert.equal((css.match(/translateZ\(var\(--dice-pip-depth\)\)/g)||[]).length,6);
  for(const size of [54,57.5,67,69,71.25,80,96])for(const face of faces){
    const g=geometry(face);
    for(let axis=0;axis<3;axis++) {
      const coreExtent=Math.max(...face.map(v=>Math.abs(v[axis])))*size/SIZE;
      const coverage=.5*(Math.abs(g.u[axis])+Math.abs(g.v[axis]));
      assert(coreExtent+coverage<size/2+1,'扩大面片后的包围盒不能触及点阵');
    }
  }
});

test('内芯样式与几何生成源一致，全部面片映射到有效的2D裁剪与3D旋转', () => {
  const actual = fs.readFileSync(path.join(root, 'components/easter-dice/dice-core.wxss'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, output()); assert(!/NaN|Infinity/.test(actual));
  assert.equal((actual.match(/\.core-facet-\d+ /g) || []).length, faces.length);
  const component=fs.readFileSync(path.join(root,'components/easter-dice/easter-dice.js'),'utf8');
  assert.equal(Number(component.match(/coreFacets: Array\.from\(\{ length: (\d+)/)[1]),faces.length);
  for (const face of faces) {
    const g = geometry(face);
    assert(Math.abs(dot(g.u, g.v)) < 1e-8);
    assert(Math.abs(dot(g.u, g.normal)) < 1e-8);
    for (const point of g.points) {
      const x = (point[0] - g.low[0]) / g.width, y = (point[1] - g.low[1]) / g.height;
      assert(x >= -1e-8 && x <= 1 + 1e-8 && y >= -1e-8 && y <= 1 + 1e-8);
    }
  }
});
