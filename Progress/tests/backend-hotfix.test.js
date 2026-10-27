const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

function fixture(name, options = {}) {
  const state = {
    role: options.role || 'user', openid: options.openid === undefined ? 'mock-user' : options.openid,
    rows: new Map(), calls: [], logs: [], deleted: [], errors: new Map(),
    signingFailure: false, signingItemFailure: false, signingMaxAge: 600, badURL: false,
    correctCode: false, duplicateCreation: false
  };
  const command = { inc: value => ({ increment: value }), in: value => ({ in: value }), neq: value => ({ neq: value }) };
  const db = {
    command, serverDate: () => new Date(),
    collection(name) {
      let filter = {}, cap = Infinity;
      function failure(op) { if (state.errors.has(`${name}.${op}`)) throw state.errors.get(`${name}.${op}`); }
      const rows = () => (state.rows.get(name) || []).filter(row => Object.entries(filter).every(([key, value]) => row[key] === value)).slice(0, cap);
      const ref = {
        where(query) { filter = query; return ref; }, limit(value) { cap = value; return ref; },
        orderBy() { return ref; }, field() { return ref; },
        async get() {
          state.calls.push([name, 'get']); failure('get');
          if (name === 'users' || name === 'test_users') return { data: [{ openid: state.openid, role: state.role }] };
          return { data: structuredClone(rows()) };
        },
        async count() { state.calls.push([name, 'count']); failure('get'); return { total: rows().length }; },
        async add({ data }) {
          state.calls.push([name, 'add']); failure('add');
          const stored = state.rows.get(name) || [];
          if (name.endsWith('login_attempts') && state.duplicateCreation) {
            state.duplicateCreation = false;
            stored.push({ _id: state.openid, fail_count: 1, locked_until: null }); state.rows.set(name, stored);
            throw new Error('E11000 duplicate key');
          }
          if (data._id && stored.some(row => row._id === data._id)) throw new Error('E11000 duplicate key');
          stored.push({ _id: data._id || `row-${stored.length}`, ...structuredClone(data) }); state.rows.set(name, stored);
          return { _id: stored[stored.length - 1]._id };
        },
        async update({ data }) {
          state.calls.push([name, 'update']); failure('update');
          const stored = state.rows.get(name) || [];
          const matches = stored.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value));
          for (const row of matches) for (const [key, value] of Object.entries(data)) {
            row[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] || 0) + value.increment : value;
          }
          return { stats: { updated: matches.length } };
        },
        async set({ data }) { state.calls.push([name, 'set']); failure('set'); state.rows.set(name, [{ _id: filter._id, ...structuredClone(data) }]); },
        doc(id) {
          filter = { _id: id };
          return { update: ref.update, set: ref.set, async get() {
            state.calls.push([name, 'get']); failure('get');
            if (!rows().length) throw new Error(`document with _id ${id} does not exist`);
            return { data: structuredClone(rows()[0]) };
          } };
        }
      };
      return ref;
    }
  };
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'mock-env', init() {}, database: () => db,
    getWXContext: () => ({ OPENID: state.openid, ENV: 'mock-env' }),
    async getTempFileURL({ fileList }) {
      state.calls.push(['storage', 'sign', structuredClone(fileList)]);
      if (state.signingFailure) throw new Error('private signed url https://secret.invalid/?token=SECRET');
      return { fileList: fileList.map(item => ({ fileID: item.fileID, status: state.signingItemFailure ? -503003 : 0,
        tempFileURL: state.badURL ? 'http://unsafe.invalid/' : 'https://signed.invalid/photo?token=SECRET', maxAge: state.signingMaxAge })) };
    },
    async deleteFile({ fileList }) { state.deleted.push(...fileList); },
    async downloadFile() { return { fileContent: Buffer.from([255, 216, 255, 0]) }; }
  };
  const context = { exports: {}, Buffer, process: { env: { SUPER_ADMIN_HASH: 'mock-hash' } },
    console: { warn: (...args) => state.logs.push(args), error: (...args) => state.logs.push(args), log() {} },
    require(module) {
      if (module === 'wx-server-sdk') return cloud;
      if (module === 'bcryptjs') return { compareSync: (_, hash) => state.correctCode === 'admin' ? hash === 'mock-admin-hash' : state.correctCode };
      if (module === './dataScope') return require(path.join(root, 'cloudfunctions', name, 'dataScope.js'));
      return require(module);
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'cloudfunctions', name, 'index.js'), 'utf8'), context);
  return { state, main: context.exports.main };
}

