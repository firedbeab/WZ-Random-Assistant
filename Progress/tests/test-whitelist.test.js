const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const FUNCTIONS = [
  'testTool', 'verifyAdmin', 'getUserInfo', 'manageHelpContent', 'manageAdmins', 'manageWeeklyCode',
  'checkWeeklyCode', 'drawWeeklyPlaylist', 'adminAuditPlaylist', 'manageEasterEggs', 'superAdminConsole'
];
let checks = 0;
function check(actual, expected, label) { assert.equal(actual, expected, label); checks++; }

// ===== 可控时钟 + 独立 dataScope 模块实例（每个用例不共享 60 秒缓存） =====
function loadDataScope(name, clock = { now: 1000000 }) {
  const file = path.join(root, 'cloudfunctions', name, 'dataScope.js');
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    console,
    Date: { now: () => clock.now }
  });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { scope: module.exports, clock };
}

// ===== 只服务于 dataScope 的最小 mock db =====
function allowlistDb(options = {}) {
  const state = {
    collections: [],
    gets: [],
    userReads: 0,
    allowlistReads: 0,
    role: options.role || 'user',
    openid: options.openid || 'reader',
    doc: 'doc' in options ? options.doc : { _id: 'test_accounts_v1', openids: options.allowlist || [] },
    readError: options.readError || null,
    lastQuery: null
  };
  const db = {
    collection(name) {
      state.collections.push(name);
      let query = {};
      const ref = {
        where(value) { query = value; state.lastQuery = value; return ref; },
        limit() { return ref; },
        async get() {
          state.gets.push(name);
          if (name === 'users') {
            state.userReads++;
            return { data: state.role ? [{ openid: state.openid, role: state.role }] : [] };
          }
          if (name === 'test_configs') {
            state.allowlistReads++;
            if (state.readError) throw state.readError;
            return { data: state.doc ? [state.doc] : [] };
          }
          return { data: [] };
        }
      };
      return ref;
    }
  };
  return { state, db };
}

// ===== 112 个云函数入口共用的 mock：db / cloud / 加载器 =====
function newState(openid) {
  return { openid, rows: new Map(), errors: new Map(), collections: [], gets: [], writes: [], signed: [] };
}

function mockDb(state) {
  return {
    command: { inc: value => ({ increment: value }), in: value => ({ in: value }), neq: value => ({ neq: value }) },
    serverDate: () => new Date(),
    collection(name) {
      state.collections.push(name);
      let filter = {};
      let cap = Infinity;
      const matching = () => (state.rows.get(name) || [])
        .filter(row => Object.entries(filter).every(([key, value]) => row[key] === value))
        .slice(0, cap);
      const ref = {
        where(value) { filter = value; return ref; },
        limit(value) { cap = value; return ref; },
        orderBy() { return ref; },
        field() { return ref; },
        async get() {
          state.gets.push(name);
          if (state.errors.has(`${name}.get`)) throw state.errors.get(`${name}.get`);
          return { data: structuredClone(matching()) };
        },
        async count() {
          state.gets.push(`${name}.count`);
          if (state.errors.has(`${name}.count`)) throw state.errors.get(`${name}.count`);
          return { total: matching().length };
        },
        async add({ data }) {
          state.writes.push({ op: 'add', name, data: structuredClone(data) });
          const list = state.rows.get(name) || [];
          const stored = { _id: data._id || `id-${name}-${list.length}`, ...structuredClone(data) };
          list.push(stored);
          state.rows.set(name, list);
          return { _id: stored._id };
        },
        async update({ data }) {
          state.writes.push({ op: 'update', name, data: structuredClone(data) });
          const matches = matching();
          for (const row of matches) Object.assign(row, structuredClone(data));
          return { stats: { updated: matches.length } };
        },
        async set({ data }) {
          state.writes.push({ op: 'set', name, data: structuredClone(data) });
          state.rows.set(name, [{ _id: filter._id, ...structuredClone(data) }]);
        },
        doc(id) {
          return {
            async get() {
              state.gets.push(`${name}.doc`);
              if (state.errors.has(`${name}.doc.get`)) throw state.errors.get(`${name}.doc.get`);
              const row = (state.rows.get(name) || []).find(item => item._id === id);
              if (!row) throw new Error(`document ${id} does not exist`);
              return { data: structuredClone(row) };
            },
            async update({ data }) {
              state.writes.push({ op: 'update', name, data: structuredClone(data) });
              const row = (state.rows.get(name) || []).find(item => item._id === id);
              if (row) Object.assign(row, structuredClone(data));
              return { stats: { updated: row ? 1 : 0 } };
            },
            async set({ data }) {
              state.writes.push({ op: 'set', name, data: structuredClone(data) });
              const list = state.rows.get(name) || [];
              const index = list.findIndex(item => item._id === id);
              if (index >= 0) list[index] = { _id: id, ...structuredClone(data) };
              else list.push({ _id: id, ...structuredClone(data) });
              state.rows.set(name, list);
            }
          };
        }
      };
      return ref;
    }
  };
}

