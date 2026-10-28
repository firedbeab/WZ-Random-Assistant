const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const original = require('../../utils/community');
const event = dataset => ({ currentTarget: { dataset } });
function fixture(file) {
  let definition, serial = 0; const calls = [], toasts = [], timers = new Map(), state = { handler: async action => action === 'getProfile' ? { alias: '点歌同学' } : { items: [], hasMore: false, offset: 0 } };
  const notify = { page: value => value, showToast: (_, value) => toasts.push(value), showLoading() {}, hideLoading() {}, showModal: async () => ({ confirm: true }), DRAWER_CLOSE_MS: 300 };
  const common = { ...original, requestId: () => 'request_test_' + (++serial), async api(action, data) { calls.push({ action, ...data }); return state.handler(action, data); } };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../../pages', file), 'utf8'), {
    Page(value) { definition = value; }, wx: { stopPullDownRefresh() {}, navigateBack() {} }, console,
    setTimeout(fn) { const n = ++serial; timers.set(n, fn); return n; }, clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name.includes('theme')) return { page: value => value, getState: () => ({ mode: 'system', palette: 'green' }), setPreference: () => true };
      if (name.includes('admin-feedback')) return notify;
      if (name.includes('community')) return common;
      if (name.includes('color-palette')) return require('../../utils/color-palette');
      if (name.includes('runtime')) return { isTestMode: () => true, cloudCall: async () => ({ result: { success: true, data: null } }) };
      throw Error(name);
    }
  });
  const page = { ...definition, _alive: true, data: structuredClone(definition.data), setData(patch) { assert(this._alive, 'unloaded page mutated'); Object.assign(this.data, patch); } };
  page.fail = error => { if (page._alive) toasts.push({ title: error.message }); };
  return { page, state, calls, toasts, flush() { for (const fn of timers.values()) fn(); timers.clear(); } };
}
test('提交失败保留正文和幂等编号；重复点击不并发提交，成功后才清空', async () => {
  const f=fixture('feedback/index.js'),p=f.page; p.setData({content:'希望改进反馈页面'});
  f.state.handler=async()=>{throw Error('网络断开');}; await p.submit();const first=f.calls[0].requestId;assert.equal(p.data.content,'希望改进反馈页面');assert.equal(p.data.busy,false);
  await p.submit();assert.equal(f.calls[1].requestId,first);
  let finish;f.state.handler=async action=>action==='submitFeedback'?new Promise(resolve=>finish=resolve):{items:[],offset:0,hasMore:false};const pending=p.submit();await p.submit();assert.equal(f.calls.filter(v=>v.action==='submitFeedback').length,3);finish({});await pending;assert.equal(p.data.content,'');
});
test('快速切标签时旧请求不能覆盖当前数据，卸载后不写入', async () => {
  const f=fixture('feedback/index.js'),p=f.page;let old;f.state.handler=action=>action==='listMine'?new Promise(resolve=>old=resolve):Promise.resolve({items:[],hasMore:false,offset:0});
  const pending=p.load();p.switchTab(event({tab:'polls'}));old({items:[{_id:'old',status:'received'}],hasMore:true,offset:20});await pending;assert.equal(p.data.tab,'polls');assert.equal(p.data.entries.length,0);
  let late;f.state.handler=()=>new Promise(resolve=>late=resolve);const last=p.load();p.onUnload();late({items:[],hasMore:false,offset:0});await last;assert.equal(p._alive,false);
});

test('反馈标签手势只接受单指横滑，纵滚、左缘返回、输入中与忙碌均不切换', () => {
  const p=fixture('feedback/index.js').page;p.load=()=>{};
  const start=(x=240,y=300,n=1)=>p.onTabTouchStart({touches:Array.from({length:n},()=>({clientX:x,clientY:y})),timeStamp:0});
  const end=(x,y,time=250)=>p.onTabTouchEnd({changedTouches:[{clientX:x,clientY:y}],timeStamp:time});
  start();end(120,305);assert.equal(p.data.tab,'polls');start(80);end(220,302);assert.equal(p.data.tab,'feedback');
  start();p.onTabTouchMove({touches:[{clientX:242,clientY:340}]});end(100,340);assert.equal(p.data.tab,'feedback');
  start(10);end(150,300);assert.equal(p.data.tab,'feedback');start(240,300,2);end(100,300);assert.equal(p.data.tab,'feedback');
  p.setData({focusedField:'feedback-content'});start();end(100,300);assert.equal(p.data.tab,'feedback');
  p.setData({focusedField:'',busy:true});start();end(100,300);assert.equal(p.data.tab,'feedback');
});

test('反馈历史独立分页合并且保留失败时已读列表，回页刷新不并发混页', async () => {
  const f=fixture('feedback/history.js'),p=f.page;
  f.state.handler=async()=>({items:[{_id:'one',createdAt:1}],offset:1,hasMore:true});await p.load();
  f.state.handler=async()=>({items:[{_id:'one',createdAt:1},{_id:'two',createdAt:2}],offset:2,hasMore:false});await p.load(true);
  assert.equal(p.data.entries.length,2);assert.equal(f.calls.at(-1).offset,1);
  f.state.handler=async()=>{throw Error('offline');};await p.load();assert.equal(p.data.entries.length,2);assert.equal(p.data.error,'offline');
});
test('已读请求只使用当前展示的回复版本，不擅自确认后到回复', async () => {
  const f=fixture('feedback/history.js'),p=f.page,entry={_id:'item',reply:'一版回复',replyVersion:1,status:'handling',unread:true,createdAt:1};p.setData({entries:[entry]});
  f.state.handler=async action=>action==='getFeedback'?entry:{...entry,reply:'二版回复',replyVersion:2,unread:true};await p.openFeedback(event({id:'item'}));assert.equal(f.calls.find(v=>v.action==='markRead').replyVersion,1);assert.equal(p.data.detail.replyVersion,1);assert.equal(p.data.entries[0].unread,true);
});
test('后台回复冲突保留草稿和原 revision，不自动重试覆盖', async()=>{
  const f=fixture('admin/feedback.js'),p=f.page;p.setData({allowed:true,entries:[{_id:'item',status:'received',reply:'',revision:1}]});p.openFeedback(event({id:'item'}));p.inputReply({detail:{value:'准备回复'}});f.state.handler=async()=>{throw Error('其他管理员已处理，请刷新');};await p.saveReply();assert.equal(p.data.sheet,'detail');assert.equal(p.data.reply,'准备回复');assert.equal(p.data.dirty,true);assert.equal(p.data.detail.revision,1);assert.match(p.data.sheetError,/其他管理员/);assert.equal(f.calls.length,1);
});
test('未授权后台不展示已有列表；新建投票失败保留选项、期限和请求编号',async()=>{
  const f=fixture('admin/feedback.js'),p=f.page;f.state.handler=async()=>{const e=Error('无权限');e.code='FORBIDDEN';throw e;};p.setData({allowed:true,entries:[{_id:'old'}]});await p.load();assert.equal(p.data.allowed,false);assert.equal(p.data.entries.length,0);
  p.setData({allowed:true});p.newPoll();p.setData({title:'优先做什么功能',options:['选项甲','选项乙'],days:14});f.state.handler=async()=>{throw Error('网络断开');};await p.createPoll();const id=f.calls.at(-1).requestId;await p.createPoll();assert.equal(f.calls.at(-1).requestId,id);assert.equal(p.data.days,14);assert.equal(p.data.options[1],'选项乙');assert.equal(p.data.sheet,'newPoll');
});
