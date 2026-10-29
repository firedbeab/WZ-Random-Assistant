const test = require('node:test');
const assert = require('node:assert/strict');
const avoid = require('../../utils/keyboard-avoid');

test('输入框遮住时计算滚动距离，已在上方时不强制移动，顶部被导航遮挡可回退', () => {
  const height=800, keyboard=300, nav=88;
  const delta=avoid.scrollDelta({top:600,bottom:650},height,keyboard,nav);
  assert(delta>0); assert(650-delta<=height-keyboard-24);
  assert.equal(delta, 174);
  assert.equal(avoid.scrollDelta({top:135,bottom:185},height,keyboard,nav),0);
  assert.equal(avoid.scrollDelta({top:390,bottom:450},height,keyboard,nav),0);
  assert(avoid.scrollDelta({top:60,bottom:110},height,keyboard,nav)<0);
  assert.equal(avoid.scrollDelta(null,height,keyboard,nav),0);
});

test('只滚动当前聚焦的页面输入，异步查询在失焦后不会再次滚动', async () => {
  const page={_appearanceVisible:true,_keyboardHeight:300,_keyboardTarget:{selector:'#field',layer:'page'}};
  const calls=[]; let callback;
  const query={in(){return this;},select(){return this;},selectViewport(){return this;},boundingClientRect(){return this;},scrollOffset(){return this;},exec(cb){callback=cb;}};
  const wx={createSelectorQuery:()=>query,pageScrollTo:args=>calls.push(args)};
  avoid.schedule(page,wx,300,{height:800,nav:88});
  await new Promise(resolve=>setTimeout(resolve,125));
  assert.equal(typeof callback,'function');
  callback([{top:600,bottom:650},{scrollTop:150}]);assert.equal(calls.length,1);assert(calls[0].scrollTop>150);
  avoid.clear(page);page._keyboardTarget=null;callback([{top:600,bottom:650},{scrollTop:150}]);assert.equal(calls.length,1);
  page._keyboardTarget={selector:'#dialog',layer:'overlay'};avoid.schedule(page,wx,300,{height:800,nav:88});
  assert.equal(page._keyboardScrollTimers.length,0);
});