function mockCloud(state, db) {
  return {
    DYNAMIC_CURRENT_ENV: 'mock-env',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: state.openid, ENV: 'mock-env' }),
    async getTempFileURL({ fileList }) {
      state.signed.push(...fileList.map(item => item.fileID));
      return {
        fileList: fileList.map(item => ({
          fileID: item.fileID,
          status: 0,
          tempFileURL: `https://signed.invalid/${encodeURIComponent(item.fileID)}`,
          maxAge: 600
        }))
      };
    },
    async downloadFile() { return { fileContent: Buffer.from([255, 216, 255, 0]) }; },
    async uploadFile() { return { fileID: 'cloud://mock-env.bucket/help/upload.jpg' }; },
    async deleteFile() {},
    openapi: { security: { msgSecCheck: async () => ({ result: { suggest: 'pass' } }) } }
  };
}

function loadIndex(name, cloud) {
  const scopeFile = path.join(root, 'cloudfunctions', name, 'dataScope.js');
  delete require.cache[require.resolve(scopeFile)];
  const scopeModule = require(scopeFile);
  const indexFile = path.join(root, 'cloudfunctions', name, 'index.js');
  const module = { exports: {} };
  const context = vm.createContext({
    module,
    exports: module.exports,
    Buffer,
    process,
    console: { warn() {}, error() {}, log() {} },
    require(moduleName) {
      if (moduleName === 'wx-server-sdk') return cloud;
      if (moduleName === './dataScope') return scopeModule;
      // 本测试只验证角色拒绝，不执行通行码哈希逻辑；避免依赖云函数目录内的 node_modules。
      if (moduleName === 'bcryptjs') {
        return { compareSync: () => false, hashSync: () => 'mock-hash', genSaltSync: () => 'mock-salt' };
      }
      return require(moduleName);
    }
  });
  vm.runInContext(fs.readFileSync(indexFile, 'utf8'), context, { filename: indexFile });
  return module.exports.main;
}

