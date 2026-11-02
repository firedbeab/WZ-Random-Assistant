const { mondayDateText } = require('./period-label');
const date=value=>new Date(value+8*3600000).toISOString().slice(0,10).replace(/-/g,'.');
function present(item,tab){
 const liked=tab==='likes',timestamp=liked?item.likedAt:item.submittedAt,d=date(timestamp);
 return {...item,date:d,day:d.slice(-2),month:d.slice(5,7),period:mondayDateText(item.weekKey)+'期',placement:item.placement?{...item.placement,periodDate:mondayDateText(item.placement.weekKey)}:item.placement,others:liked?Math.max(0,item.count-1):0,kind:tab,recordKey:liked?item.scheduleId+':'+item.id:item.id};
}
function groups(entries,expanded={},tab='likes'){
 const map=new Map();for(const row of entries){if(!map.has(row.date))map.set(row.date,[]);map.get(row.date).push(row);}
 return [...map].map(([key,rows])=>({key,day:rows[0].day,month:rows[0].month,first:tab==='likes'?rows.slice(0,2):rows,rest:tab==='likes'?rows.slice(2):[],expanded:!!expanded[key]}));
}
module.exports={present,groups};
