// Display-only fixtures for native simulator screenshots. Never submit or persist these records.
const my = require('../utils/my-presentation');
const home = require('../utils/home-presentation');
const weekKey='2026-10-25';
const submission={_id:'screenshot-example',song_name:'稻香',singer:'周杰伦',special_note:'希望播放原版，送给认真生活的每一个人。'};
const schedule={week_key:weekKey,day1:[{...submission,submission_id:submission._id},{song_name:'海阔天空',singer:'Beyond'},{song_name:'平凡之路',singer:'朴树'},{song_name:'晴天',singer:'周杰伦'}]};
const homeBase={statusReady:true,statusError:false,canSubmit:false,hasSubmitted:false,schedulePublished:false,channelForceClosed:false,beforeOpening:false,scheduleLoadFailed:false,totalSubmissions:0,nextOpenText:'11 月 1 日 周日 8:00',hoursLeftText:'',previewSongs:[],previewTotal:0,previewWeekText:'',statusMsg:'',loading:false,focusedField:'',weeklyCode:'',title:'',remark:'',specialNote:'',userInfo:{role:'user'}};
const homeStates=[
 ['loading','首次读取',{statusReady:false}],['error','状态读取失败',{statusReady:false,statusError:true}],
 ['before-open','周日开放前',{beforeOpening:true,nextOpenText:'10 月 25 日 周日 8:00'}],
 ['open','通道开放・尚未提交',{canSubmit:true,hoursLeftText:'还剩 5 小时',totalSubmissions:36}],
 ['temporary-open','管理员临时开放',{canSubmit:true,totalSubmissions:36}],
 ['submitted-open','已提交・通道开放',{canSubmit:true,hasSubmitted:true,totalSubmissions:37,...home.submissionView(submission)}],
 ['submitted-closed','已提交・等待发布',{hasSubmitted:true,totalSubmissions:37,...home.submissionView(submission)}],
 ['closed','本周结束・尚未发布',{}],
 ['force-closed','管理员临时关闭',{channelForceClosed:true,nextOpenText:'通道暂时关闭，恢复时间待定'}],
 ['schedule-error','歌单读取失败',{scheduleLoadFailed:true}],
 ['published','歌单已发布',{schedulePublished:true,...home.schedulePreview(schedule)}],
 ['published-empty','已发布・暂无曲目',{schedulePublished:true,...home.schedulePreview({week_key:weekKey})}],
 ['published-short','已发布・不足四首',{schedulePublished:true,...home.schedulePreview({week_key:weekKey,day1:schedule.day1.slice(0,2)})}]
].map(([id,label,patch])=>({page:'home',route:'/pages/index/index',id,label,patch:{...homeBase,...patch}}));
const period={weekKey,open:false,nextOpen:'11 月 1 日 周日 8:00'};
const myStates=[
 ['loading','首次读取',my.loading(),null],['error','读取失败',my.failed(),null],
 ...[false,true].flatMap(open=>[false,true].map(submitted=>[open?(submitted?'submitted-open':'open'):(submitted?'submitted-closed':'closed'),open?(submitted?'已提交・通道开放':'尚未提交・通道开放'):(submitted?'已提交・通道关闭':'暂无本周记录'),my.state({period:{...period,open},submission:submitted?submission:null,schedule:null}),submitted?submission:null])),
 ['published-included','已发布・本人入选',my.state({period,submission,schedule}),submission],
 ['published-other','已发布・本人未列入',my.state({period,submission,schedule:{week_key:weekKey}}),submission],
 ['published-no-record','已发布・无个人记录',my.state({period,submission:null,schedule}),null]
].map(([id,label,week,record])=>({page:'my',route:'/pages/my/index',id,label,patch:{week,submission:record,loading:id==='loading',alias:'点歌同学',firstUseText:'首次使用 · 2026.10.05',profileReady:true,error:'',refreshError:'',sheet:'',aliasVisible:false}}));
const fixtures=[...homeStates,...myStates].flatMap(state=>['light','dark'].map(mode=>({...state,mode,file:state.page+'-'+mode+'-'+state.id+'.jpg'})));
if(require.main===module){const fs=require('fs'),path=require('path');const out=process.argv[2];if(!out)throw Error('Specify an external output directory');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(fixtures,null,2));for(let i=0;i<fixtures.length;i++)fs.writeFileSync(path.join(out,'fixture-'+i+'.json'),JSON.stringify([fixtures[i]]));console.log(fixtures.length+' display-only states prepared');}
module.exports=fixtures;
