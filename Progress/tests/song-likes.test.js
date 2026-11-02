const test=require('node:test'),assert=require('node:assert/strict');
const {createService}=require('../../cloudfunctions/manageSongLikes/service');
const model=require('../../cloudfunctions/manageSongLikes/model');
const {createDataScope}=require('../../cloudfunctions/manageSongLikes/dataScope');
const retention=require('../../cloudfunctions/drawWeeklyPlaylist/scheduleRetention');
function fixture(){
 let time=Date.UTC(2026,9,31),offline=false;const rows=new Map(),versions=new Map();
 const condition=fn=>({matches:fn,and(other){return condition(value=>fn(value)&&other.matches(value));}});
 const command={in:xs=>condition(v=>xs.includes(v)),nin:xs=>condition(v=>!xs.includes(v)),neq:x=>condition(v=>v!==x),gte:x=>condition(v=>v>=x),lt:x=>condition(v=>v<x),lte:x=>condition(v=>v<=x)};
 const matches=(r,q)=>Object.entries(q).every(([k,v])=>v&&v.matches?v.matches(r[k]):r[k]===v);
 function ref(name,observed,writes){let where={},orders=[],skip=0,limit=100;const key=id=>name+'/'+id;
  const getrow=k=>{if(offline)throw Error('OFFLINE');if(observed)observed.set(k,versions.get(k)||0);return structuredClone(writes&&writes.get(k)||rows.get(k)||null);};
  const put=(k,v)=>{if(writes)writes.set(k,v);else{rows.set(k,v);versions.set(k,(versions.get(k)||0)+1);}};
  const q={where(v){where=v;return q;},orderBy(f,d){orders.push([f,d]);return q;},skip(v){skip=v;return q;},limit(v){limit=v;return q;},async get(){if(offline)throw Error('OFFLINE');let data=[...rows.entries()].filter(([k,v])=>k.startsWith(name+'/')&&matches(v,where)).map(([,v])=>structuredClone(v));data.sort((a,b)=>{for(const [f,d]of orders){if(a[f]!==b[f])return (a[f]>b[f]?1:-1)*(d==='desc'?-1:1);}return 0;});return {data:data.slice(skip,skip+limit)};},async remove(){const keys=[...rows].filter(([k,v])=>k.startsWith(name+'/')&&matches(v,where)).map(([k])=>k);for(const k of keys)rows.delete(k);return {stats:{removed:keys.length}};},doc(id){const k=key(id);return {async get(){return {data:getrow(k)};},async set({data}){put(k,{...structuredClone(data),_id:id});},async update({data}){const old=getrow(k);if(!old)throw Error('MISSING');for(const [field,value]of Object.entries(data)){const parts=field.split('.');let target=old;for(const p of parts.slice(0,-1))target=target[p]||(target[p]={});target[parts.at(-1)]=value;}put(k,old);}};}};return q;
 }
 const db={command,collection:n=>ref(n),async startTransaction(){const observed=new Map(),writes=new Map();return {collection:n=>ref(n,observed,writes),async rollback(){},async commit(){for(const[k,v]of observed)if((versions.get(k)||0)!==v)throw Object.assign(Error('concurrent database write'),{code:'DATABASE_TRANSACTION_CONFLICT'});for(const[k,v]of writes){rows.set(k,v);versions.set(k,(versions.get(k)||0)+1);}}};}};
 const seed=(name,id,data)=>rows.set(name+'/'+id,{...data,_id:id});
 seed('schedules','schedule',{week_key:'2026-10-25',status:'published',revision:5,day1:[{submission_id:'a',song_name:'稻香',singer:'周杰伦'},{submission_id:'b',song_name:'海阔天空',singer:'Beyond'}]});
 const service=createService({db,createDataScope,now:()=>time,canUseTestData:async(_,user,scope)=>!scope.testMode||user==='tester'});
 return {db,rows,seed,call:(action,data={},owner='alice')=>service({action,...data},owner),setTime(t){time=t;},offline(){offline=true;}};
}
const describe=f=>f.call('getSchedule',{scheduleId:'schedule'});
const write=(f,item,liked,version=0,owner)=>f.call('setLike',{scheduleId:'schedule',itemId:item.id,liked,version},owner);
test('一人多首，每首唯一赞，可取消；旧接口字段与编辑revision保持',async()=>{
 const f=fixture(),before=structuredClone(f.rows.get('schedules/schedule')),v=(await describe(f)).data;
 assert.equal((await write(f,v.items[0],true)).data.count,1);assert.equal((await write(f,v.items[1],true)).data.count,1);
 assert.equal((await write(f,v.items[0],true)).data.count,1);assert.equal((await write(f,v.items[0],false,1)).data.count,0);
 const after=f.rows.get('schedules/schedule');assert.deepEqual(after.day1,before.day1);assert.equal(after.revision,5);assert.equal((await describe(f)).data.items[1].liked,true);
});
test('本人身份不可伪造，测试域隔离，响应不泄漏点赞人；旧请求不能覆盖后来的取消',async()=>{
 const f=fixture(),item=(await describe(f)).data.items[0];await write(f,item,true);await write(f,item,false,1);
 assert.equal((await write(f,item,true,0)).code,'CONFLICT');
 const bob=await f.call('getSchedule',{scheduleId:'schedule',owner:'alice'},'bob');assert.equal(bob.data.items[0].liked,false);assert(!JSON.stringify(bob).includes('alice'));
 assert.equal((await f.call('getSchedule',{scheduleId:'schedule',_testMode:true})).code,'TEST_ACCESS_DENIED');assert.equal((await f.call('getSchedule',{scheduleId:'schedule'},'')).code,'UNAUTHENTICATED');
});
test('北京时间周日边界后第三期停止互动，六个月内仍读最终数',async()=>{
 const f=fixture();f.rows.get('schedules/schedule').week_key='2026-10-11';const item=(await describe(f)).data.items[0];await write(f,item,true);
 f.setTime(Date.UTC(2026,9,31,16));const final=await describe(f);assert.equal(final.data.items[0].interactive,false);assert.equal(final.data.items[0].count,1);assert.equal((await write(f,item,false,1)).code,'LIKES_CLOSED');
 f.setTime(Date.UTC(2027,3,11));assert.equal((await describe(f)).code,'NOT_AVAILABLE');
});
test('重排沿用身份，替换换身份，重复不明旧曲目不可写；撤回立即拒绝',async()=>{
 const f=fixture(),item=(await describe(f)).data.items[0];await write(f,item,true);
 f.rows.get('schedules/schedule').day1.reverse();assert.equal((await describe(f)).data.items[1].count,1);
 f.rows.get('schedules/schedule').day1[1].song_name='另一首';assert.notEqual((await describe(f)).data.items[1].id,item.id);assert.equal((await write(f,item,false,1)).code,'SONG_CHANGED');
 f.rows.get('schedules/schedule').status='pending';assert.equal((await describe(f)).code,'NOT_AVAILABLE');
 const duplicates=model.items({_id:'x',day1:[{song_name:'同名'},{song_name:'同名'}]});assert(duplicates.every(r=>r.ambiguous));
});
test('并发赞数与个人记录一致，事务冲突自动重试而不重复累计',async()=>{
 const f=fixture(),item=(await describe(f)).data.items[0];const res=await Promise.all([write(f,item,true,0,'alice'),write(f,item,true,0,'bob')]);
 assert.equal(res.filter(v=>v.success).length,2);
 assert.equal((await describe(f)).data.items[0].count,2);assert.equal([...f.rows.keys()].filter(k=>k.startsWith('song_likes/')).length,2);
});
test('个人分页关联当前歌单与最终总数，不返回已撤回或已过期记录',async()=>{
 const f=fixture(),item=(await describe(f)).data.items[0];await write(f,item,true);
 const result=await f.call('listMine',{month:'2026-10'});assert.equal(result.data.items.length,1);assert.equal(result.data.items[0].count,1);assert(!JSON.stringify(result).includes('owner'));
 f.rows.get('schedules/schedule').status='pending';assert.equal((await f.call('listMine',{month:'2026-10'})).data.items.length,0);
});
test('六个月仅延长已发布歌单，候补和最近两期判断不变',async()=>{
 const f=fixture();f.seed('schedules','older',{week_key:'2026-08-02',status:'published'});f.seed('schedules','expired',{week_key:'2026-04-26',status:'published'});f.seed('schedules','pending',{week_key:'2026-08-02',status:'pending'});
 const fetchAll=async(n,w)=>(await f.db.collection(n).where(w).get()).data;
 await retention.cleanupSchedules({db:f.db,command:f.db.command,collection:'schedules',keepKeys:['2026-10-25','2026-10-18','2026-10-11'],fetchAll,removeAllMatching:async(n,w)=>(await f.db.collection(n).where(w).remove()).stats.removed,now:Date.UTC(2026,9,31)});
 assert(f.rows.has('schedules/older'));assert(!f.rows.has('schedules/expired'));assert(!f.rows.has('schedules/pending'));
 assert.equal(retention.expiry('2026-08-30'),Date.UTC(2027,1,27,16));assert.equal(model.expiresAt('2026-08-30'),retention.expiry('2026-08-30'));
});

