const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

let calls = [];
let handler = () => ({ result: { success: false, code: 'NOT_SET' } });
function loadModule() {
  const sandbox = {
    module: { exports: {} }, exports: {}, require: () => ({ cloudCall: options => { calls.push(options); return Promise.resolve(handler(options)); } }),
    setTimeout, clearTimeout, Date, Promise, Object, Array, Error, Number, String, Math, JSON
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../utils/image-access.js'), 'utf8'), sandbox);
  return sandbox.module.exports;
}
const ok = files => ({ result: { success: true, data: { files } } });
const issued = (fileID, maxAgeSec = 600) => [{ fileID, url: 'https://example.com/signed.jpg', maxAge: maxAgeSec, expiresAt: Date.now() + maxAgeSec * 1000 }];

(async () => {
  // 1) 正常签发并缓存：第二次直接命中缓存，不再请求服务端。
  let access = loadModule();
  calls = []; handler = () => ok(issued('cloud://a.jpg'));
  check(await access.resolve('manageEasterEggs', 'cloud://a.jpg'), 'https://example.com/signed.jpg', '第一次拿到签名地址');
  check(calls.length, 1, '第一次调用了服务端');
  check(await access.resolve('manageEasterEggs', 'cloud://a.jpg'), 'https://example.com/signed.jpg', '第二次命中缓存');
  check(calls.length, 1, '缓存命中时不再请求服务端');

  // 2) 剩余有效期不足安全余量的地址不会被采用；仍有一分钟以上余量的正常采用。
  access = loadModule();
  calls = [];
  handler = () => ({ result: { success: true, data: { files: [{ fileID: 'cloud://b.jpg', url: 'https://example.com/soon.jpg', maxAge: 600, expiresAt: Date.now() + 30000 }] } } });
  let tooSoon = null;
  try { await access.resolve('manageHelpContent', 'cloud://b.jpg'); } catch (err) { tooSoon = err; }
  check(Boolean(tooSoon), true, '剩余不足一分钟的地址按失败处理');
  check(access.valid('cloud://b.jpg'), '', '剩余不足一分钟的地址不进入可用缓存');

  access = loadModule();
  calls = [];
  handler = () => ({ result: { success: true, data: { files: [{ fileID: 'cloud://b2.jpg', url: 'https://example.com/ok.jpg', maxAge: 600, expiresAt: Date.now() + 120000 }] } } });
  check(await access.resolve('manageHelpContent', 'cloud://b2.jpg'), 'https://example.com/ok.jpg', '两分钟余量可以正常使用');
  check(calls.length, 1, '可用地址只请求一次');

  // 3) 已过期地址视为无效，不能当成功结果返回。
  access = loadModule();
  calls = [];
  handler = () => ({ result: { success: true, data: { files: [{ fileID: 'cloud://c.jpg', url: 'https://example.com/old.jpg', maxAge: 600, expiresAt: Date.now() - 1000 }] } } });
  let expired = null;
  try { await access.resolve('manageEasterEggs', 'cloud://c.jpg'); } catch (err) { expired = err; }
  check(Boolean(expired), true, '服务端返回已过期地址时按失败处理');
  check(access.valid('cloud://c.jpg'), '', '过期地址不会被当成可用地址');

  // 4) 服务端拒绝时最多重试两次，然后抛出带错误码的异常；失败不写缓存。
  access = loadModule();
  calls = [];
  handler = () => ({ result: { success: false, code: 'IMAGE_NOT_AVAILABLE' } });
  let failed = null;
  try { await access.resolve('manageEasterEggs', 'cloud://d.jpg'); } catch (err) { failed = err; }
  check(Boolean(failed), true, '失败会抛出异常');
  check(failed.code, 'IMAGE_NOT_AVAILABLE', '异常保留服务端错误码');
  check(calls.length, 2, '失败重试一次后停止（共两次尝试）');
  check(access.valid('cloud://d.jpg'), '', '失败不写缓存');

  // 5) 并发请求同一个文件只发一次服务端请求。
  access = loadModule();
  calls = [];
  handler = async () => { await new Promise(resolve => setTimeout(resolve, 10)); return ok(issued('cloud://e.jpg')); };
  const [first, second] = await Promise.all([access.resolve('manageEasterEggs', 'cloud://e.jpg'), access.resolve('manageEasterEggs', 'cloud://e.jpg')]);
  check(first, second, '并发请求返回同一地址');
  check(calls.length, 1, '并发只请求一次');

  // 6) 批量：服务端只回可用项时，其余项不出现在结果里；整批异常也不抛穿。
  access = loadModule();
  calls = [];
  handler = options => {
    const ids = options.data.fileIDs.filter(id => id !== 'cloud://bad.jpg');
    return ok(ids.map(id => ({ fileID: id, url: `https://example.com/${id.slice(-5)}`, maxAge: 600, expiresAt: Date.now() + 600000 })));
  };
  const batch = await access.resolveMany('manageHelpContent', ['cloud://x.jpg', 'cloud://bad.jpg', 'cloud://y.jpg']);
  check(batch['cloud://x.jpg'], 'https://example.com/x.jpg', '批量返回可用地址');
  check(batch['cloud://bad.jpg'], undefined, '服务端未签发的项不出现在结果里');
  check(calls.length, 1, '同批次只请求一次');

  // 7) 整批请求异常时 resolveMany 仍然安静返回，不会把错误抛给页面。
  access = loadModule();
  calls = [];
  handler = () => { throw new Error('batch failed'); };
  const failedBatch = await access.resolveMany('manageHelpContent', ['cloud://z.jpg']);
  check(failedBatch['cloud://z.jpg'], undefined, '整批异常时返回空结果');

  // 7) forget 之后必须重新申请。
  access = loadModule();
  calls = [];
  handler = () => ok(issued('cloud://f.jpg'));
  await access.resolve('manageEasterEggs', 'cloud://f.jpg');
  access.forget('cloud://f.jpg');
  await access.resolve('manageEasterEggs', 'cloud://f.jpg');
  check(calls.length, 2, 'forget 后重新申请');

  // 8) 非法输入直接拒绝，不请求服务端。
  access = loadModule();
  calls = [];
  let invalid = null;
  try { await access.resolve('manageEasterEggs', ''); } catch (err) { invalid = err; }
  check(Boolean(invalid), true, '空 fileID 被拒绝');
  check(calls.length, 0, '非法输入不请求服务端');

  console.log(`PASS: ${checks} signed image access assertions; cache hit, near-expiry rejection, expired url, retry limit, failure not cached, concurrency dedupe, batch partial failure and invalid input`);
})().catch(err => { console.error(err); process.exit(1); });