// ===== A. 11 份 dataScope：正式域不变、测试域三类身份与固定白名单集合 =====
async function dataScopeChecks() {
  for (const name of FUNCTIONS) {
    const { scope } = loadDataScope(name);
    check(typeof scope.isAllowlistedTestAccount, 'function', `${name}: 导出 isAllowlistedTestAccount`);
    check(typeof scope.canUseTestData, 'function', `${name}: 导出 canUseTestData`);
    check(typeof scope.isProductionSuperadmin, 'function', `${name}: 导出 isProductionSuperadmin`);
    check(typeof scope.createDataScope, 'function', `${name}: 导出 createDataScope`);
    if (name !== 'manageEasterEggs' && name !== 'superAdminConsole') {
      check(scope.TEST_PREFIX, 'test_', `${name}: 保留 TEST_PREFIX 导出`);
    }

    check(scope.createDataScope({ _testMode: true }).testMode, true, `${name}: 测试域识别`);
    check(scope.createDataScope({ _testMode: true }).collection('users'), 'test_users', `${name}: 测试集合前缀`);
    check(scope.createDataScope({}).collection('users'), 'users', `${name}: 正式集合不变`);

    const prod = allowlistDb({ role: 'superadmin', allowlist: ['white-user'] });
    check(await scope.canUseTestData(prod.db, '', { testMode: false }), true, `${name}: 正式域无身份也放行（与改前一致）`);
    check(await scope.canUseTestData(prod.db, 'any-user', { testMode: false }), true, `${name}: 正式域任意普通身份放行`);
    check(prod.state.collections.length, 0, `${name}: 正式域不访问数据库`);

    const superDb = allowlistDb({ role: 'superadmin' });
    check(await scope.canUseTestData(superDb.db, 'prod-superadmin', { testMode: true }), true, `${name}: 测试域放行正式超管`);
    check(superDb.state.allowlistReads, 0, `${name}: 超管不读取白名单`);

    const whiteDb = allowlistDb({ role: 'user', allowlist: ['white-user'] });
    check(await scope.canUseTestData(whiteDb.db, 'white-user', { testMode: true }), true, `${name}: 测试域放行白名单普通账号`);
    check(whiteDb.state.allowlistReads, 1, `${name}: 白名单判定只读一次文档`);
    check(whiteDb.state.lastQuery && whiteDb.state.lastQuery._id, 'test_accounts_v1', `${name}: 固定文档 _id`);
    check(whiteDb.state.collections.includes('test_configs'), true, `${name}: 固定读取 test_configs`);
    check(whiteDb.state.collections.includes('configs'), false, `${name}: 不读取正式域 configs`);

    const otherDb = allowlistDb({ role: 'user', allowlist: ['white-user'] });
    check(await scope.canUseTestData(otherDb.db, 'other-user', { testMode: true }), false, `${name}: 测试域拒绝非白名单普通账号`);

    const anonDb = allowlistDb({ role: 'user', allowlist: ['white-user'] });
    check(await scope.canUseTestData(anonDb.db, '', { testMode: true }), false, `${name}: 测试域拒绝无身份调用`);
    check(anonDb.state.allowlistReads, 0, `${name}: 无身份不读取白名单`);
  }
}