async function imageChecks(name) {
  const f = fixture(name), { state, main } = f;
  const folder = name === 'manageEasterEggs' ? 'easter-eggs' : 'help';
  const file = `cloud://mock-env.bucket/${folder}/123-example.jpg`;
  const hidden = `cloud://mock-env.bucket/${folder}/124-hidden.jpg`;
  const testFile = `cloud://mock-env.bucket/test/${folder}/125-test.jpg`;
  if (folder === 'help') {
    state.rows.set('help_articles', [{ _id: 'public', is_published: true, images: [file], title: '标题', content: '正文' },
      { _id: 'draft', is_published: false, images: [hidden] }]);
    state.rows.set('test_help_articles', [{ _id: 'test', is_published: true, images: [testFile] }]);
  } else {
    state.rows.set('configs', [{ _id: 'easter_eggs_v1', revision: 17,
      entries: [{ id: 'enabled', fileID: file, enabled: true }, { id: 'hidden', fileID: hidden, enabled: false }] }]);
    state.rows.set('test_configs', [{ _id: 'easter_eggs_v1', revision: 1,
      entries: [{ id: 'test', fileID: testFile, enabled: true }] }]);
  }
  const legacy = await main({ action: 'listPublished' });
  const legacyFile = folder === 'help' ? legacy.data[0].images[0] : legacy.data.entries[0].fileID;
  check(legacyFile, file, '旧版fileID不变');
  check(JSON.stringify(legacy).includes('signed.invalid'), false, '旧版响应没有新增短时链接');
  for (const role of ['user', 'admin', 'superadmin']) {
    state.role = role;
    const result = await main({ action: 'getImageAccess', fileIDs: [file, file], role: 'forged' });
    check(result.success, true, '三类真实身份均可读取已公开图片');
    check(result.data.files.length, 1, '请求去重');
    check(result.data.files[0].fileID, file, '地址单独返回，不修改文件身份');
    check(result.data.files[0].maxAge, 600, '短时链接TTL');
    assert.ok(result.data.files[0].expiresAt > Date.now()); checks++;
  }
  state.role = 'user';
  for (const fileIDs of [[hidden], [file, hidden], [testFile], [`cloud://another-env.bucket/${folder}/123-example.jpg`],
    [`cloud://mock-env.bucket/unrelated/${folder}/123-example.jpg`], [`cloud://mock-env.bucket/${folder}/../123-example.jpg`], [], Array(11).fill(file), ['https://signed.invalid/']]) {
    const before = state.calls.filter(row => row[1] === 'sign').length;
    check((await main({ action: 'getImageAccess', fileIDs, role: 'superadmin' })).success, false, '禁止签发未公开/跨域/非法请求');
    check(state.calls.filter(row => row[1] === 'sign').length, before, '拒绝发生在存储调用前');
  }
  check((await main({ action: 'getImageAccess', fileIDs: [testFile], _testMode: true })).success, false, '普通用户测试域拒绝');
  state.role = 'superadmin';
  check((await main({ action: 'getImageAccess', fileIDs: [testFile], _testMode: true })).success, true, '超管读取正确测试域');
  state.openid = '';
  check((await main({ action: 'getImageAccess', fileIDs: [file] })).code, 'UNAUTHENTICATED', '缺少实际身份拒绝');
  state.openid = 'mock-user';
  state.signingFailure = true;
  check((await main({ action: 'getImageAccess', fileIDs: [file] })).code, 'BACKEND_UNAVAILABLE', '签发故障明确失败');
  await main({ action: 'getImageAccess', fileIDs: [file] });
  check((state.rows.get('system_events') || []).length, 1, '同一温实例重复错误节流');
  check(JSON.stringify(state.logs).includes('SECRET'), false, '原始异常中的签名不入日志');
  check(JSON.stringify(state.rows.get('system_events')).includes('SECRET'), false, '事件不含签名');
  state.signingFailure = false; state.signingItemFailure = true;
  check((await main({ action: 'getImageAccess', fileIDs: [file] })).success, false, '逐文件错误不伪装成成功');
  state.signingItemFailure = false; state.signingMaxAge = 7200;
  check((await main({ action: 'getImageAccess', fileIDs: [file] })).success, false, 'TTL不符合约定时不返回链接');
  state.signingMaxAge = 600; state.badURL = true;
  check((await main({ action: 'getImageAccess', fileIDs: [file] })).success, false, '不返回不安全网址');
  state.badURL = false; state.signingMaxAge = undefined;
  const noEcho = await main({ action: 'getImageAccess', fileIDs: [file] });
  check(noEcho.success, true, '兼容成功响应不回传TTL');
  check(noEcho.data.files[0].maxAge, 600, 'TTL取本次实际请求的固定600秒');
  check(state.calls.filter(row => row[1] === 'sign').at(-1)[2][0].maxAge, 600, 'TTL仍由服务端传给平台，不接受客户端控制');
  if (folder === 'help') {
    state.badURL = false;
    await main({ action: 'deleteFiles', fileIDs: [file, hidden] });
    check(state.deleted.length, 0, '公开/草稿共享引用均受保护');
    const unused = `cloud://mock-env.bucket/help/unused.jpg`;
    await main({ action: 'deleteFiles', fileIDs: [unused] });
    check(state.deleted[0], unused, '未引用文件可以清理');
  }
}

