const {cloudCall,storageKey}=require('./runtime');
const entries=new Map();
async function api(action,data={}){
 const response=await cloudCall({name:'manageSongLikes',data:{...data,action}}),r=response&&response.result;
 if(!r||!r.success){const e=Error(r&&r.message||'点赞服务暂不可用，请稍后重试');e.code=r&&r.code;throw e;}return r.data;
}
function state(id){const key=storageKey('likes_'+id);if(!entries.has(key))entries.set(key,{value:null,promise:null,listeners:new Set(),error:'',pending:new Set(),at:0});return entries.get(key);}
function emit(s){for(const fn of s.listeners)fn(s);}
function subscribe(id,fn){const s=state(id);s.listeners.add(fn);fn(s);return()=>s.listeners.delete(fn);}
async function load(id,force=false){
 const s=state(id);if(s.promise)return s.promise;
 if(!force&&s.value&&Date.now()-s.at<15000)return s.value;
 s.promise=api('getSchedule',{scheduleId:id}).then(value=>{if(!s.pending.size){s.value=value;s.at=Date.now();s.error='';}emit(s);return s.value;}).catch(e=>{s.error=e.message;if(e.code==='NOT_AVAILABLE')s.value=null;emit(s);throw e;}).finally(()=>{s.promise=null;});return s.promise;
}
async function setLike(scheduleId,itemId){
 const s=state(scheduleId);if(s.pending.has(itemId))return;
 if(s.promise)await s.promise;
 if(s.pending.has(itemId))return;
 const item=s.value&&s.value.items.find(row=>row.id===itemId);if(!item||!item.interactive||s.error)throw Error('请刷新歌单后再试');
 const desired=!item.liked,original={...item};s.pending.add(itemId);
 Object.assign(item,{liked:desired,count:item.count+(desired?1:-1)});emit(s);
 try{const value=await api('setLike',{scheduleId,itemId,liked:desired,version:original.version});Object.assign(item,value);s.at=Date.now();}
 catch(e){Object.assign(item,original);s.error=e.message;throw e;}
 finally{s.pending.delete(itemId);emit(s);}
}
module.exports={api,subscribe,load,setLike};