// ===== B. 白名单读取语义：缺失/抛错/非数组保守拒绝，60 秒缓存 =====
async function allowlistChecks() {
  {
    const { scope } = loadDataScope('getUserInfo');
    const { state, db } = allowlistDb({ role: 'user', doc: null });
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), false, '白名单文档缺失保守拒绝');
    check(state.allowlistReads, 1, '文档缺失仍尝试读取一次');
  }
  {
    const { scope } = loadDataScope('getUserInfo');
    const { state, db } = allowlistDb({ readError: new Error('collection not found') });
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), false, '白名单读取抛错保守拒绝');
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), false, '读取抛错后再次调用仍拒绝');
    check(state.allowlistReads, 2, '失败结果不被缓存，第二次重新读取');
    state.readError = null;
    state.doc = { _id: 'test_accounts_v1', openids: ['white-user'] };
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), true, '读取恢复后重新读取并命中');
    check(state.allowlistReads, 3, '恢复后确实重新读取');
  }
  const badDocs = [
    [{ _id: 'test_accounts_v1', openids: 'white-user' }, 'openids 为字符串'],
    [{ _id: 'test_accounts_v1', openids: null }, 'openids 为 null'],
    [{ _id: 'test_accounts_v1', openids: {} }, 'openids 为对象'],
    [{ _id: 'test_accounts_v1' }, '缺少 openids 字段']
  ];
  for (const [doc, label] of badDocs) {
    const { scope } = loadDataScope('getUserInfo');
    const { db } = allowlistDb({ role: 'user', doc });
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), false, `${label}时保守拒绝`);
  }
  {
    const { scope } = loadDataScope('getUserInfo');
    const { db } = allowlistDb({
      role: 'user',
      doc: { _id: 'test_accounts_v1', openids: ['white-user', 123, '', null, undefined, { x: 1 }] }
    });
    check(await scope.canUseTestData(db, 'white-user', { testMode: true }), true, '非字符串/空 openid 条目被过滤');
  }
  {
    const clock = { now: 5000000 };
    const { scope } = loadDataScope('getUserInfo', clock);
    const { state, db } = allowlistDb({ role: 'user', allowlist: ['white-user'] });
    check(await scope.isAllowlistedTestAccount(db, 'white-user'), true, '首次命中白名单');
    check(state.allowlistReads, 1, '首次读取白名单文档');
    state.doc = { _id: 'test_accounts_v1', openids: [] };
    clock.now += 59999;
    check(await scope.isAllowlistedTestAccount(db, 'white-user'), true, '60 秒内命中缓存');
    check(state.allowlistReads, 1, '缓存命中不重新读取');
    clock.now += 1;
    check(await scope.isAllowlistedTestAccount(db, 'white-user'), false, '60 秒后重新读取新文档');
    check(state.allowlistReads, 2, '缓存过期后重新读取');
  }
  {
    const clock = { now: 6000000 };
    const { scope } = loadDataScope('testTool', clock);
    const { state, db } = allowlistDb({ role: 'user', allowlist: ['a-user', 'b-user'] });
    check(await scope.isAllowlistedTestAccount(db, 'a-user'), true, '白名单账号 A 命中');
    check(await scope.isAllowlistedTestAccount(db, 'b-user'), true, '同一文档内白名单账号 B 命中');
    check(await scope.isAllowlistedTestAccount(db, 'c-user'), false, '同一文档内非白名单账号拒绝');
    check(state.allowlistReads, 1, '一次读取服务多个账号');
  }
}

// ===== C. getUserInfo：白名单普通账号只以 user 建档，只读路径不写库 =====
function userInfoState(openid, options = {}) {
  const state = newState(openid);
  state.rows.set('users', options.prodRole === null ? [] : [{ openid, role: options.prodRole || 'user' }]);
  state.rows.set('test_users', options.testUserRow ? [options.testUserRow] : []);
  state.rows.set('test_configs', [
    { _id: 'test_accounts_v1', openids: options.allowlist || [openid] },
    { _id: 'channel_override', forceOpen: true, forceClose: false }
  ]);
  state.rows.set('test_submissions', options.testSubmissions || []);
  return state;
}