async function cleanupChecks() {
  const { state, main } = fixture('testTool', { role: 'superadmin' });
  for (const action of ['clearWeek', 'clearSubscriptions', 'clearAll']) {
    check((await main({ action, _testMode: false })).blocked, true, '所有正式测试清理拒绝');
  }
  for (const scope of ['week', 'subscriptions', 'all']) {
    check((await main({ action: 'previewCleanup', scope, _testMode: false })).blocked, true, '正式清理预览不得写令牌');
  }
  check(state.calls.some(row => ['set', 'add', 'update'].includes(row[1])), false, '正式拒绝路径无写入');
  check((await main({ action: 'clearSubscriptions', _testMode: true })).blocked === true, false, '测试域仍进入二次确认流程');
  const preview = await main({ action: 'previewCleanup', scope: 'subscriptions', _testMode: true });
  check(preview.success, true, '测试订阅预览正常');
  check(state.rows.has('configs'), false, '测试令牌不写正式configs');
  check(state.rows.has('test_configs'), true, '测试令牌写正确数据域');
  const stat = await main({ action: 'stats', _testMode: false });
  check(stat.success, true, '旧统计接口正常');
  check(stat.data.thisWeek.submitCount, 0, '新周次数准备字段');
  check('submission_counters' in stat.data.total, true, '旧计数器文档数字段保留');
  state.rows.set('submission_counters', [{ _id: stat.data.weekKey, count: 42 }]);
  check((await main({ action: 'stats' })).data.thisWeek.submitCount, 42, '计数使用count而非文档数');
  state.errors.set('submission_counters.get', new Error('network failure'));
  check((await main({ action: 'stats' })).success, false, '统计错误不伪装为0');
}

async function counterChecks() {
  const { state, main } = fixture('getUserInfo');
  const event = { action: 'getSubmitCount', weekKey: '2026-10-11' };
  check((await main(event)).data, 0, '无记录正常0');
  state.rows.set('submission_counters', [{ _id: event.weekKey, count: 44 }]);
  check((await main(event)).data, 44, '旧计数返回格式不变');
  state.errors.set('submission_counters.get', new Error('network failed secret=open-id'));
  check((await main(event)).code, 'BACKEND_UNAVAILABLE', '查询失败不是0');
  check(JSON.stringify(state.logs).includes('open-id'), false, '日志脱敏');
  state.errors.clear(); state.rows.get('submission_counters')[0].count = '44';
  check((await main(event)).success, false, '无效计数不伪装为成功');
}

