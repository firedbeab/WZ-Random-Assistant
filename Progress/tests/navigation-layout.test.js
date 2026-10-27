const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { navigationLayout } = require('../../utils/navigation-layout');
const root = path.resolve(__dirname,'../..');

test('导航按设备状态栏和胶囊测量，标题两侧对称留出安全空间', () => {
  const iphone = navigationLayout({ windowWidth:390,statusBarHeight:47 },{ top:51,height:32,left:296 });
  assert.equal(iphone.statusHeight,47); assert.equal(iphone.totalHeight,87);
  assert.equal(iphone.sideWidth,102);
  const android = navigationLayout({ windowWidth:360,statusBarHeight:24 },{ top:32,height:32,left:264 });
  assert.equal(android.barHeight,48); assert.equal(android.totalHeight,72);
  assert.ok(android.sideWidth >= 96);
});
test('胶囊无效、无 API、刘海安全区及异常测量均有可用占位', () => {
  for(const [info, capsule] of [[null,null],[{},{}],[{statusBarHeight:NaN},{top:0,left:0,height:0}],[{statusBarHeight:10000},{top:-1,left:0,height:0}]]) {
    const value=navigationLayout(info,capsule);
    assert.ok(Number.isFinite(value.totalHeight) && value.totalHeight>=44 && value.totalHeight<=172);
    assert.ok(value.sideWidth>=76);
  }
  assert.equal(navigationLayout({safeArea:{top:59}}).statusHeight,59);
  assert.equal(navigationLayout({statusBarHeight:0}).statusHeight,0);
});
test('导航直接打开时回首页，正常页面栈返回，失败可退回首页', () => {
  let definition, depth=1;
  const calls=[];
  vm.runInNewContext(fs.readFileSync(path.join(root,'components/app-navigation/app-navigation.js'),'utf8'),{
    Component: value=>{definition=value;}, require:name=>name.endsWith('/theme')?require('../../utils/theme'):({navigationLayout}), getCurrentPages:()=>Array(depth).fill({}),
    wx:{ getWindowInfo:()=>({windowWidth:390,statusBarHeight:47}),getMenuButtonBoundingClientRect:()=>({top:51,height:32,left:296}),reLaunch:args=>calls.push(args.url),navigateBack:args=>{calls.push(args.delta);args.fail();} }
  });
  const component={data:{},setData(patch){Object.assign(this.data,patch);},...definition.methods};
  definition.lifetimes.attached.call(component);
  assert.equal(component.data.canGoBack,false);
  component.goBack(); assert.equal(calls.pop(),'/pages/index/index');
  depth=2; component.updateLayout(); assert.equal(component.data.canGoBack,true);
  component.goBack(); assert.deepEqual(calls,[1,'/pages/index/index']);
});
test('只在首页与歌单接入自定义导航，仍保留页面下拉刷新', () => {
  for(const page of ['index','playlist']) {
    const config=JSON.parse(fs.readFileSync(path.join(root,`pages/${page}/index.json`),'utf8'));
    assert.equal(config.navigationStyle,'custom'); assert.equal(config.enablePullDownRefresh,true);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'app.json'),'utf8')).window.navigationStyle,undefined);
});