async function userInfoChecks() {
  {
    const state = userInfoState('white-user');
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ _testMode: true });
    check(result.success, true, '白名单普通账号可取测试域本人资料');
    check(result.data.role, 'user', '白名单账号只能以普通用户身份');
    check(result.data.data_scope, 'test', '新建档标记测试数据域');
    check(result.message, '新用户创建成功', '复用现有首次访问建档逻辑');
    const adds = state.writes.filter(write => write.op === 'add' && write.name === 'test_users');
    check(adds.length, 1, '只在 test_users 建档一次');
    check(adds[0].data.role, 'user', '建档角色固定 user');
    check(state.writes.some(write => write.data && ['admin', 'superadmin'].includes(write.data.role)), false, '绝不写管理角色');
    check(result.data.channelForceOpen, true, '通道状态读取不受白名单影响');

    const again = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ _testMode: true });
    check(again.success, true, '白名单账号再次访问正常');
    check(state.writes.filter(write => write.op === 'add').length, 1, '重复访问不重复建档');
  }
  {
    const state = userInfoState('white-user', {
      testSubmissions: [{ _id: 's1', user_id: 'white-user', song_name: '晴天', singer: '周杰伦', submit_time: 2, status: 'pending' }]
    });
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ action: 'getLatestSubmission', _testMode: true });
    check(result.success, true, '白名单账号测试域只读查询放行');
    check(result.data.song_name, '晴天', '只读查询返回本人最近投稿');
    check(state.writes.length, 0, '只读路径不建档、不写库');
  }
  {
    const state = userInfoState('normal-user', { allowlist: ['white-user'] });
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ _testMode: true });
    check(result.success, false, '非白名单普通账号测试域仍拒绝');
    check(result.code, 'TEST_ACCESS_DENIED', '拒绝码保持 TEST_ACCESS_DENIED');
    check(state.writes.length, 0, '拒绝路径无写入');
    check(state.gets.includes('test_users'), false, '拒绝发生在测试域资料查询前');
  }
  {
    const state = userInfoState('white-user', {
      testUserRow: { _id: 'tu1', openid: 'white-user', role: 'user', points: 7 }
    });
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ _testMode: true });
    check(result.success, true, '白名单账号既有测试资料正常返回');
    check(result.data.role, 'user', '既有资料角色不被提升');
    check(result.data.points, 7, '既有资料原样返回');
    check(state.writes.length, 0, '既有记录不被覆盖');
  }
  {
    const state = userInfoState('prod-superadmin', { prodRole: 'superadmin', allowlist: [] });
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({ _testMode: true });
    check(result.success, true, '正式超管仍可进入测试域');
    check(result.data.role, 'superadmin', '正式超管测试域建档保持原有行为');
  }
  {
    const state = newState('normal-user');
    state.rows.set('users', [{ openid: 'normal-user', role: 'user' }]);
    state.rows.set('test_configs', [{ _id: 'test_accounts_v1', openids: [] }]);
    const result = await loadIndex('getUserInfo', mockCloud(state, mockDb(state)))({});
    check(result.success, true, '正式域普通用户行为不变');
    check(result.data.role, 'user', '正式域普通用户角色不变');
    check(state.collections.includes('test_configs') || state.collections.includes('test_users'), false, '正式域不访问测试集合');
  }
}

// ===== D. 管理动作：白名单普通账号仍被独立角色校验拒绝 =====
function whitelistAdminState(openid = 'white-user') {
  const state = newState(openid);
  state.rows.set('users', [{ openid, role: 'user' }]);
  state.rows.set('test_users', [{ _id: 'tu', openid, role: 'user' }]);
  state.rows.set('test_configs', [{ _id: 'test_accounts_v1', openids: [openid] }]);
  return state;
}

async function runWhitelisted(name, event) {
  const state = whitelistAdminState();
  const main = loadIndex(name, mockCloud(state, mockDb(state)));
  const result = await main({ ...event, _testMode: true });
  return { state, result };
}

