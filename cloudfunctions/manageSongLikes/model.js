const crypto = require('crypto');
const hash = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const DAY = 86400000;
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value && d.getUTCDay() === 0;
}
function recentWeeks(now) {
  const d = new Date(now + 8 * 3600000); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-d.getUTCDay());
  return [0,1,2].map(n=>new Date(d.getTime()-n*7*DAY).toISOString().slice(0,10));
}
function expiresAt(week) {
  if (!dateKey(week)) return 0;
  const d=new Date(week+'T00:00:00Z'), day=d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth()+6);
  const end=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
  d.setUTCDate(Math.min(day,end)); return d.getTime()-8*3600000;
}
function items(schedule) {
  const result=[];
  for(let day=1;day<=5;day++) (Array.isArray(schedule['day'+day])?schedule['day'+day]:[]).forEach((song,index)=>{
    if(!song || typeof song.song_name!=='string' || !song.song_name) return;
    // Legacy rows use content identity; repeated indistinguishable rows are not
    // writable. Neither position nor editable notes form part of the identity.
    const source=song.submission_id || song._id;
    const id=hash('song-v1',schedule._id,source?['submission',source,song.song_name,song.singer||'']:['legacy',song.song_name,song.singer||'']);
    result.push({id,row:day+'-'+index,title:song.song_name,singer:song.singer||'',note:song.special_note||'',day,index});
  });
  return result.map(item=>({...item,ambiguous:result.filter(other=>other.id===item.id).length!==1}));
}
module.exports={hash,dateKey,recentWeeks,expiresAt,items};