async function authChecks() {
  const event = { action: 'verify', adminCode: 'do-not-log-code' };
  let f = fixture('verifyAdmin'); f.state.correctCode = true;
  check((await f.main(event)).role, 'superadmin', '正常首次认证兼容');
  f = fixture('verifyAdmin'); f.state.correctCode = 'admin';
  f.state.rows.set('admin_passcodes', [{ code_hash: 'mock-admin-hash', label: '普通管理员' }]);
  check((await f.main(event)).role, 'admin', '普通管理员通行码兼容');
  f = fixture('verifyAdmin');
  check((await f.main(event)).success, false, '错误通行码拒绝');
  check(f.state.rows.get('login_attempts')[0].fail_count, 1, '首次错误创建计数');
  f.state.duplicateCreation = true; f.state.rows.clear();
  await f.main(event);
  check(f.state.rows.get('login_attempts')[0].fail_count, 2, '并发创建碰撞后原子递增');
  for (const kind of ['get', 'update', 'add']) {
    f = fixture('verifyAdmin');
    f.state.correctCode = kind !== 'add';
    f.state.errors.set(`login_attempts.${kind}`, new Error('db failed https://secret.invalid/?adminCode=SECRET'));
    const result = await f.main(event);
    check(result.success, false, '认证存储故障阻断');
    check(result.code, 'AUTH_STORAGE_UNAVAILABLE', '故障不冒充通行码错误');
    check(f.state.calls.some(row => row[0] === 'users' && ['update', 'add'].includes(row[1])), false, '故障不赋权');
    check(JSON.stringify(f.state.logs).includes('SECRET'), false, '错误日志无原始私密信息');
  }
  f = fixture('verifyAdmin');
  f.state.rows.set('login_attempts', [{ _id: 'mock-user', fail_count: 4, locked_until: null }]);
  const fifth = await f.main(event);
  check(fifth.success, false, '第五次失败拒绝');
  check(f.state.rows.get('login_attempts')[0].fail_count, 5, '计数到五');
  assert.ok(Number.isFinite(new Date(f.state.rows.get('login_attempts')[0].locked_until).getTime())); checks++;
  f.state.correctCode = true;
  check((await f.main(event)).success, false, '锁定中正确码也拒绝');
  f.state.rows.get('login_attempts')[0].locked_until = new Date(Date.now() - 1000);
  check((await f.main(event)).success, true, '到期后正常恢复');
  f = fixture('verifyAdmin'); f.state.correctCode = true;
  f.state.rows.set('login_attempts', [{ _id: 'mock-user', fail_count: 5, locked_until: null }]);
  check((await f.main(event)).success, false, '锁定写失败后的阈值记录不能绕过');
  f = fixture('verifyAdmin', { openid: '' }); f.state.correctCode = true;
  check((await f.main(event)).code, 'UNAUTHENTICATED', '不接受伪造客户端身份');
  check(f.state.calls.length, 0, '无身份不访问数据库');
}

async function helpImageLimitChecks() {
  const { state, main } = fixture('manageHelpContent', { role: 'superadmin' });
  const images = Array.from({ length: 10 }, (_, i) => `cloud://mock-env.bucket/help/image-${i}.jpg`);
  const event = { action: 'save', title: '多图说明', content: '完整正文', images, newImageIDs: images, isPublished: false };
  const saved = await main(event);
  check(saved.success, true, '允许十张图片保存草稿并校验新图');
  assert.deepEqual(state.rows.get('help_articles')[0].images, images); checks++;
  const rejected = await main({ ...event, images: [...images, 'cloud://mock-env.bucket/help/extra.jpg'] });
  check(rejected.success, false, '服务端拒绝第十一张');
  check(rejected.message, '每条说明最多添加10张图片', '超限说明明确');
  check(state.rows.get('help_articles').length, 1, '超限请求不写入新条目');
  const unauthorized = fixture('manageHelpContent');
  check((await unauthorized.main(event)).code, 'FORBIDDEN', '扩容不放宽超管写权限');
}

(async () => {
  await imageChecks('manageEasterEggs'); await imageChecks('manageHelpContent');
  await helpImageLimitChecks();
  await cleanupChecks(); await counterChecks(); await authChecks();
  console.log(`PASS: ${checks} backend hotfix assertions; legacy contracts, published-only signed access, roles/scopes, safe logs, cleanup guards, counters and auth failure handling`);
})().catch(error => { console.error(error); process.exitCode = 1; });
