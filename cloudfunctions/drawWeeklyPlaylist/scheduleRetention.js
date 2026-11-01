function expiry(week){
 if(typeof week!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(week))return Infinity;
 const d=new Date(week+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==week)return Infinity;
 const day=d.getUTCDate();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+6);
 d.setUTCDate(Math.min(day,new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate()));return d.getTime()-8*3600000;
}
async function cleanupSchedules({db,command,collection,keepKeys,fetchAll,removeAllMatching,now=Date.now()}){
 // Published archives live longer; pending/candidate rules remain unchanged.
 const published=await fetchAll(collection,{status:'published',week_key:command.nin(keepKeys)});
 const ids=published.filter(s=>expiry(s.week_key)<=now).map(s=>s._id);
 let removed=0;
 for(let i=0;i<ids.length;i+=100){const res=await db.collection(collection).where({_id:command.in(ids.slice(i,i+100)),status:'published'}).remove();removed+=res.stats.removed;}
 return removed+await removeAllMatching(collection,{status:command.neq('published'),week_key:command.nin(keepKeys)});
}
async function cleanupSubmissions({db,command,collection,fetchAll,now=Date.now()}){
 // Read only potentially expired periods; candidate queries still select the
 // current week and previous two weeks explicitly, independent of storage.
 const cutoff=new Date(now+8*3600000);cutoff.setUTCDate(1);cutoff.setUTCMonth(cutoff.getUTCMonth()-5);
 const old=await fetchAll(collection,{week_key:command.lt(cutoff.toISOString().slice(0,10))});
 const ids=old.filter(r=>expiry(r.week_key)<=now).map(r=>r._id);let removed=0;
 for(let i=0;i<ids.length;i+=100){const r=await db.collection(collection).where({_id:command.in(ids.slice(i,i+100))}).remove();removed+=r.stats.removed;}
 return removed;
}
module.exports={expiry,cleanupSchedules,cleanupSubmissions};
