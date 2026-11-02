const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {fixture}=require('./helpers/transactional-cloud');
const root=path.resolve(__dirname,'../..');
const user={_id:'admin',openid:'admin',role:'superadmin'};
const schedule={_id:'s',status:'pending',week_key:'2026-11-01',revision:1,day1:[{submission_id:'a',song_name:'甲'},{submission_id:'b',song_name:'乙',audit_state:'pending_remove'}],day2:[],day3:[],day4:[],day5:[],total_count:2};
const seeds=()=>({users:{admin:user},schedules:{s:structuredClone(schedule)},submissions:{a:{_id:'a',status:'selected'},b:{_id:'b',status:'selected'}}});

test('有身份的测试管理员可以直接抽取，匿名转调仍拒绝且不放开正式定时源',async()=>{
 const seed={users:{admin:user},test_users:{admin:user},
  schedules:{formal:{_id:'formal',week_key:'2026-11-01',status:'published',day1:[]}},
  submissions:{formal:{_id:'formal',week_key:'2026-11-01',status:'pending'}},
  test_submissions:{a:{_id:'a',user_id:'tester',status:'pending',week_key:'2026-11-01',song_name:'测试内容',submit_time:new Date('2026-11-01T02:00:00Z')}}};
 const f=fixture('drawWeeklyPlaylist',seed);const original=structuredClone({schedules:f.state.rows.schedules,submissions:f.state.rows.submissions});
 assert.equal((await f.main({_testMode:true})).success,true);assert.equal(Object.keys(f.state.rows.test_schedules).length,1);
 assert.equal(f.state.rows.test_submissions.a.status,'selected');assert.deepEqual({schedules:f.state.rows.schedules,submissions:f.state.rows.submissions},original);
 const anonymous=fixture('drawWeeklyPlaylist',seed,{owner:null,source:'wx_cloud_function'});
 assert.equal((await anonymous.main({_testMode:true})).code,'FORBIDDEN');assert.equal(anonymous.state.requests.length,0);
 const ordinary=fixture('drawWeeklyPlaylist',{...seed,users:{admin:{...user,role:'user'}},test_users:{admin:{...user,role:'user'}}});
 assert.equal((await ordinary.main({_testMode:true})).success,false);assert.equal(ordinary.state.commits,0);
});
test('七个文本入口只接受明确通过，异常与缺失结果不放行，测试域不消耗正式检查',async()=>{
 const names=['checkWeeklyCode','adminAuditPlaylist','manageHelpContent','manageChangelog','superAdminConsole','manageFeedback','manageEasterEggs'];
 const helpers=names.map(n=>fs.readFileSync(path.join(root,'cloudfunctions',n,'index.js'),'utf8').split('// END shared text safety.')[0]);
 assert(helpers.every(s=>s===helpers[0]));
 let calls=0;const box={console:{warn(){}},cloud:{openapi:{security:{async msgSecCheck(){calls++;return box.response;}}}}};vm.createContext(box);vm.runInContext(helpers[0]+';this.check=checkTextSafety',box);
 for(const suggest of ['pass','risky','review',undefined]){box.response={result:{suggest}};const r=await box.check(box.cloud,'user','普通文案',false);assert.equal(r.passed,suggest==='pass');assert.equal(r.unavailable,suggest===undefined);}
 box.response={errCode:-604101,result:{suggest:'pass'}};assert.equal((await box.check(box.cloud,'user','文案')).passed,false);
 const before=calls;assert.equal((await box.check(box.cloud,'user','文案',true)).passed,true);assert.equal(calls,before);
 box.cloud.openapi.security.msgSecCheck=async()=>{throw {errCode:-604101,message:'private input'};};const fail=await box.check(box.cloud,'user','文案');assert.equal(fail.code,'SAFETY_UNAVAILABLE');assert(!JSON.stringify(fail).includes('private input'));
});
test('发布说明检查报错/复核/缺失结果时不发布，不修改任何投稿',async()=>{
 for(const status of ['throw','risky','review','missing']){const f=fixture('adminAuditPlaylist',seeds());f.state.safety=status;const r=await f.main({action:'publish',playlistId:'s',revision:1,note:'广播站说明'});assert.equal(r.success,false);assert.equal(f.state.commits,0);assert.equal(f.state.rows.schedules.s.status,'pending');assert.equal(f.state.rows.submissions.b.status,'selected');}
});
test('审核发布和跳过日期的每条投稿更新都属于事务，中途失败全部回滚',async()=>{
 for(const action of ['publish','skipDay']){const f=fixture('adminAuditPlaylist',seeds());f.state.failId='b';const r=await f.main({action,playlistId:'s',revision:1,dayIndex:0,note:'说明'});assert.equal(r.success,false);assert.equal(f.state.rows.schedules.s.status,'pending');assert.equal(f.state.rows.schedules.s.day1.length,2);assert.equal(f.state.rows.submissions.a.status,'selected');assert.equal(f.state.rows.submissions.b.status,'selected');assert(!f.state.requests.some(r=>r.transaction&&r.kind==='update'&&!r.id));}
 const f=fixture('adminAuditPlaylist',seeds());const r=await f.main({action:'publish',playlistId:'s',revision:1,note:'说明'});assert.equal(r.success,true);assert.equal(f.state.rows.submissions.b.status,'rejected');assert.equal(f.state.rows.schedules.s.day1.length,1);
});
test('安全自检仅正式超管可调用，测试标记不绕过真实检查；无业务写入',async()=>{
 for(const name of ['checkWeeklyCode','adminAuditPlaylist','manageHelpContent','manageChangelog','superAdminConsole','manageEasterEggs']){const f=fixture(name,{users:{admin:user}});const r=await f.main({action:'checkTextSafety',_testMode:true,content:'普通文案'});assert.equal(r.data.passed,true,name);assert.equal(f.state.commits,0);assert(!f.state.requests.some(r=>['set','add','update','remove'].includes(r.kind)));f.state.owner='ordinary';assert.equal((await f.main({action:'checkTextSafety',content:'普通文案'})).code,'FORBIDDEN');}
});
test('测试验证码只写测试域且整组原子生成，正式域保持不变，重复生成不追加',async()=>{
 const f=fixture('autoGenerateWeeklyCode',{users:{admin:user},test_users:{admin:user},weekly_codes:{old:{_id:'old',week_key:'2026-10-25',code:'OLD123'}}});
 const original=structuredClone(f.state.rows.weekly_codes);const r=await f.main({_testMode:true});assert.equal(r.success,true);assert.deepEqual(f.state.rows.weekly_codes,original);assert.equal(Object.keys(f.state.rows.test_weekly_codes).length,3);assert.equal((await f.main({_testMode:true})).success,false);assert.equal(Object.keys(f.state.rows.test_weekly_codes).length,3);assert(!JSON.stringify(f.state.logs).includes(Object.values(f.state.rows.test_weekly_codes)[0].code));
 const broken=fixture('autoGenerateWeeklyCode',{users:{admin:user}});broken.state.failCommit=true;assert.equal((await broken.main({})).success,false);assert.equal(Object.keys(broken.state.rows.weekly_codes||{}).length,0);
});
test('无身份不能伪造定时任务；平台定时源只操作正式域',async()=>{
 const f=fixture('autoGenerateWeeklyCode',{}, {owner:null,source:'wx_client'});assert.equal((await f.main({Type:'Timer',SOURCE:'wx_trigger'})).success,false);assert.equal(f.state.requests.length,0);
 f.state.source='wx_trigger';assert.equal((await f.main({})).success,true);assert.equal(Object.keys(f.state.rows.weekly_codes).length,3);assert.equal((await f.main({_testMode:true})).success,false);
 const draw=fixture('drawWeeklyPlaylist',{}, {owner:null,source:'wx_client'});assert.equal((await draw.main({Type:'Timer'})).code,'FORBIDDEN');assert.equal(draw.state.requests.length,0);
});
test('同周两次抽取只生成一份，入选记录均事务更新，失败不留半份排期',async()=>{
 const seed={users:{admin:user},submissions:{a:{_id:'a',status:'pending',week_key:'2026-11-01',song_name:'新歌',singer:'歌手',user_id:'u',submit_time:new Date('2026-11-01T02:00:00Z')}}};
 const f=fixture('drawWeeklyPlaylist',seed);const results=await Promise.all([f.main({}),f.main({})]);assert.equal(results.filter(r=>r.success).length,1);assert.equal(Object.keys(f.state.rows.schedules||{}).length,1);assert.equal(f.state.rows.submissions.a.status,'selected');assert(!f.state.requests.some(r=>r.transaction&&r.kind==='update'&&!r.id));
 const bad=fixture('drawWeeklyPlaylist',seed);bad.state.failId='a';assert.equal((await bad.main({})).success,false);assert.equal(Object.keys(bad.state.rows.schedules||{}).length,0);assert.equal(bad.state.rows.submissions.a.status,'pending');
});
