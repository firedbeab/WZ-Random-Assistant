const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../../..');
function fixture(name, seed = {}, options = {}) {
  const state = { rows: structuredClone(seed), version:0, requests:[], logs:[], commits:0, owner:options.owner === undefined ? 'admin' : options.owner,
    source:options.source || 'wx_client', failId:null, failCommit:false, safety:'pass', notifyFail:false };
  const op = (name,value) => ({op:name,value});
  const command = Object.fromEntries(['in','nin','lt','lte','gt','gte','neq','exists'].map(name => [name,value => op(name,value)]));
  command.inc = value => op('inc',value);
  function matches(row,query) { return Object.entries(query || {}).every(([k,v]) => {
    if (!v || !v.op) return row[k] === v;
    return ({in:()=>v.value.includes(row[k]),nin:()=>!v.value.includes(row[k]),lt:()=>row[k]<v.value,lte:()=>row[k]<=v.value,gt:()=>row[k]>v.value,gte:()=>row[k]>=v.value,neq:()=>row[k]!==v.value,exists:()=>Object.hasOwn(row,k)===v.value})[v.op]();
  }); }
  function collection(name, tx = null, query = {}, id = null, skip = 0, limit = 100) {
    const stores = () => tx ? tx.rows : state.rows;
    const rows = () => Object.values(stores()[name] || {}).filter(r => id ? r._id === id : matches(r,query)).slice(skip,skip+limit);
    const track = kind => { state.requests.push({name,kind,id,transaction:!!tx}); if(tx && !id && ['update','count','remove'].includes(kind)) throw Error('Non-transactional query operation used inside transaction'); };
    const write = () => { if (state.failId && id === state.failId) throw Error('Injected document failure'); if(!tx)state.version++; };
    return {
      where: q=>collection(name,tx,q,null,skip,limit), doc:key=>collection(name,tx,{},key,0,1),
      limit:n=>collection(name,tx,query,id,skip,n), skip:n=>collection(name,tx,query,id,n,limit),
      orderBy() { return this; }, field() { return this; },
      async get() { track('get'); const found=structuredClone(rows()); return {data:id ? found[0] || null : found}; },
      async count() { track('count'); return {total:rows().length}; },
      async update({data}) { track('update');write();let updated=0;for(const r of rows()) { for(const [k,v]of Object.entries(data))r[k]=v&&v.op==='inc'?(r[k]||0)+v.value:structuredClone(v);updated++; }return {stats:{updated}}; },
      async set({data}) {track('set');write();const store=stores();store[name] ||= {};store[name][id]={_id:id,...structuredClone(data)};return {stats:{updated:1}};},
      async add({data}) {track('add');write();const store=stores();store[name] ||= {};const key=data._id || 'id'+Object.keys(store[name]).length;if(store[name][key])throw Error('duplicate key');store[name][key]={_id:key,...structuredClone(data)};return {_id:key};},
      async remove() {track('remove');write();let removed=0;for(const row of rows()){delete stores()[name][row._id];removed++;}return {stats:{removed}};}
    };
  }
  const db = {command,serverDate:()=>new Date('2026-11-01T12:00:00Z'),collection:n=>collection(n),async startTransaction(){const tx={rows:structuredClone(state.rows),version:state.version};return {collection:n=>collection(n,tx),async commit(){if(state.failCommit)throw Error('commit failed');if(tx.version!==state.version)throw {code:'DATABASE_TRANSACTION_CONFLICT'};state.rows=tx.rows;state.version++;state.commits++;},async rollback(){}};}};
  const cloud={init(){},database:()=>db,getWXContext:()=>({OPENID:state.owner,SOURCE:state.source}),openapi:{security:{async msgSecCheck(){if(state.safety==='throw')throw {errCode:-604101};return state.safety==='missing'?{}:{result:{suggest:state.safety}};}},subscribeMessage:{async send(){if(state.notifyFail)throw Error('notify failed');return {};}}}};
  const FixedDate=class extends Date{constructor(...a){super(...(a.length?a:['2026-11-01T12:00:00Z']));}static now(){return Date.parse('2026-11-01T12:00:00Z');}};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'cloudfunctions',name,'index.js'),'utf8'),{module,exports:module.exports,Date:FixedDate,Buffer,console:{log:(...x)=>state.logs.push(x),warn:(...x)=>state.logs.push(x)},setTimeout,Math,
    require(key){if(key==='wx-server-sdk')return cloud;if(key==='crypto')return require('node:crypto');if(key.startsWith('./'))return require(path.join(root,'cloudfunctions',name,key));throw Error(key);}});
  return {state,db,main:module.exports.main};
}
module.exports={fixture};