async function managementChecks() {
  {
    const { state, result } = await runWhitelisted('adminAuditPlaylist', { action: 'getPending' });
    check(result.success, false, '白名单普通账号不能审核排期');
    check(result.message, '无权限访问', '审核拒绝来自独立角色校验而非测试域闸门');
    check(state.gets.includes('test_users'), true, '审核角色校验读取测试域 users');
    check(state.gets.includes('test_schedules'), false, '角色拒绝发生在排期读取前');
    check(state.writes.length, 0, '审核拒绝无写入');
  }
  {
    const { state, result } = await runWhitelisted('testTool', { action: 'stats' });
    check(result.success, false, '白名单普通账号不能使用测试工具');
    check(result.message, '无权限访问', '测试工具拒绝来自独立超管校验');
    check(state.gets.includes('test_users'), true, '测试工具角色校验读取测试域 users');
    check(state.gets.some(name => ['test_submissions', 'test_schedules'].includes(name)), false, '角色拒绝发生在业务读取前');
    check(state.writes.length, 0, '测试工具拒绝无写入');
  }
  {
    const { state, result } = await runWhitelisted('manageAdmins', { action: 'listPasscodes' });
    check(result.success, false, '白名单普通账号不能管理管理员');
    check(result.message, '无权限访问', '管理员管理拒绝来自独立超管校验');
    check(state.gets.includes('test_users'), true, '管理员管理角色校验读取测试域 users');
    check(state.gets.includes('test_admin_passcodes'), false, '角色拒绝发生在通行码读取前');
    check(state.writes.length, 0, '管理员管理拒绝无写入');
  }
  {
    const { state, result } = await runWhitelisted('superAdminConsole', { action: 'stats' });
    check(result.success, false, '白名单普通账号不能进入超管控制台');
    check(result.message, '仅超级管理员可访问', '超管控制台拒绝来自独立正式超管校验');
    check(state.gets.includes('users'), true, '超管控制台校验正式 users 角色');
    check(state.collections.includes('test_configs'), false, '超管校验失败发生在测试域白名单读取之前');
    check(state.writes.length, 0, '超管控制台拒绝无写入');
  }
  {
    const { state, result } = await runWhitelisted('manageHelpContent', { action: 'listAll' });
    check(result.success, false, '白名单普通账号不能管理说明');
    check(result.code, 'FORBIDDEN', '说明管理拒绝来自独立超管校验');
    check(state.writes.length, 0, '说明管理拒绝无写入');
  }
  {
    const { state, result } = await runWhitelisted('manageEasterEggs', { action: 'listAll' });
    check(result.success, false, '白名单普通账号不能维护彩蛋');
    check(result.code, 'FORBIDDEN', '彩蛋维护拒绝来自独立正式超管校验');
    check(state.writes.length, 0, '彩蛋维护拒绝无写入');
  }
  {
    const state = newState('normal-user');
    state.rows.set('users', [{ openid: 'normal-user', role: 'user' }]);
    state.rows.set('test_users', [{ _id: 'tu', openid: 'normal-user', role: 'user' }]);
    const result = await loadIndex('adminAuditPlaylist', mockCloud(state, mockDb(state)))({ action: 'getPending' });
    check(result.success, false, '正式域普通账号仍不能审核排期');
    check(result.message, '无权限访问', '正式域审核拒绝行为不变');
  }
}

