const {hash,dateKey,recentWeeks,expiresAt,items}=require('./model');
const {listSubmissions}=require('./history');
const fail=(message,code='INVALID_INPUT')=>{const e=Error(message);e.code=code;throw e;};
const validId=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);
function createService({db,createDataScope,canUseTestData,now=Date.now}){
 return async(event={},owner)=>{
  if(!owner)return {success:false,code:'UNAUTHENTICATED',message:'无法确认用户身份'};
  const scope=createDataScope(event),col=(name,conn=db)=>conn.collection(scope.collection(name));
  const read=async(name,id,conn=db)=>(await col(name,conn).doc(id).get()).data;
  const usable=s=>s&&s.status==='published'&&dateKey(s.week_key)&&expiresAt(s.week_key)>now();
  const interactive=s=>recentWeeks(now()).includes(s.week_key);
  const count=(s,id)=>{const value=s.like_counts_v1&&s.like_counts_v1[id];if(value===undefined)return 0;if(!Number.isSafeInteger(value)||value<0)fail('点赞统计暂时异常，请稍后刷新','COUNT_INVALID');return value;};
  const view=(s,item,record)=>({id:item.id,row:item.row,title:item.title,singer:item.singer,count:count(s,item.id),liked:!!(record&&record.active),version:record&&record.version||0,interactive:interactive(s)&&!item.ambiguous});
  try{
   if(!await canUseTestData(db,owner,scope))fail('测试数据仅限测试账号访问','TEST_ACCESS_DENIED');
   if(event.action==='listSubmissions')return {success:true,data:await listSubmissions({db,scope,owner,event,now:now()})};
   if(event.action==='getSchedule'){
    if(!validId(event.scheduleId))fail('歌单标识无效');
    const s=await read('schedules',event.scheduleId);if(!usable(s))fail('这期歌单已撤回或不在保留范围内','NOT_AVAILABLE');
    const own=await col('song_likes').where({owner,schedule_id:s._id}).limit(100).get();
    return {success:true,data:{scheduleId:s._id,weekKey:s.week_key,interactive:interactive(s),expiresAt:expiresAt(s.week_key),items:items(s).map(item=>view(s,item,own.data.find(r=>r.item_id===item.id)))}};
   }
   if(event.action==='setLike'){
    if(!validId(event.scheduleId)||typeof event.itemId!=='string'||!/^\w{64}$/.test(event.itemId)||typeof event.liked!=='boolean'||!Number.isSafeInteger(event.version)||event.version<0)fail('点赞参数无效，请刷新歌单');
    const tx=await db.startTransaction();let result;
    try{
     const s=await read('schedules',event.scheduleId,tx);
     if(!usable(s))fail('这期歌单已撤回或不在保留范围内','NOT_AVAILABLE');
     if(!interactive(s))fail('仅最新一期和前两期歌单可以点赞或取消','LIKES_CLOSED');
     const item=items(s).find(item=>item.id===event.itemId&&!item.ambiguous);
     if(!item)fail('曲目已被调整，请刷新歌单后重试','SONG_CHANGED');
     const key=hash(owner,s._id,item.id),old=await read('song_likes',key,tx),version=old&&old.version||0;
     // Matching retries are idempotent; an old request cannot undo a later
     // decision because an opposite current state requires the exact version.
     if(!!(old&&old.active)===event.liked){result=view(s,item,old);}
     else{
      if(version!==event.version)fail('点赞状态已更新，请刷新后再试','CONFLICT');
      const next=count(s,item.id)+(event.liked?1:-1);if(next<0)fail('统计暂时异常，请稍后再试','COUNT_INVALID');
      await col('schedules',tx).doc(s._id).update({data:{['like_counts_v1.'+item.id]:next}});
      const record={owner,schedule_id:s._id,item_id:item.id,active:event.liked,version:version+1,liked_at:event.liked?now():old.liked_at,expires_at:expiresAt(s.week_key)};
      await col('song_likes',tx).doc(key).set({data:record});
      result={...view(s,item,record),count:next};
     }
     await tx.commit();
    }catch(e){try{await tx.rollback();}catch(_){}throw e;}
    return {success:true,data:result};
   }
   if(event.action==='listMine'){
    const offset=event.offset===undefined?0:event.offset;
    if(!Number.isInteger(offset)||offset<0||offset>10000||typeof event.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.month))fail('月份或翻页参数无效');
    const from=Date.parse(event.month+'-01T00:00:00+08:00'),end=new Date(from+8*3600000);end.setUTCMonth(end.getUTCMonth()+1);
    const where={owner,active:true,liked_at:db.command.gte(from).and(db.command.lt(end.getTime()-8*3600000))};
    const rows=await col('song_likes').where(where).orderBy('liked_at','desc').orderBy('_id','desc').skip(offset).limit(21).get();
    const page=rows.data.slice(0,20),ids=[...new Set(page.map(r=>r.schedule_id))];
    const schedules=ids.length?(await col('schedules').where({_id:db.command.in(ids),status:'published'}).limit(20).get()).data:[];
    const entries=page.flatMap(r=>{
     const s=schedules.find(s=>s._id===r.schedule_id);if(!usable(s))return [];
     const item=items(s).find(item=>item.id===r.item_id&&!item.ambiguous);if(!item)return [];
     return [{...view(s,item,r),scheduleId:s._id,weekKey:s.week_key,likedAt:r.liked_at,expiresAt:expiresAt(s.week_key)}];
    });
    return {success:true,data:{items:entries,hasMore:rows.data.length>20,offset:offset+page.length}};
   }
   fail('未知操作');
  }catch(e){return {success:false,code:e.code||'SERVICE_UNAVAILABLE',message:e.code?e.message:'点赞服务暂不可用，请稍后刷新重试'};}
 };
}
module.exports={createService};
