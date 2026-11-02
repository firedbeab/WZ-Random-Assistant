const test=require('node:test'),assert=require('node:assert/strict');const {fixture}=require('./helpers/changelog-fixture');
const entry={action:'save',title:'新增点歌记录',summary:'更方便回看',content:'可以查看本人投稿与喜欢的歌曲。',version:'v1.9',releaseDate:'2026-11-01',images:[],newImageIDs:[],isPublished:true};
test('日志与旧说明隔离，只有正式超管可写，普通用户只看到发布内容及白名单字段',async()=>{
 const user=fixture('manageChangelog');assert.equal((await user.main({...entry})).code,'FORBIDDEN');assert.equal((await user.main({action:'getCapabilities'})).data.canEdit,false);
 user.state.rows.set('help_articles',[{_id:'help',title:'旧说明',is_published:true}]);user.state.rows.set('changelog_articles',[{_id:'published',title:'正式更新',is_published:true,version:'v1.9',release_date:'2026-11-01',created_by:'private-admin',images:[]},{_id:'draft',title:'不能公开',is_published:false}]);
 const r=await user.main({action:'listPublished'});assert.equal(r.data.length,1);assert.equal(r.data[0].version,'v1.9');assert(!JSON.stringify(r).includes('private-admin'));assert(!JSON.stringify(r).includes('旧说明'));assert.equal((await user.main({action:'listPublished',_testMode:true})).code,'TEST_ACCESS_DENIED');
});
test('共用说明编辑协议保存日志元数据，修订冲突阻止覆盖，发布失败不写，非法日期和跨目录图片被拒绝',async()=>{
 const f=fixture('manageChangelog',{role:'superadmin'});const created=await f.main({...entry});assert.equal(created.success,true);const id=created.data._id;const before=f.state.rows.get('changelog_articles')[0];assert.equal(before.revision,1);
 assert.equal((await f.main({...entry,articleId:id,revision:1,title:'第二次修改'})).success,true);assert.equal(f.state.rows.get('changelog_articles')[0].revision,2);assert.equal((await f.main({...entry,articleId:id,revision:1,title:'过期修改'})).code,'CONFLICT');assert.equal(f.state.rows.get('changelog_articles')[0].title,'第二次修改');
 assert.equal((await f.main({...entry,releaseDate:'2026-02-31'})).success,false);assert.equal((await f.main({...entry,images:['cloud://mock-env/help/a.jpg']})).success,false);
 f.state.safetyReject=true;assert.equal((await f.main({...entry,title:'不通过的修改',articleId:id,revision:2})).success,false);assert.equal(f.state.rows.get('changelog_articles')[0].title,'第二次修改');
});
test('日志按发布日期倒序，测试域不读正式域，不能给草稿图片或旧说明图片签名',async()=>{
 const f=fixture('manageChangelog',{role:'superadmin'});f.state.rows.set('changelog_articles',[{_id:'old',title:'旧日志',is_published:true,release_date:'2026-10-01'},{_id:'new',title:'新日志',is_published:true,release_date:'2026-11-01'}]);assert.equal((await f.main({action:'listPublished'})).data[0]._id,'new');assert.equal((await f.main({action:'listPublished',_testMode:true})).data.length,0);
 f.state.rows.set('changelog_articles',[{_id:'draft',is_published:false,images:['cloud://mock-env/changelog/a.jpg']}]);assert.equal((await f.main({action:'getImageAccess',fileIDs:['cloud://mock-env/changelog/a.jpg']})).code,'IMAGE_NOT_AVAILABLE');assert.equal((await f.main({action:'getImageAccess',fileIDs:['cloud://mock-env/help/a.jpg']})).code,'INVALID_IMAGE_REQUEST');
});
