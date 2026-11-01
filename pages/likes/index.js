const theme=require('../../utils/theme'),feedback=require('../../utils/admin-feedback'),community=require('../../utils/community'),likes=require('../../utils/song-likes'),journal=require('../../utils/song-journal');
function monthNow(){return new Date(Date.now()+8*3600000).toISOString().slice(0,7);}
function months(){const d=new Date(monthNow()+'-01T00:00:00Z');return Array.from({length:7},(_,i)=>{const n=new Date(d);n.setUTCMonth(n.getUTCMonth()-i);return n.toISOString().slice(0,7);});}
Page(theme.page(feedback.page({
 data:{months:months(),month:monthNow(),monthIndex:0,tab:'submissions',entries:[],groups:[],panels:[0],loading:true,error:'',hasMore:false,offset:0,sheet:'',sheetClosing:false,detail:null,busy:false},
 ...community.sheetMethods,
 onLoad(options={}){this._alive=true;this._cache=new Map();this._expanded={};if(options.tab==='likes')this.setData({tab:'likes'});this.load();},
 onUnload(){this._alive=false;clearTimeout(this._sheetTimer);},
 onShow(){if(this._loaded&&!this.data.loading&&!this.data.busy&&!this.data.sheet)this.load();},
 async onPullDownRefresh(){if(!this.data.busy)await this.load();wx.stopPullDownRefresh();},
 async load(more=false){
  if(more&&(this.data.loading||!this.data.hasMore)||this.data.busy)return;
  const seq=this._seq=(this._seq||0)+1,{month,tab}=this.data,key=tab+month;
  this.setData({loading:true,error:''});
  try{const result=await likes.api(tab==='likes'?'listMine':'listSubmissions',{month,offset:more?this.data.offset:0});if(!this._alive||seq!==this._seq)return;
   const items=result.items.map(item=>journal.present(item,tab)),entries=more?[...new Map(this.data.entries.concat(items).map(r=>[r.recordKey,r])).values()]:items;
   const snapshot={entries,hasMore:result.hasMore,offset:result.offset};this._loaded=true;this._cache.set(key,snapshot);this.setData({...snapshot,groups:journal.groups(entries,this._expanded,tab)});
  }catch(e){if(this._alive&&seq===this._seq)this.setData({error:e.message});}
  finally{if(this._alive&&seq===this._seq)this.setData({loading:false});}
 },
 retry(){this.load();},loadMore(){this.load(true);},
 showPanel(patch){const next={...this.data,...patch},cached=this._cache.get(next.tab+next.month)||{entries:[],offset:0,hasMore:false};this._expanded={};this.setData({...patch,...cached,groups:journal.groups(cached.entries,{},next.tab),error:'',panels:[(this._panel=(this._panel||0)+1)]});this.load();},
 switchTab(e){const tab=e.currentTarget.dataset.tab;if(this.data.busy||this.data.sheet||!['likes','submissions'].includes(tab)||tab===this.data.tab)return;this.showPanel({tab});},
 changeMonth(e){if(this.data.busy||this.data.sheet)return;const i=this.data.monthIndex+Number(e.currentTarget.dataset.step);if(i<0||i>=this.data.months.length)return;this.showPanel({monthIndex:i,month:this.data.months[i]});},
 toggleGroup(e){const key=e.currentTarget.dataset.date;this._expanded[key]=!this._expanded[key];this.setData({groups:journal.groups(this.data.entries,this._expanded,this.data.tab)});},
 touchStart(e){const t=e.touches&&e.touches.length===1&&e.touches[0];this._touch=t&&!this.data.sheet&&!this.data.busy&&t.clientX>24?{x:t.clientX,y:t.clientY,time:e.timeStamp}:null;},
 touchMove(e){const t=e.touches&&e.touches[0],s=this._touch;if(s&&(!t||Math.abs(t.clientY-s.y)>18&&Math.abs(t.clientY-s.y)>Math.abs(t.clientX-s.x)))this._touch=null;},
 touchCancel(){this._touch=null;},
 touchEnd(e){const s=this._touch,t=e.changedTouches&&e.changedTouches.length===1&&e.changedTouches[0];this._touch=null;if(s&&t&&e.timeStamp-s.time<650&&Math.abs(t.clientX-s.x)>64&&Math.abs(t.clientX-s.x)>Math.abs(t.clientY-s.y)*1.8)this.switchTab({currentTarget:{dataset:{tab:t.clientX<s.x?'likes':'submissions'}}});},
 openRecord(e){const entry=this.data.entries.find(r=>r.recordKey===e.currentTarget.dataset.key);if(entry)this.openSheet('detail',{detail:entry});},
 async cancelLike(){
  if(this.data.busy||!this.data.detail||!this.data.detail.interactive||this.data.detail.kind!=='likes')return;const item=this.data.detail;
  this.setData({busy:true,sheetError:''});
  try{
   const confirmation=await feedback.showModal(this,{title:'取消喜欢这首歌？',content:'取消后，这首歌会从“我喜欢的”中移除；三期互动期间仍可重新喜欢。',confirmText:'取消喜欢',cancelText:'保留喜欢',danger:true});
   if(!this._alive||!confirmation.confirm)return;
   const s=await likes.load(item.scheduleId,true),current=s.items.find(r=>r.id===item.id);
   if(!current||!current.interactive)throw Error('这期已停止点赞，请刷新查看最终数量');
   if(current.liked)await likes.setLike(item.scheduleId,item.id);
   if(!this._alive)return;this.setData({busy:false});this.finishSheet();await this.load();feedback.showToast(this,{title:'已取消喜欢'});
  }catch(e){if(this._alive)this.setData({sheetError:e.message});}
  finally{if(this._alive)this.setData({busy:false});}
 },
 goPlaylist(){const d=this.data.detail,week=d&&(d.kind==='likes'?d.weekKey:d.placement&&d.placement.weekKey);if(week){this.finishSheet();wx.navigateTo({url:'/pages/playlist/index?week='+week});}},
 goCurrent(){wx.navigateTo({url:'/pages/playlist/index'});}
})));