test('本人投稿历史按月份与身份读取，只以正式发布及原投稿ID确认入选',async()=>{
 const f=fixture();f.seed('submissions','a',{user_id:'alice',song_name:'稻香',singer:'周杰伦',special_note:'原版',week_key:'2026-10-25',submit_time:new Date('2026-10-25T02:00:00Z'),status:'selected'});
 f.seed('submissions','private',{user_id:'bob',song_name:'别人的歌',week_key:'2026-10-25',submit_time:new Date('2026-10-25T02:00:00Z')});
 const r=await f.call('listSubmissions',{month:'2026-10',owner:'bob'});assert.equal(r.success,true);assert.equal(r.data.items.length,1);assert.equal(r.data.items[0].note,'原版');assert.equal(r.data.items[0].placement.weekKey,'2026-10-25');assert(!JSON.stringify(r).includes('alice'));assert(!JSON.stringify(r).includes('别人的歌'));
 f.rows.get('schedules/schedule').status='pending';const draft=await f.call('listSubmissions',{month:'2026-10'});assert.equal(draft.data.items[0].placement,null);assert.equal(draft.data.items[0].statusLabel,'');
 assert.equal((await f.call('listSubmissions',{month:'2026-10',_testMode:true})).code,'TEST_ACCESS_DENIED');
});
test('投稿历史保存六个月不延长候补，overflow仍能查看且过期不可见',async()=>{
 const f=fixture();f.seed('submissions','over',{user_id:'alice',song_name:'超额记录',week_key:'2026-08-02',submit_time:new Date('2026-08-02T02:00:00Z'),status:'overflow'});f.seed('submissions','expired',{user_id:'alice',song_name:'到期记录',week_key:'2026-04-26',submit_time:new Date('2026-04-26T02:00:00Z'),status:'carryover'});
 assert.equal((await f.call('listSubmissions',{month:'2026-08'})).data.items[0].statusLabel,'');assert.equal((await f.call('listSubmissions',{month:'2026-04'})).data.items.length,0);
 const fetchAll=async(n,w)=>(await f.db.collection(n).where(w).get()).data;
 await retention.cleanupSubmissions({db:f.db,command:f.db.command,collection:'submissions',fetchAll,now:Date.UTC(2026,9,31)});assert(f.rows.has('submissions/over'));assert(!f.rows.has('submissions/expired'));
});

