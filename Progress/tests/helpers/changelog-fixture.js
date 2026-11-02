const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'../../..');
function fixture(name, options = {}) {
  const state = {
    role: options.role || 'user', openid: options.openid === undefined ? 'mock-user' : options.openid,
    rows: new Map(), calls: [], logs: [], deleted: [], errors: new Map(),
    signingFailure: false, signingItemFailure: false, signingMaxAge: 600, badURL: false,
    correctCode: false, duplicateCreation: false
  };
  const command = { inc: value => ({ increment: value }), in: value => ({ in: value }), neq: value => ({ neq: value }) };
  const db = {
    command,async startTransaction(){return {collection:db.collection,async commit(){},async rollback(){}};}, serverDate: () => new Date(),
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
        async remove(){const kept=(state.rows.get(name)||[]).filter(row=>!Object.entries(filter).every(([key,value])=>row[key]===value));state.rows.set(name,kept);return {stats:{removed:1}};},
        async set({ data }) { state.calls.push([name, 'set']); failure('set'); state.rows.set(name, [{ _id: filter._id, ...structuredClone(data) }]); },
        doc(id) {
          filter = { _id: id };
          return { update: ref.update, set: ref.set, remove:ref.remove, async get() {
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
    DYNAMIC_CURRENT_ENV: 'mock-env', init() {}, database: () => db,openapi:{security:{async msgSecCheck(){return {result:{suggest:state.safetyReject?'risky':'pass'}};}}},
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
module.exports={fixture};
