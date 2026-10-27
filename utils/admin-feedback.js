// 管理端页内反馈：与主题同源，加载和提示互不清除，不覆盖微信系统UI。
const timers = new WeakMap();
const disposed = new WeakSet();
const dialogs = new WeakMap();
const closingTimers = new WeakMap();
const dateTimers = new WeakMap();
function live(page) { return page && typeof page.setData === 'function' && !disposed.has(page); }
function showLoading(page, options = {}) {
  if (live(page)) page.setData({ _adminFeedbackLoading: true, _adminFeedbackMask: options.mask === true,
    _adminFeedbackTitle: options.title || '处理中…' });
}
function hideLoading(page) {
  if (live(page)) page.setData({ _adminFeedbackLoading: false, _adminFeedbackMask: false });
}
function showToast(page, options = {}) {
  if (!live(page)) return;
  clearTimeout(timers.get(page));
  page.setData({ _adminFeedbackMessage: options.title || '', _adminFeedbackKind: options.icon === 'success' ? 'success' : 'info' });
  const timer = setTimeout(() => {
    timers.delete(page);
    if (live(page)) page.setData({ _adminFeedbackMessage: '' });
  }, Math.max(1000, Math.min(6000, Number(options.duration) || 2400)));
  if (timer && typeof timer.unref === 'function') timer.unref();
  timers.set(page, timer);
}
function finishDialog(page, result) {
  const dialog = dialogs.get(page); if (!dialog) return;
  dialogs.delete(page);
  page.setData({ _adminDialogVisible: false, _adminDialogClosing: false });
  if (dialog.options._actionSheet && !result.confirm) {
    if (dialog.options.fail) dialog.options.fail({ errMsg: 'showActionSheet:fail cancel' });
  } else if (dialog.options.success) dialog.options.success(result);
  if (dialog.options.complete) dialog.options.complete(result);
  dialog.resolve(result);
}
function settleDialog(page, result) {
  const dialog = dialogs.get(page); if (!dialog || dialog.closing) return;
  dialog.closing = true; page.setData({ _adminDialogClosing: true });
  closingTimers.set(page, setTimeout(() => {
    closingTimers.delete(page); if (live(page)) finishDialog(page,result);
  }, 200));
}
function showModal(page, options = {}) {
  if (!live(page) || dialogs.has(page)) return Promise.resolve({ confirm: false, cancel: true, content: '' });
  return new Promise(resolve => {
    dialogs.set(page,{ options, resolve, closing: false });
    page.setData({ _adminDialogVisible: true, _adminDialogClosing: false, _adminDialogTitle: options.title || '提示',
      _adminDialogContent: options.content || '', _adminDialogEditable: !!options.editable,
      _adminDialogPlaceholder: options.placeholderText || '请输入', _adminDialogInput: options.inputValue || '',
      _adminDialogCancel: options.showCancel !== false, _adminDialogConfirmText: options.confirmText || '确定',
      _adminDialogCancelText: options.cancelText || '取消', _adminDialogChoices: options.choices || [],
      _adminDialogDestructive: /删除|清空|撤回|撤销|放弃|强制关闭|移除/.test(options.title || ''),
      _adminDialogDate: false, _adminDateMoving: false,
      _adminDialogChoiceIndex: options.selectedIndex === undefined ? -1 : options.selectedIndex });
  });
}
function showActionSheet(page, options = {}) {
  return showModal(page,{ ...options, _actionSheet: true, choices: (options.itemList || []).map(label=>({label})) });
}
function showChoice(page, options = {}) { return showModal(page,options); }
function dateFields(page, state) {
  const years=Array.from({length:state.end-state.start+1},(_,i)=>state.start+i);
  const days=Array.from({length:new Date(Date.UTC(state.year,state.month,0)).getUTCDate()},(_,i)=>i+1);
  state.day=Math.min(state.day,days.length);
  page.setData({ _adminDialogDate:true, _adminDateYears:years, _adminDateMonths:Array.from({length:12},(_,i)=>i+1), _adminDateDays:days,
    _adminDateValue:[state.year-state.start,state.month-1,state.day-1] });
}
function showDatePicker(page, options = {}) {
  if (!live(page) || dialogs.has(page)) return Promise.resolve({confirm:false,cancel:true});
  let value=typeof options.value==='string'?options.value:'';
  const valid=/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(new Date(value+'T00:00:00Z').getTime())&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  if(!valid)value=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
  const [year,month,day]=value.split('-').map(Number),state={year,month,day,start:Math.max(1,Math.min(1900,year-10)),end:Math.min(9999,Math.max(2100,year+10))};
  const promise=showModal(page,{...options,title:options.title||'选择日期',_date:state,choices:[]});dateFields(page,state);return promise;
}
function clear(page) {
  clearTimeout(timers.get(page)); timers.delete(page); clearTimeout(closingTimers.get(page)); closingTimers.delete(page);
  clearTimeout(dateTimers.get(page)); dateTimers.delete(page);
  const dialog=dialogs.get(page); dialogs.delete(page); if(dialog) dialog.resolve({ confirm:false,cancel:true,content:'' });
  disposed.add(page);
}
function page(definition) {
  const unload=definition.onUnload;
  return {
    onAdminDialogConfirm(e) {
      const dialog=dialogs.get(this),date=dialog&&dialog.options._date;
      if(date){if(this.data._adminDateMoving)return;const value=String(date.year).padStart(4,'0')+'-'+String(date.month).padStart(2,'0')+'-'+String(date.day).padStart(2,'0');settleDialog(this,{confirm:true,cancel:false,content:value,value});return;}
      const values=e&&e.detail&&e.detail.value; settleDialog(this,{ confirm:true,cancel:false,content:values&&typeof values.adminDialogInput==='string'?values.adminDialogInput:this.data._adminDialogInput||'' });
    },
    onAdminDateChange(e) {
      const dialog=dialogs.get(this),state=dialog&&dialog.options._date,v=e.detail.value;if(!state||dialog.closing||!Array.isArray(v))return;
      if(!v.every(Number.isInteger)||v[0]<0||v[0]>state.end-state.start||v[1]<0||v[1]>11||v[2]<0||v[2]>30)return;
      state.year=state.start+v[0];state.month=v[1]+1;state.day=v[2]+1;
      if(v[0]<3)state.start=Math.max(1,state.start-100);if(v[0]>state.end-state.start-3)state.end=Math.min(9999,state.end+100);dateFields(this,state);
    },
    onAdminDateStart() { this.setData({_adminDateMoving:true});clearTimeout(dateTimers.get(this)); },
    onAdminDateEnd() { clearTimeout(dateTimers.get(this));dateTimers.set(this,setTimeout(()=>{dateTimers.delete(this);if(live(this))this.setData({_adminDateMoving:false});},30)); },
    onAdminDialogCancel() { settleDialog(this,{ confirm:false,cancel:true,content:'' }); },
    onAdminDialogInput(e) { this.setData({ _adminDialogInput:e.detail.value }); },
    onAdminDialogChoice(e) { const index=Number(e.currentTarget.dataset.index); if(!Number.isInteger(index)||!this.data._adminDialogChoices[index])return; settleDialog(this,{confirm:true,cancel:false,tapIndex:index,index,content:''}); },
    onAdminDrawerMaskTap(e) { if(e.target.id===e.currentTarget.id){const close=this[e.currentTarget.dataset.close];if(typeof close==='function')close.call(this);} },
    onAdminDrawerTouchStart(e) { const t=e.touches&&e.touches.length===1&&e.touches[0];this._sharedDrawerTouch=t&&e.target.dataset&&e.target.dataset.drawerDrag?{x:t.clientX,y:t.clientY,time:e.timeStamp}:null; },
    onAdminDrawerTouchEnd(e) { const start=this._sharedDrawerTouch;this._sharedDrawerTouch=null;const t=e.changedTouches&&e.changedTouches.length===1&&e.changedTouches[0];if(!start||!t)return;const dy=t.clientY-start.y,dx=t.clientX-start.x;if(dy>60&&dy>Math.abs(dx)*1.5&&e.timeStamp-start.time<800){const close=this[e.currentTarget.dataset.close];if(typeof close==='function')close.call(this);} },
    adminDrawerNoop() {},
    ...definition,
    onUnload(...args) { clear(this); if(typeof unload==='function')return unload.apply(this,args); }
  };
}
module.exports = { showLoading, hideLoading, showToast, showModal, showChoice, showDatePicker, showActionSheet, page, clear };
