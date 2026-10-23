const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const storage = new Map(), disk = new Map();
let downloads = 0, reads = 0, offline = false;
let entries = [{ id: 'cat', fileID: 'cloud://mock/easter-eggs/cat.jpg', topText: '', bottomText: '' }];
const apiFS = {};
for (const method of ['access', 'mkdir', 'unlink', 'copyFile', 'getFileInfo']) apiFS[method] = options => queueMicrotask(() => {
  try {
    let result = {};
    if (method === 'access' && !disk.has(options.path)) throw new Error('missing');
    if (method === 'unlink') disk.delete(options.filePath);
    if (method === 'getFileInfo') { if (!disk.has(options.filePath)) throw new Error('missing'); result.size = disk.get(options.filePath); }
    if (method === 'copyFile') disk.set(options.destPath, disk.get(options.srcPath));
    options.success(result);
  } catch (err) { options.fail({ errMsg: err.message }); }
});
function load(testMode) {
  const wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getFileSystemManager: () => apiFS,
    getStorageSync: key => structuredClone(storage.get(key)), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    cloud: { async downloadFile({ fileID }) {
      downloads++; const tempFilePath = `wxfile://temp/${downloads}`;
      disk.set(tempFilePath, fileID.includes('large') ? 3 * 1024 * 1024 : 2 * 1024 * 1024);
      return { tempFilePath };
    } },
    // 私有桶下普通用户走服务端签发的短时地址下载，不再直接用 fileID。
    downloadFile({ url, success, fail }) {
      downloads++; const tempFilePath = `wxfile://temp/${downloads}`;
      disk.set(tempFilePath, url.includes('large') ? 3 * 1024 * 1024 : 2 * 1024 * 1024);
      if (success) success({ statusCode: 200, tempFilePath });
      else if (fail) fail({ errMsg: 'downloadFile:fail' });
    }
  };
  const runtime = { isTestMode: () => testMode, storageKey: key => `${testMode ? 'test' : 'prod'}_${key}`,
    async cloudCall() { reads++; await Promise.resolve(); if (offline) throw new Error('offline'); return { result: { success: true, data: { entries: structuredClone(entries) } } }; }
  };
  const encounterContext = { module: { exports: {} }, require: () => runtime, wx };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/easter-encounters.js'), 'utf8'), encounterContext);
  const imageAccess = { async resolve(fnName, fileID) { return `https://signed.example/${fileID}`; }, forget() {}, valid() { return ''; } };
  const diagnostics = { record() {} };
  const context = { module: { exports: {} }, require: name => name.includes('encounters') ? encounterContext.module.exports
    : name.includes('image-access') ? imageAccess
    : name.includes('diagnostics') ? diagnostics
    : runtime, wx, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/easter-egg-photos.js'), 'utf8'), context);
  return context.module.exports;
}
(async () => {
  const test = load(true);
  await Promise.all([test.manifest(true), test.manifest(true)]); assert.equal(reads, 1);
  const [one, two] = await Promise.all([test.cacheImage(entries[0].fileID), test.cacheImage(entries[0].fileID)]);
  assert.equal(one, two); assert.equal(downloads, 1);
  const prepared = await test.prepare(); assert.equal(prepared.path, one); assert.equal(prepared.topText, test.DEFAULT_TOP); assert.equal(downloads, 1);
  assert.equal(prepared.bottomText, test.DEFAULT_BOTTOM); assert.equal(prepared.hasCustomBottom, false);
  assert.deepEqual(Array.from(prepared.catalogIds), ['cat']);
  assert.equal(storage.has('test_easter_encounters_v1'), false, 'prefetch must not count an encounter');
  assert.equal((await test.prepareCached()).path, one); assert.equal(downloads, 1);
  entries[0].bottomText = '管理员自定义'; await test.manifest(true);
  assert.equal((await test.prepare()).hasCustomBottom, true);
  assert.equal((await test.prepareCached()).bottomText, '管理员自定义');
  assert.equal((await test.prepareCached()).hasCustomBottom, true);
  entries[0].bottomText = ''; await test.manifest(true);
  disk.delete(one); assert.equal(await test.cachedPath(entries[0].fileID), '');
  assert.equal(await test.prepareCached(), null); assert.equal(downloads, 1);
  await test.cacheImage(entries[0].fileID); assert.equal(downloads, 2);
  for (let i = 0; i < 8; i++) await test.cacheImage(`cloud://mock/easter-eggs/${i}.jpg`);
  const index = storage.get('test_easter_files_v2');
  assert.equal(Object.keys(index).length, 6); assert.equal(Object.values(index).reduce((sum, item) => sum + item.size, 0), 12 * 1024 * 1024);
  await assert.rejects(test.cacheImage('cloud://mock/easter-eggs/large.jpg'));
  const originalEntries = entries;
  entries = [
    { id: 'cached', fileID: 'cloud://mock/easter-eggs/7.jpg' },
    { id: 'uncached', fileID: 'cloud://mock/easter-eggs/not-downloaded.jpg' }
  ];
  await test.manifest(true);
  const cachedReward = await test.prepareCached('cached');
  assert.equal(cachedReward.id, 'cached', 'last image may repeat when cached-only has one choice');
  assert.deepEqual(Array.from(cachedReward.catalogIds), ['cached', 'uncached'], 'counter total includes all active entries, not just downloaded ones');
  assert.equal(downloads, 11, 'cached-only must not download');
  entries = originalEntries; await test.manifest(true);
  offline = true; assert.equal((await test.manifest(true)).length, 1);
  const saved = storage.get('test_easter_manifest_v2'); saved.time = Date.now() - 86400001; storage.set('test_easter_manifest_v2', saved);
  assert.equal((await test.manifest(true)).length, 0);
  offline = false;
  entries = [];
  await test.manifest(true); assert.equal(await test.prepare(), null);
  const prod = load(false);
  assert.equal(await prod.cachedPath('cloud://mock/easter-eggs/7.jpg'), '');
  const prodFile = await prod.cacheImage('cloud://mock/easter-eggs/7.jpg'); assert.ok(prodFile.startsWith('wxfile://usr/easter-prod/'));
  assert.ok(Object.values(storage.get('test_easter_files_v2')).every(item => item.path.startsWith('wxfile://usr/easter-test/')));
  await assert.rejects(test.withTimeout(new Promise(() => {}), 5), /timeout/);
  console.log('PASS: manifest/download dedupe, persistent hit, missing file recovery, 12MB eviction, size cap, offline expiry, empty list, scope isolation and timeout');
})().catch(err => { console.error(err); process.exitCode = 1; });
