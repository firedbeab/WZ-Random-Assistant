const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HALF, faces, geometry, output, dot } = require('../build-dice-core.cjs');
const root = path.resolve(__dirname, '../..');
const key = vertex => vertex.join(',');

test('骰子内芯的六面、十二边、八角构成封闭凸体，没有开口、反面或越出外层面的顶点', () => {
  assert.equal(faces.length, 26);
  assert.equal(faces.filter(face => face.length === 3).length, 8);
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
  assert.equal(vertices.size, 24); assert.equal(edges.size, 48);
  assert([...edges.values()].every(count => count === 2), '每条边必须由两个面严密共享');
  assert.equal(vertices.size - edges.size + faces.length, 2);
});

test('内芯样式与几何生成源一致，全部面片映射到有效的2D裁剪与3D旋转', () => {
  const actual = fs.readFileSync(path.join(root, 'components/easter-dice/dice-core.wxss'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actual, output()); assert(!/NaN|Infinity/.test(actual));
  assert.equal((actual.match(/\.core-facet-\d+ /g) || []).length, 26);
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
