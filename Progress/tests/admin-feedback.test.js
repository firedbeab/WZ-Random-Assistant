const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function fixture() {
  const timers = new Map(); let id = 0;
  const context = { module: { exports: {} }, setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../utils/admin-feedback.js'),'utf8'), context);
  const page = { ...context.module.exports.page({}), data: {}, setData(patch) { Object.assign(this.data,patch); } };
  return { feedback: context.module.exports, page, timers, flush() { for (const [id,fn] of timers) { timers.delete(id); fn(); } } };
}
test('页内加载与成功反馈独立，关闭加载不会清掉提示', () => {
  const f = fixture(); f.feedback.showLoading(f.page,{title:'保存中',mask:true}); f.feedback.showToast(f.page,{title:'已保存',icon:'success'}); f.feedback.hideLoading(f.page);
  assert.equal(f.page.data._adminFeedbackLoading,false); assert.equal(f.page.data._adminFeedbackMask,false); assert.equal(f.page.data._adminFeedbackMessage,'已保存'); f.flush(); assert.equal(f.page.data._adminFeedbackMessage,'');
});
test('新提示替换旧提示并清理旧定时器，反馈不跨页面共享', () => {
  const f = fixture(), other = {data:{},setData(p){Object.assign(this.data,p);}};
  f.feedback.showToast(f.page,{title:'A'}); f.feedback.showToast(f.page,{title:'B'}); assert.equal(f.timers.size,1);
  f.feedback.showLoading(other,{title:'读取中'}); assert.equal(f.page.data._adminFeedbackLoading,undefined); assert.equal(other.data._adminFeedbackTitle,'读取中'); f.flush(); assert.equal(other.data._adminFeedbackLoading,true);
});
test('页面卸载取消提示计时器并忽略迟到的网络反馈', () => {
  const f = fixture(); f.feedback.showToast(f.page,{title:'当前'}); f.feedback.clear(f.page); assert.equal(f.timers.size,0);
  f.feedback.showToast(f.page,{title:'迟到'}); f.feedback.showLoading(f.page,{title:'迟到'}); assert.equal(f.page.data._adminFeedbackMessage,'当前'); assert.equal(f.page.data._adminFeedbackLoading,undefined);
});

test('统一确认抽屉同时兼容success回调和Promise，使用提交时输入且只确认一次', async () => {
  const f = fixture(); let count=0, received;
  const result=f.feedback.showModal(f.page,{title:'确认操作',editable:true,content:'影响范围说明',success:r=>{count++;received=r;}});
  assert.equal(f.page.data._adminDialogContent,'影响范围说明'); assert.equal(f.page.data._adminDialogInput,'');
  f.page.onAdminDialogConfirm({detail:{value:{adminDialogInput:'最新口令'}}}); f.page.onAdminDialogConfirm(); f.flush();
  assert.equal((await result).content,'最新口令'); assert.equal(received.confirm,true); assert.equal(count,1); assert.equal(f.page.data._adminDialogVisible,false);
});
test('遮罩和顶部下滑可取消抽屉，内容输入区的滚动不关闭', async () => {
  const f = fixture(); let result=f.feedback.showModal(f.page,{title:'输入'});
  f.page.onAdminDrawerMaskTap({target:{id:'inside'},currentTarget:{id:'mask',dataset:{close:'onAdminDialogCancel'}}}); assert.equal(f.page.data._adminDialogVisible,true);
  f.page.onAdminDrawerTouchStart({target:{dataset:{}},touches:[{clientX:100,clientY:100}],timeStamp:0});
  f.page.onAdminDrawerTouchEnd({currentTarget:{dataset:{close:'onAdminDialogCancel'}},changedTouches:[{clientX:100,clientY:230}],timeStamp:300});assert.equal(f.page.data._adminDialogVisible,true);
  f.page.onAdminDrawerMaskTap({target:{id:'mask'},currentTarget:{id:'mask',dataset:{close:'onAdminDialogCancel'}}}); f.flush(); assert.equal((await result).cancel,true);
  result=f.feedback.showModal(f.page,{title:'第二次'});
  f.page.onAdminDrawerTouchStart({target:{dataset:{drawerDrag:true}},touches:[{clientX:100,clientY:100}],timeStamp:0});
  f.page.onAdminDrawerTouchEnd({currentTarget:{dataset:{close:'onAdminDialogCancel'}},changedTouches:[{clientX:105,clientY:220}],timeStamp:300});f.flush();assert.equal((await result).cancel,true);
});
test('筛选返回原索引，操作菜单取消不误触success，页面卸载释放等待者', async () => {
  const f=fixture();let success=0,fail=0;
  const choice=f.feedback.showChoice(f.page,{title:'类别',choices:[{label:'A'},{label:'B'}]});
  f.page.onAdminDialogChoice({currentTarget:{dataset:{index:1}}});f.flush();assert.equal((await choice).index,1);
  const menu=f.feedback.showActionSheet(f.page,{itemList:['生成本期'],success(){success++;},fail(){fail++;}});f.page.onAdminDialogCancel();f.flush();await menu;assert.equal(success,0);assert.equal(fail,1);
  const pending=f.feedback.showModal(f.page,{title:'等待'});f.feedback.clear(f.page);assert.equal((await pending).cancel,true);
});

test('日期滚轮处理闰年和大小月，不允许在滚动未结束时提交', async () => {
  const f=fixture();const result=f.feedback.showDatePicker(f.page,{value:'2024-01-31'});
  const year=f.page.data._adminDateYears.indexOf(2024);
  f.page.onAdminDateStart();f.page.onAdminDateChange({detail:{value:[year,1,30]}});
  assert.equal(f.page.data._adminDateDays.length,29);assert.equal(f.page.data._adminDateValue[2],28);
  f.page.onAdminDialogConfirm();assert.equal(f.page.data._adminDialogClosing,false);
  f.page.onAdminDateEnd();f.flush();f.page.onAdminDialogConfirm();f.flush();assert.equal((await result).value,'2024-02-29');
  const next=f.feedback.showDatePicker(f.page,{value:'2025-01-31'});f.page.onAdminDateChange({detail:{value:[f.page.data._adminDateYears.indexOf(2025),1,30]}});assert.equal(f.page.data._adminDateDays.length,28);
  f.page.onAdminDialogCancel();f.flush();assert.equal((await next).cancel,true);
});
