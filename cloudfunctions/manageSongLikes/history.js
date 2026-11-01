const {expiresAt}=require('./model');
const millis=value=>value instanceof Date?value.getTime():value&&value.$date?new Date(value.$date).getTime():Number(value);
const shift=(week,n)=>new Date(Date.parse(week+'T00:00:00Z')+n*7*86400000).toISOString().slice(0,10);
async function listSubmissions({db,scope,owner,event,now}){
 const offset=event.offset===undefined?0:event.offset;
 if(!Number.isInteger(offset)||offset<0||offset>10000||typeof event.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(event.month)){
  const e=Error('月份或翻页参数无效');e.code='INVALID_INPUT';throw e;
 }
 const from=new Date(event.month+'-01T00:00:00+08:00'),end=new Date(from.getTime()+8*3600000);end.setUTCMonth(end.getUTCMonth()+1);
 const result=await db.collection(scope.collection('submissions')).where({user_id:owner,submit_time:db.command.gte(from).and(db.command.lt(new Date(end.getTime()-8*3600000)))}).orderBy('submit_time','desc').orderBy('_id','desc').skip(offset).limit(21).get();
 const page=result.data.slice(0,20).filter(r=>expiresAt(r.week_key)>now&&Number.isFinite(millis(r.submit_time)));
 // The original submission and the following two candidate weeks are the only
 // periods in which this request can be selected. Never infer selection from
 // a pending draft, or expose another student's request/identity.
 const weeks=[...new Set(page.flatMap(r=>[0,1,2].map(n=>shift(r.week_key,n))))];
 const schedules=weeks.length?(await db.collection(scope.collection('schedules')).where({status:'published',week_key:db.command.in(weeks)}).limit(100).get()).data:[];
 const items=page.map(r=>{
  const placements=[];
  for(const s of schedules)for(let d=1;d<=5;d++)if((s['day'+d]||[]).some(song=>song.submission_id===r._id))placements.push({weekKey:s.week_key,day:d});
  placements.sort((a,b)=>a.weekKey.localeCompare(b.weekKey)||a.day-b.day);
  const placement=placements[0],waiting=shift(r.week_key,3)>new Date(now+8*3600000).toISOString().slice(0,10);
  const statusLabel=placement?'已入选':r.status==='overflow'?'未进入候选':waiting?'等待结果':'未见入选记录';
  return {id:r._id,title:r.song_name||'',singer:r.singer||'',note:r.special_note||'',submittedAt:millis(r.submit_time),weekKey:r.week_key,statusLabel,placement:placement||null};
 });
 return {items,hasMore:result.data.length>20,offset:offset+Math.min(20,result.data.length)};
}
module.exports={listSubmissions};
