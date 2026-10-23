const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const dataScope = require('../../cloudfunctions/manageEasterEggs/dataScope');
const docs = new Map(), files = new Map();
let role = 'user', securityPass = true;
const deleted = [];
const db = {
  serverDate: () => new Date(),
  collection(name) {
    let query = {};
    const collection = {
      where(value) { query = value; return collection; }, limit() { return collection; },
      async get() {
        if (name === 'users') return { data: [{ role }] };
        const value = docs.get(name);
        return { data: value && value._id === query._id ? [structuredClone(value)] : [] };
      },
      async add({ data }) { if (docs.has(name)) throw new Error('duplicate'); docs.set(name, structuredClone(data)); return { _id: data._id }; },
      async update({ data }) {
        const value = docs.get(name);
        const changed = value && value._id === query._id && value.revision === query.revision;
        if (changed) docs.set(name, { ...value, ...data });
        return { stats: { updated: changed ? 1 : 0 } };
      }
    };
    return collection;
  }
};
const cloud = {
  DYNAMIC_CURRENT_ENV: '', init() {}, database: () => db,
  getWXContext: () => ({ OPENID: 'mock-user', ENV: 'cloud-test' }),
  openapi: { security: { msgSecCheck: async () => ({ result: { suggest: securityPass ? 'pass' : 'risky' } }) } },
  async uploadFile({ cloudPath, fileContent }) { const fileID = `cloud://cloud-test.bucket/${cloudPath}`; files.set(fileID, fileContent); return { fileID }; },
  async downloadFile({ fileID }) { if (!files.has(fileID)) throw new Error('missing'); return { fileContent: files.get(fileID) }; },
  async deleteFile({ fileList }) { fileList.forEach(file => { files.delete(file); deleted.push(file); }); }
};
const context = { exports: {}, Buffer, console: { warn() {} }, require(name) {
  if (name === 'wx-server-sdk') return cloud;
  if (name === './dataScope') return dataScope;
  return require(name);
} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../cloudfunctions/manageEasterEggs/index.js'), 'utf8'), context);
const main = context.exports.main;
const image = Buffer.from([255, 216, 255, 0, 0]).toString('base64');
(async () => {
  assert.equal((await main({ action: 'listPublished' })).success, true);
  assert.equal((await main({ action: 'listAll' })).success, false);
  assert.equal((await main({ action: 'listPublished', _testMode: true })).success, false);
  role = 'admin'; assert.equal((await main({ action: 'uploadImage', base64: image })).success, false);
  role = 'superadmin';
  const prod = await main({ action: 'uploadImage', base64: image });
  assert.ok(prod.data.fileID.includes('/easter-eggs/') && !prod.data.fileID.includes('/test/'));
  const test = await main({ action: 'uploadImage', _testMode: true, base64: image });
  const entry = { action: 'save', revision: 0, id: '', fileID: test.data.fileID, topText: '', bottomText: '', enabled: true, _testMode: true };
  assert.equal((await main({ ...entry, fileID: prod.data.fileID })).success, false);
  assert.equal((await main({ ...entry, fileID: 'cloud://another-env.bucket/test/easter-eggs/x.jpg' })).success, false);
  assert.equal((await main({ ...entry, topText: 'x'.repeat(41) })).success, false);
  assert.equal((await main({ ...entry, enabled: 'true' })).success, false);
  const saved = await main(entry); assert.equal(saved.success, true);
  assert.equal(docs.has('configs'), false); assert.equal(docs.get('test_configs').entries.length, 1);
  assert.equal((await main(entry)).success, false);
  const id = saved.data.id;
  assert.equal((await main({ action: 'setEnabled', id, revision: 1, enabled: false, _testMode: true })).success, true);
  assert.equal((await main({ action: 'listPublished', _testMode: true })).data.entries.length, 0);
  await main({ action: 'deleteFiles', fileIDs: [entry.fileID], _testMode: true });
  assert.ok(files.has(entry.fileID), '引用中的图片不得清理');
  const second = await main({ ...entry, revision: 2 }); assert.equal(second.success, true);
  assert.equal((await main({ action: 'delete', id, revision: 3, _testMode: true })).success, true);
  assert.ok(files.has(entry.fileID), '共享照片仍被另一条引用');
  assert.equal((await main({ action: 'delete', id: second.data.id, revision: 4, _testMode: true })).success, true);
  assert.ok(!files.has(entry.fileID)); assert.equal(deleted.length, 1);
  securityPass = false;
  assert.equal((await main({ ...entry, _testMode: false, fileID: prod.data.fileID, topText: 'unsafe' })).success, false);
  securityPass = true;
  assert.equal((await main({ ...entry, _testMode: false, fileID: prod.data.fileID, topText: 'hello' })).success, true);
  role = 'user';
  assert.equal((await main({ action: 'listPublished' })).data.entries.length, 1);
  assert.equal((await main({ action: 'listPublished', _testMode: true })).success, false);
  console.log('PASS: public reads, superadmin gate, forged test flag, scopes, revisions, validation, safety and shared-file cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
