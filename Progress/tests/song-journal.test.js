const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const journal=require('../../utils/song-journal');
const like=(id,time=Date.parse('2026-11-01T02:00:00Z'))=>({id,scheduleId:'s',weekKey:'2026-10-25',likedAt:time,title:id,count:3,interactive:true});
test('同日多首仅展示两首，共用一个日期；分页追加仍归入同组，跨日分组',()=>{
 const entries=[like('a'),like('b'),like('c'),like('d',Date.parse('2026-10-31T15:00:00Z'))].map(r=>journal.present(r,'likes'));
 const groups=journal.groups(entries,{},'likes');assert.equal(groups.length,2);assert.equal(groups[0].first.length,2);assert.equal(groups[0].rest.length,1);assert.equal(groups[0].expanded,false);assert.equal(journal.groups(entries,{'2026.11.01':true},'likes')[0].expanded,true);
 const paged=journal.groups(entries.concat(journal.present(like('e'),'likes')),{},'likes');assert.equal(paged.length,2);assert.equal(paged[0].rest.length,2);
});
function fixture(){let def;const resolvers=[];const requests=[],state={confirm:false,writes:0};const common=require('../../utils/community');vm.runInNewContext(fs.readFileSync(require('path').join(__dirname,'../../pages/likes/index.js'),'utf8'),{Page:d=>def=d,Date,Map,Number,Math,wx:{stopPullDownRefresh(){},navigateTo(){}},setTimeout,clearTimeout,require:name=>name.includes('theme')?{page:x=>x}:name.includes('admin-feedback')?{page:x=>x,showModal:async()=>({confirm:state.confirm}),showToast(){}}:name.includes('community')?common:name.includes('song-journal')?journal:{api(action){requests.push(action);return new Promise(r=>resolvers.push(r));},async load(){return {items:[{id:'a',interactive:true,liked:true}]};},async setLike(){state.writes++;}}});const page={...def,data:structuredClone(def.data),setData(p){Object.assign(this.data,p);}};return{page,state,requests,resolve(result,index=1){resolvers[index](result);}};}
test('快速切换时旧投稿响应不能覆盖喜欢列表；取消确认前不发送写入',async()=>{
 const f=fixture(),p=f.page;p.onLoad();p.switchTab({currentTarget:{dataset:{tab:'likes'}}});f.resolve({items:[like('a')],offset:1,hasMore:false});await new Promise(r=>setImmediate(r));assert.equal(p.data.tab,'likes');assert.equal(p.data.entries[0].kind,'likes');assert.equal(p.data.groups.length,1);f.resolve({items:[],offset:0,hasMore:false},0);await new Promise(r=>setImmediate(r));assert.equal(p.data.entries[0].kind,'likes');
 p.setData({sheet:'detail',detail:p.data.entries[0]});await p.cancelLike();assert.equal(f.state.writes,0);assert.equal(p.data.sheet,'detail');assert.equal(p.data.busy,false);p.onUnload();
});
