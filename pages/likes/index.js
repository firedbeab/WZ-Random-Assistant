const theme=require('../../utils/theme'),feedback=require('../../utils/admin-feedback'),community=require('../../utils/community'),likes=require('../../utils/song-likes');
function monthNow(){return new Date(Date.now()+8*3600000).toISOString().slice(0,7);}
function months(){const d=new Date(monthNow()+'-01T00:00:00Z');return Array.from({length:7},(_,i)=>{const n=new Date(d);n.setUTCMonth(n.getUTCMonth()-i);return n.toISOString().slice(0,7);});}
const date=n=>new Date(n+8*3600000).toISOString().slice(0,10).replace(/-/g,'.');
function present(item){return {...item,date:date(item.likedAt),day:date(item.likedAt).slice(-2),month:date(item.likedAt).slice(5,7),period:item.weekKey.replace(/-/g,'.')+'期',others:Math.max(0,item.count-1)};}
Page(theme.page(feedback.page({
 data:{months:months(),month:monthNow(),monthIndex:0,entries:[],loading:true,error:'',hasMore:false,offset:0,sheet:'',sheetClosing:false,detail:null,busy:false},
 ...community.sheetMethods,
 onLoad(){this._alive=true;this.load();},onUnload(){this._alive=false;clearTimeout(this._sheetTimer);},
 onShow(){if(this._loaded&&!this.data.loading&&!this.data.busy&&!this.data.sheet)this.load();},
 async onPullDownRefresh(){if(!this.data.busy)await this.load();wx.stopPullDownRefresh();},
 async load(more=false){
  if(more&&(this.data.loading||!this.data.hasMore)||this.data.busy)return;
  const seq=this._seq=(this._seq||0)+1,month=this.data.month;
  this.setData({loading:true,error:''});
  try{const result=await likes.api('listMine',{month,offset:more?this.data.offset:0});if(!this._alive||seq!==this._seq)return;
   const items=result.items.map(present);this._loaded=true;this.setData({entries:more?[...new Map(this.data.entries.concat(items).map(r=>[r.scheduleId+':'+r.id,r])).values()]:items,hasMore:result.hasMore,offset:result.offset});
  }catch(e){if(this._alive&&seq===this._seq)this.setData({error:e.message});}
  finally{if(this._alive&&seq===this._seq)this.setData({loading:false});}
 },
 retry(){this.load();},loadMore(){this.load(true);},
 changeMonth(e){if(this.data.busy||this.data.sheet)return;const i=this.data.monthIndex+Number(e.currentTarget.dataset.step);if(i<0||i>=this.data.months.length)return;this.setData({monthIndex:i,month:this.data.months[i],entries:[],offset:0,hasMore:false});this.load();},
 touchStart(e){const t=e.touches&&e.touches.length===1&&e.touches[0];this._touch=t&&!this.data.sheet&&!this.data.busy&&t.clientX>24?{x:t.clientX,y:t.clientY,time:e.timeStamp}:null;},
 touchMove(e){const t=e.touches&&e.touches[0],s=this._touch;if(s&&(!t||Math.abs(t.clientY-s.y)>18&&Math.abs(t.clientY-s.y)>Math.abs(t.clientX-s.x)))this._touch=null;},
 touchCancel(){this._touch=null;},
 touchEnd(e){const s=this._touch,t=e.changedTouches&&e.changedTouches[0];this._touch=null;if(s&&t&&e.timeStamp-s.time<650&&Math.abs(t.clientX-s.x)>64&&Math.abs(t.clientX-s.x)>Math.abs(t.clientY-s.y)*1.8)this.changeMonth({currentTarget:{dataset:{step:t.clientX<s.x?1:-1}}});},
 openRecord(e){const entry=this.data.entries.find(r=>r.id===e.currentTarget.dataset.id&&r.scheduleId===e.currentTarget.dataset.schedule);if(entry)this.openSheet('detail',{detail:entry});},
 async cancelLike(){
  if(this.data.busy||!this.data.detail||!this.data.detail.interactive)return;const item=this.data.detail;
  this.setData({busy:true,sheetError:''});
  try{const s=await likes.load(item.scheduleId,true),current=s.items.find(r=>r.id===item.id);
   if(!current||!current.interactive)throw Error('这期已停止点赞，请刷新查看最终数量');
   if(current.liked)await likes.setLike(item.scheduleId,item.id);
   if(!this._alive)return;this.setData({busy:false});this.finishSheet();await this.load();feedback.showToast(this,{title:'已取消点赞'});
  }catch(e){if(this._alive)this.setData({sheetError:e.message});}
  finally{if(this._alive)this.setData({busy:false});}
 },
 goPlaylist(){if(this.data.detail){const week=this.data.detail.weekKey;this.finishSheet();wx.navigateTo({url:'/pages/playlist/index?week='+week});}},
 goCurrent(){wx.navigateTo({url:'/pages/playlist/index'});}
})));