// ===== E. getImageAccess：白名单账号在测试域可签发公开引用，其余校验不放松 =====
async function imageAccessChecks() {
  {
    const state = newState('white-user');
    state.rows.set('users', [{ openid: 'white-user', role: 'user' }]);
    state.rows.set('test_users', [{ _id: 'tu', openid: 'white-user', role: 'user' }]);
    state.rows.set('test_configs', [{ _id: 'test_accounts_v1', openids: ['white-user'] }]);
    const published = 'cloud://mock-env.bucket/test/help/published.jpg';
    const draft = 'cloud://mock-env.bucket/test/help/draft.jpg';
    state.rows.set('test_help_articles', [
      { _id: 'pub', is_published: true, images: [published], title: '标题', summary: '', content: '', sort_order: 1 },
      { _id: 'draft', is_published: false, images: [draft], sort_order: 2 }
    ]);
    const main = loadIndex('manageHelpContent', mockCloud(state, mockDb(state)));
    const granted = await main({ action: 'getImageAccess', fileIDs: [published], _testMode: true });
    check(granted.success, true, '白名单普通账号可签发测试域已发布说明图片');
    check(granted.data.files[0].fileID, published, '返回请求的 fileID');
    check(granted.data.files[0].maxAge, 600, '短时链接仍为 600 秒');
    check(state.signed.includes(published), true, '确实请求了平台签发');

    const before = state.signed.length;
    const deniedDraft = await main({ action: 'getImageAccess', fileIDs: [draft], _testMode: true });
    check(deniedDraft.success, false, '未发布说明图片不签发');
    check(deniedDraft.code, 'IMAGE_NOT_AVAILABLE', '未发布拒绝码不变');
    check(state.signed.length, before, '未发布拒绝发生在签发前');

    const wrongDomain = await main({
      action: 'getImageAccess', fileIDs: ['cloud://mock-env.bucket/help/published.jpg'], _testMode: true
    });
    check(wrongDomain.success, false, '测试域请求不接受正式域路径');
    check(wrongDomain.code, 'INVALID_IMAGE_REQUEST', '锚定路径校验不放松');

    const tooMany = await main({ action: 'getImageAccess', fileIDs: Array(11).fill(published), _testMode: true });
    check(tooMany.success, false, '超过 10 个不签发');
    check(tooMany.code, 'INVALID_IMAGE_REQUEST', '数量校验不放松');

    const manage = await main({ action: 'listAll', _testMode: true });
    check(manage.success, false, '白名单账号不能管理说明内容');
    check(manage.code, 'FORBIDDEN', '说明管理仍只认超管');

    state.openid = 'other-user';
    const denied = await main({ action: 'getImageAccess', fileIDs: [published], _testMode: true });
    check(denied.success, false, '非白名单普通账号测试域仍拒绝');
    check(denied.code, 'TEST_ACCESS_DENIED', '测试域拒绝码不变');
  }
  {
    const state = newState('white-user');
    state.rows.set('users', [{ openid: 'white-user', role: 'user' }]);
    state.rows.set('test_users', [{ _id: 'tu', openid: 'white-user', role: 'user' }]);
    const enabled = 'cloud://mock-env.bucket/test/easter-eggs/enabled.jpg';
    const disabled = 'cloud://mock-env.bucket/test/easter-eggs/disabled.jpg';
    state.rows.set('test_configs', [
      { _id: 'test_accounts_v1', openids: ['white-user'] },
      {
        _id: 'easter_eggs_v1', revision: 2, entries: [
          { id: 'e', fileID: enabled, enabled: true, topText: '', bottomText: '' },
          { id: 'd', fileID: disabled, enabled: false, topText: '', bottomText: '' }
        ]
      }
    ]);
    const main = loadIndex('manageEasterEggs', mockCloud(state, mockDb(state)));
    const granted = await main({ action: 'getImageAccess', fileIDs: [enabled], _testMode: true });
    check(granted.success, true, '白名单普通账号可签发测试域已启用彩蛋图片');
    check(granted.data.files[0].fileID, enabled, '返回请求的彩蛋 fileID');
    check(granted.data.revision, 2, '彩蛋 revision 原样返回');

    const before = state.signed.length;
    const deniedDisabled = await main({ action: 'getImageAccess', fileIDs: [disabled], _testMode: true });
    check(deniedDisabled.success, false, '已停用彩蛋图片不签发');
    check(deniedDisabled.code, 'IMAGE_NOT_AVAILABLE', '停用拒绝码不变');
    check(state.signed.length, before, '停用拒绝发生在签发前');

    const manage = await main({ action: 'listAll', _testMode: true });
    check(manage.success, false, '白名单账号不能维护彩蛋');
    check(manage.code, 'FORBIDDEN', '彩蛋维护仍只认正式超管');

    state.openid = 'other-user';
    const denied = await main({ action: 'getImageAccess', fileIDs: [enabled], _testMode: true });
    check(denied.success, false, '非白名单普通账号测试域仍拒绝');
    check(denied.code, 'TEST_ACCESS_DENIED', '测试域拒绝码不变');
  }
  {
    const state = newState('normal-user');
    state.rows.set('users', [{ openid: 'normal-user', role: 'user' }]);
    const published = 'cloud://mock-env.bucket/help/published.jpg';
    state.rows.set('help_articles', [{ _id: 'pub', is_published: true, images: [published], sort_order: 1 }]);
    const main = loadIndex('manageHelpContent', mockCloud(state, mockDb(state)));
    const result = await main({ action: 'getImageAccess', fileIDs: [published] });
    check(result.success, true, '正式域普通用户签发已发布说明图片行为不变');
  }
}

(async () => {
  await dataScopeChecks();
  await allowlistChecks();
  await userInfoChecks();
  await managementChecks();
  await imageAccessChecks();
  console.log(`PASS: ${checks} test-whitelist assertions; 11 dataScope variants, prod parity, superadmin/allowlisted/ordinary test-domain access, conservative reads and 60s cache, user-only profile creation, management role isolation and signed image access`);
})().catch(error => { console.error(error); process.exitCode = 1; });
