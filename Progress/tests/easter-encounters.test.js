const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const disk = new Map();
function load(scope = 'test', broken = false) {
  const context = { module: { exports: {} }, require: () => ({ storageKey: key => scope + '_' + key }), wx: {
    getStorageSync(key) { if (broken) throw new Error('unavailable'); return structuredClone(disk.get(key)); },
    setStorageSync(key, value) { if (broken) throw new Error('unavailable'); disk.set(key, structuredClone(value)); }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/easter-encounters.js'), 'utf8'), context);
  return context.module.exports;
}
const test = load();
const catalog = ['a', 'b', 'c'];
assert.equal(test.summary('photo', catalog).seen, 0);
test.record('photo', 'b', catalog); test.record('photo', 'a', catalog); test.record('photo', 'a', catalog);
assert.equal(test.summary('photo', catalog).seen, 2);
assert.equal(test.summary('photo', ['a', 'c']).seen, 1, 'disabled/deleted entries excluded');
assert.equal(test.summary('photo', catalog.concat('d')).total, 4);
test.record('photo', 'invalid', catalog); assert.equal(test.summary('photo', catalog).seen, 2);
assert.equal(test.summary('cat', catalog).seen, 0, 'photo and ASCII collections separate');
assert.equal(load('prod').summary('photo', catalog).seen, 0, 'test/prod isolation');
const reload = load(); assert.equal(reload.summary('photo', catalog).seen, 2);
const items = catalog.map(id => ({ id }));
assert.equal(reload.pick('photo', items, '', () => 0).id, 'a', 'last item remains selectable');
assert.equal(reload.pick('photo', items, '', () => .12).id, 'b');
assert.equal(reload.pick('photo', items, '', () => .34).id, 'c');
const histogram = { a: 0, b: 0, c: 0 };
for (let i = 0; i < 9000; i++) histogram[reload.pick('photo', items, '', () => (i + .5) / 9000).id]++;
assert.deepEqual(histogram, { a: 1000, b: 2000, c: 6000 });
assert.equal(reload.pick('photo', []), null);
assert.equal(reload.pick('photo', [{ id: 'a' }]).id, 'a');
reload.record('photo', 'c', catalog);
assert.equal(reload.summary('photo', catalog).seen, 3);
assert.equal(reload.pick('photo', items, '', () => .99).id, 'c', 'all collected still permits last-item repeat');
const unavailable = load('broken', true);
unavailable.record('cat', 'wink', ['wink', 'peek']);
assert.equal(unavailable.summary('cat', ['wink', 'peek']).seen, 1);
disk.set('corrupt_easter_encounters_v1', { photo: ['a', 'a', null, 1], cat: 'bad' });
const repaired = load('corrupt');
assert.equal(repaired.summary('photo', catalog).seen, 1);
assert.equal(repaired.summary('cat', catalog).seen, 0);
console.log('PASS: distinct local counts, active catalogs, scope isolation, persistence, 3/1/0.5 weights, repeats, empty lists and storage failures');