test('未确认入选的全部投稿返回空状态，不改变内部状态或候补范围',async()=>{
 const f=fixture();
 for(const status of ['pending','carryover','overflow','rejected','selected'])f.seed('submissions','unplaced-'+status,{user_id:'alice',song_name:'稻香',singer:'周杰伦',week_key:'2026-10-25',submit_time:new Date('2026-10-25T02:00:00Z'),status});
 f.seed('submissions','ended',{user_id:'alice',song_name:'候补已结束',week_key:'2026-08-02',submit_time:new Date('2026-10-01T02:00:00Z'),status:'carryover'});
 const before=structuredClone([...f.rows]),r=await f.call('listSubmissions',{month:'2026-10'});
 assert.equal(r.success,true);assert.equal(r.data.items.length,6);
 for(const row of r.data.items){assert.equal(row.statusLabel,'');assert.equal(row.placement,null);}
 assert.deepEqual([...f.rows],before);
});

test('已发布曲目的旧_id关联与跨期候补均显示已入选，新submission_id优先且不按名称猜测',async()=>{
 const f=fixture();f.seed('submissions','a',{user_id:'alice',song_name:'稻香',week_key:'2026-10-25',submit_time:new Date('2026-10-25T02:00:00Z'),status:'carryover'});
 f.rows.get('schedules/schedule').day1=[{_id:'a',song_name:'稻香'}];
 let r=await f.call('listSubmissions',{month:'2026-10'});assert.equal(r.data.items[0].statusLabel,'已入选');assert.equal(r.data.items[0].placement.day,1);
 f.rows.get('schedules/schedule').day1=[{_id:'a',submission_id:'another',song_name:'稻香'}];
 r=await f.call('listSubmissions',{month:'2026-10'});assert.equal(r.data.items[0].statusLabel,'');assert.equal(r.data.items[0].placement,null);
 f.rows.get('schedules/schedule').day1=[];
 f.seed('schedules','later',{week_key:'2026-11-08',status:'published',day3:[{submission_id:'a',song_name:'稻香'}]});
 r=await f.call('listSubmissions',{month:'2026-10'});assert.equal(r.data.items[0].statusLabel,'已入选');assert.equal(r.data.items[0].placement.weekKey,'2026-11-08');assert.equal(r.data.items[0].placement.day,3);
});
