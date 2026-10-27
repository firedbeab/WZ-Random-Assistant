const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const presentation = require('../../utils/my-presentation');
const shared = require('../../utils/community');
const event = dataset => ({ currentTarget: { dataset } });
test('首次使用取真实 created_at 并按中国日期显示，缺值、非法值不伪造日期', () => {
  assert.equal(presentation.firstUse('2026-10-01T20:00:00Z'), '首次使用 · 2026.10.02');
  assert.equal(presentation.firstUse({ $date: Date.UTC(2026, 9, 1, 20) }), '首次使用 · 2026.10.02');
  for (const value of [undefined, null, '', {}, { $date: 'bad' }, 'bad', Infinity, 9e18]) assert.equal(presentation.firstUse(value), '首次使用日期暂无记录');
});
test('周期与首页一致：正常关闭取最新期，临时开放取提交周期，强制关闭优先', () => {
  const now=Date.parse('2026-10-27T08:00:00Z');
  assert.equal(presentation.context({},now).weekKey,'2026-10-25');
  assert.equal(presentation.context({channelForceOpen:true},now).weekKey,'2026-11-01');
  assert.equal(presentation.context({channelForceOpen:true,channelForceClose:true},now).open,false);
  assert.equal(presentation.context({},Date.parse('2026-11-01T00:00:00Z')).open,true);
  assert.equal(presentation.context({},Date.parse('2026-11-01T12:00:00Z')).open,false);
});
test('本周卡片区分投稿与通道四态、发布、加载和失败；选中待审核不提前宣称入选', () => {
  const submission={_id:'mine',status:'selected'};
  for(const open of [false,true])for(const submitted of [false,true]) {
    const view=presentation.state({period:{weekKey:'2026-10-25',open,nextOpen:'11月1日'},submission:submitted?submission:null,schedule:null});
    assert.equal(view.open,open);assert.equal(view.submitted,submitted);assert.equal(view.action,submitted?'submission':'home');assert(!view.description.includes('已列入'));
  }
  const period={weekKey:'2026-10-25',open:true};
  const published=presentation.state({period,submission,schedule:{day1:[{submission_id:'mine'}]}});
  assert.equal(published.open,false);assert.equal(published.action,'playlist');assert.match(published.description,/已列入/);
  assert.equal(presentation.state({period,submission:null,schedule:{}}).kind,'published');
  assert.equal(presentation.loading().action,'');assert.equal(presentation.failed().action,'retry');
});
function fixture() {
  let definition, serial=0; const timers=new Map(),calls=[],changes=[],themeCalls=[];
  const clock={now:Date.parse('2026-10-27T08:00:00Z')};
  const settings={mode:'light',palette:'green'},state={domain:'test',user:{name_alias:'旧称呼',created_at:'2026-06-01T00:00:00Z'},submission:null,schedule:null,
    async handler(data){return !data?state.user:data.action==='getMySubmission'?state.submission:state.schedule;},async alias(alias){return {alias};}};
  const theme={page:v=>v,getState:()=>({...settings}),setPreference(next,options){Object.assign(settings,next);themeCalls.push({next,options});return true;},flushPreference(){themeCalls.push({flush:true});}};
  const common={...shared,sheetMethods:{...shared.sheetMethods,finishSheet(){this.setData({sheetClosing:true});}},api:async(_,data)=>state.alias(data.alias)};
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../../pages/my/index.js'),'utf8'),{
    Page(value){definition=value;},wx:{stopPullDownRefresh(){},navigateTo(){},reLaunch(){}},console,
    setTimeout(fn){const id=++serial;timers.set(id,fn);return id;},clearTimeout(id){timers.delete(id);},
    require(name){
      if(name.includes('/theme'))return theme;
      if(name.includes('/admin-feedback'))return {page:v=>v,showToast(){}};
      if(name.includes('/community'))return common;
      if(name.includes('/color-palette'))return require('../../utils/color-palette');
      if(name.includes('/my-presentation'))return {...presentation,context:user=>presentation.context(user,clock.now)};
      if(name.includes('/runtime'))return {isTestMode:()=>state.domain==='test',storageKey:key=>state.domain+'_'+key,cloudCall:async({data})=>{calls.push(data);return {result:{success:true,data:await state.handler(data)}};}};
      throw Error(name);
    }
  });
  function page(){const p={...definition,data:structuredClone(definition.data),setData(patch){assert(p._alive,'late unloaded write');changes.push(structuredClone(patch));Object.assign(p.data,patch);}};p.onLoad();return p;}
  return {page,state,clock,calls,changes,themeCalls,settings,flush(){for(const fn of timers.values())fn();timers.clear();}};
}
test('首次加载保留容器；再次进入与重新建页均先用内存快照，后台读取不切回加载态', async()=>{
  const f=fixture(),p=f.page();assert.equal(p.data.week.kind,'loading');await p.load();assert.equal(p.data.week.kind,'closed');
  let finish;f.state.handler=()=>new Promise(resolve=>finish=resolve);const old=p.data.week,pending=p.load();assert.equal(p.data.week,old);assert.equal(p.data.loading,false);
  const second=f.page();assert.equal(second.data.week.kind,'closed');assert.equal(second.data.loading,false);
  finish(f.state.user);await Promise.resolve();f.state.handler=async data=>!data?f.state.user:null;
  // 原请求的第二阶段采用最新 handler，完成后无需重建卡片。
  await pending;assert.equal(p.data.week.kind,'closed');
});
test('静默更新失败保留旧内容，换周期或数据域不冒用旧投稿',async()=>{
  const f=fixture(),p=f.page();f.state.submission={_id:'mine',song_name:'已提交'};await p.load();
  f.state.handler=async()=>{throw Error('offline');};await p.load();assert.equal(p.data.week.kind,'submitted-closed');assert.match(p.data.refreshError,/保留上次/);
  f.clock.now=Date.parse('2026-11-01T00:00:00Z');await p.load();assert.equal(p.data.week.kind,'error');assert.equal(p.data.submission,null);
  f.state.domain='prod';const other=f.page();assert.equal(other.data.week.kind,'loading');assert.equal(other.data.submission,null);
});
test('旧请求及卸载回调不能覆盖新卡片，资料成功但歌单失败仍显示首次日期',async()=>{
  const f=fixture(),p=f.page();let finish;f.state.handler=()=>new Promise(resolve=>finish=resolve);const old=p.load();
  f.state.handler=async data=>!data?f.state.user:data.action==='getPublishedSchedule'?{}:null;await p.load();finish(f.state.user);await old;assert.equal(p.data.week.kind,'published');
  f.state.handler=async data=>{if(!data)return f.state.user;throw Error('offline');};const q=f.page();q._snapshot=null;await q.load();assert.equal(q.data.profileReady,true);assert.equal(q.data.firstUseText,'首次使用 · 2026.06.01');assert.equal(q.data.week.kind,'error');
  let late;f.state.handler=()=>new Promise(resolve=>late=resolve);const last=q.load();q.onUnload();late(f.state.user);await last;
});
test('称呼使用独立弹窗，保存失败不关窗；成功后快照同步且迟到资料不回滚称呼',async()=>{
  const f=fixture(),p=f.page();await p.load();p.editAlias();assert.equal(p.data.aliasVisible,true);assert.equal(p.data.sheet,'');p.inputAlias({detail:{value:'新的称呼'}});
  f.state.alias=async()=>{throw Error('offline');};await p.saveAlias();assert.equal(p.data.aliasVisible,true);assert.equal(p.data.aliasDraft,'新的称呼');assert.equal(p.data.busy,false);
  let finish;f.state.handler=()=>new Promise(resolve=>finish=resolve);const pending=p.load();f.state.alias=async alias=>({alias});await p.saveAlias();f.flush();assert.equal(p.data.aliasVisible,false);
  f.state.handler=async data=>!data?f.state.user:null;finish(f.state.user);await pending;assert.equal(p.data.alias,'新的称呼');assert.equal(f.page().data.alias,'新的称呼');
});
test('外观即时应用，无保存草稿；展开自定义不改主题，再点收起，选预设也收起',()=>{
  const f=fixture(),p=f.page();p.openAppearance();p.selectMode(event({id:'dark'}));assert.equal(f.settings.mode,'dark');p.selectPalette(event({id:'wzred'}));assert.equal(f.settings.palette,'wzred');
  p.openColor();assert.equal(p.data.colorEditing,true);assert.equal(f.settings.palette,'wzred');p.openColor();assert.equal(p.data.colorEditing,false);
  p.changeColor({detail:{value:'#25698e',final:false}});assert.equal(f.settings.customColor,'#25698e');assert.equal(f.themeCalls.at(-1).options.deferSave,true);
  p.changeColor({detail:{value:'#25698e',final:true}});assert.equal(f.themeCalls.at(-1).options.deferSave,false);
  p.openColor();p.selectPalette(event({id:'blue'}));assert.equal(p.data.colorEditing,false);assert.equal(p.data.dirty,false);p.closeSheet();assert.equal(p.data.sheetClosing,true);assert(f.themeCalls.some(v=>v.flush));
});
