const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const presentation = require('../../utils/playlist-presentation');
const root=path.resolve(__dirname,'../..');
const schedule=name=>({week_key:'2026-10-25',day1:[{song_name:name,singer:'歌手',special_note:'保留完整备注'}],admin_note:'广播站说明'});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(options={}) {
  let page;
  const disk=new Map(),calls=[],writes=[],copies=[];
  const FixedDate=class extends Date { constructor(...args){super(...(args.length?args:['2026-10-26T02:00:00Z']));} };
  const runtime={isTestMode:()=>!options.prod,storageKey:key=>`${options.prod?'prod':'test'}_${key}`,collectionName:key=>key,async cloudCall(request){calls.push(request);return options.request?options.request(request):{result:{success:true,data:options.schedule||null}};}};
  const wx={
    getStorageSync:key=>disk.get(key),setStorageSync:(key,value)=>disk.set(key,value),removeStorageSync:key=>disk.delete(key),
    stopPullDownRefresh(){calls.push('stop-refresh');},showToast(){},setClipboardData(value){copies.push(value.data);},
    async requestSubscribeMessage({tmplIds}){calls.push('subscribe');return {[tmplIds[0]]:'accept'};},
    cloud:{database(){return {collection(name){let query;const chain={where(value){query=value;return chain;},limit(){return chain;},async get(){calls.push({name,query});return {data:name==='message_subscriptions'?[]:(options.schedule?[options.schedule]:[])};},async add({data}){writes.push({name,data});}};return chain;},serverDate:()=> 'server-date'};}}
  };
  vm.runInNewContext(fs.readFileSync(path.join(root,'pages/playlist/index.js'),'utf8'),{
    Page:value=>{page=value;},Date:FixedDate,wx,console:{warn(){}},getApp:()=>({globalData:{userInfo:{openid:'fixture-user'}}}),
    require:name=>name.endsWith('/playlist-presentation')?presentation:runtime
  });
  page.data=structuredClone(page.data);page.setData=patch=>Object.assign(page.data,patch);
  return {page,disk,calls,writes,copies};
}
test('播出日期跨年、空日、长文本、实际总数与管理员说明保留',()=>{
  const original=schedule('长歌名'.repeat(20)), before=JSON.stringify(original);
  const result=presentation.playlistPresentation(original,'2026-12-27');
  assert.equal(result.periodRange,'2026.12.28 — 2027.1.01');
  assert.equal(result.playlistDays[4].dateText,'1月1日');
  assert.equal(result.playlistTotal,1);assert.equal(result.playlistDays[1].songs.length,0);
  assert.equal(result.playlistDays[0].songs[0].note,'保留完整备注');assert.equal(result.playlistNote,'广播站说明');
  assert.equal(JSON.stringify(original),before);
  assert.equal(presentation.playlistPresentation(null,'bad').periodRange,'');
  assert.equal(presentation.playlistPresentation({day1:[null,{},...original.day1]},'2026-10-25').playlistTotal,1);
});
test('三期缓存均先展示再校验；撤回清缓存，空排期与未发布可区分',async()=>{
  for(const offset of [0,1,2]){
    let resolve;
    const f=fixture({request:()=>new Promise(done=>{resolve=done;})});f.page.data.activeTab=offset;
    const key=`test_schedule_cache_${f.page.getWeekKeyByOffset(offset)}`;f.disk.set(key,schedule('缓存'));
    await f.page.loadWeekPlaylist(offset,false);assert.equal(f.page.data.playlistDays[0].songs[0].title,'缓存');
    assert.equal(f.page.data.loading,false);assert.equal(f.calls.length,1);
    resolve({result:{success:true,data:null}});await tick();
    assert.equal(f.page.data.schedule,null);assert.equal(f.disk.has(key),false);assert.equal(f.page.data.loadError,false);
  }
  const empty=fixture({schedule:{admin_note:'本期暂停'}});await empty.page.loadWeekPlaylist(0,true);
  assert.ok(empty.page.data.schedule);assert.equal(empty.page.data.playlistTotal,0);assert.equal(empty.page.data.playlistNote,'本期暂停');
});
test('失败保留缓存并提示；无缓存错误不伪装为尚未发布，重试可恢复',async()=>{
  let failed=true;
  const f=fixture({request:async()=>failed?{result:{success:false}}:{result:{success:true,data:schedule('恢复')}}});
  await f.page.loadWeekPlaylist(0,true);assert.equal(f.page.data.loadError,true);assert.equal(f.page.data.schedule,null);
  f.disk.set('test_schedule_cache_2026-10-25',schedule('离线'));
  await f.page.loadWeekPlaylist(0,false);await tick();
  assert.equal(f.page.data.showingCached,true);assert.equal(f.page.data.playlistTotal,1);
  failed=false;await f.page.retryLoad();assert.equal(f.page.data.loadError,false);assert.equal(f.page.data.showingCached,false);
  assert.equal(f.page.data.playlistDays[0].songs[0].title,'恢复');
});
test('快速切期不会被旧请求覆盖；同一期迟到响应不能回滚内容和缓存',async()=>{
  const pending=[];const f=fixture({request:()=>new Promise(resolve=>pending.push(resolve))});
  const first=f.page.loadWeekPlaylist(0,true);f.page.data.activeTab=1;const second=f.page.loadWeekPlaylist(1,true);
  pending[1]({result:{success:true,data:schedule('上一期')}});await second;
  pending[0]({result:{success:true,data:schedule('最新期')}});await first;
  assert.equal(f.page.data.playlistDays[0].songs[0].title,'上一期');
  assert.equal(f.disk.get('test_schedule_cache_2026-10-25').day1[0].song_name,'最新期');
  const older=f.page.loadWeekPlaylist(1,true),newer=f.page.loadWeekPlaylist(1,true);
  pending[3]({result:{success:true,data:schedule('新版本')}});await newer;
  pending[2]({result:{success:true,data:schedule('旧版本')}});await older;
  assert.equal(f.page.data.playlistDays[0].songs[0].title,'新版本');
  assert.equal(f.disk.get('test_schedule_cache_2026-10-18').day1[0].song_name,'新版本');
});
test('生产读取仍筛选发布状态；通知周期不随历史标签，复制含完整备注',async()=>{
  const f=fixture({prod:true,schedule:schedule('稻香')});f.page.data.activeTab=2;
  await f.page.loadWeekPlaylist(2,true);
  const read=f.calls.find(call=>call.name==='schedules');assert.equal(read.query.status,'published');assert.equal(read.query.week_key,'2026-10-11');
  await f.page.onEnableSub();assert.equal(f.writes.length,1);assert.equal(f.writes[0].data.week_key,'2026-11-01');
  await f.page.onEnableSub();assert.equal(f.writes.length,1);
  f.page.copyItem({currentTarget:{dataset:{name:'稻香',singer:'周杰伦',note:'现场版\n完整说明'}}});
  assert.equal(f.copies[0],'稻香 - 周杰伦\n备注：现场版\n完整说明');
  f.page.onPullDownRefresh();await tick();assert.ok(f.calls.includes('stop-refresh'));
});
