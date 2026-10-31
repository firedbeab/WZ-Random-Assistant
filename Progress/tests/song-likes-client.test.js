const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function fixture(){const calls=[],state={handler:async action=>action==='getSchedule'?{scheduleId:'s',items:[{id:'a',row:'1-0',title:'稻香',singer:'周杰伦',count:2,liked:false,interactive:true,version:0}]}:{id:'a',count:3,liked:true,interactive:true,version:1}};
 const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../utils/song-likes.js'),'utf8'),{module,Date,Map,Set,Error,require:()=>({storageKey:s=>s,async cloudCall({data}){calls.push(data);return {result:{success:true,data:await state.handler(data.action,data)}};}})});return {...module.exports,calls,state};}
test('整期请求去重，乐观即时更新，失败还原；旧读请求与点赞不并发改显示',async()=>{
 const f=fixture();let latest;const releases=Array.from({length:20},()=>f.subscribe('s',s=>latest=s));await Promise.all(Array.from({length:20},()=>f.load('s')));assert.equal(f.calls.length,1);
 let finish;f.state.handler=()=>new Promise(resolve=>finish=resolve);const pending=f.setLike('s','a');assert.equal(latest.value.items[0].liked,true);assert.equal(latest.value.items[0].count,3);await f.setLike('s','a');assert.equal(f.calls.filter(c=>c.action==='setLike').length,1);
 finish({id:'a',count:3,liked:true,version:1,interactive:true});await pending;
 f.state.handler=()=>{throw Error('网络断开');};await assert.rejects(f.setLike('s','a'));assert.equal(latest.value.items[0].liked,true);assert.equal(latest.value.items[0].count,3);assert.equal(latest.pending.size,0);releases.forEach(release=>release());
});
test('等待读取期间的重复点击不会并发生成相反操作',async()=>{
 const f=fixture();let resolveRead;f.state.handler=action=>action==='getSchedule'?new Promise(resolve=>resolveRead=resolve):new Promise(()=>{});
 const loading=f.load('s');const a=f.setLike('s','a'),b=f.setLike('s','a');resolveRead({items:[{id:'a',liked:false,count:0,version:0,interactive:true}]});await loading;await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.filter(c=>c.action==='setLike').length,1);void a;void b;
});
