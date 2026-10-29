const test=require('node:test'),assert=require('node:assert/strict');
const colors=require('../../utils/color-palette'),theme=require('../../utils/theme');
test('预设及极端自定义种子均生成两套可读品牌色和底色，业务状态色保持固定',()=>{
  for(const seed of [...Object.values(colors.PRESETS),'#ffffff','#000000','#ffff00','#0000ff','#00ff00','#808080','#ff00ff'])for(const mode of ['light','dark']){
    const t=theme.getTokens(mode,'custom',seed),base=theme.getTokens(mode);
    for(const background of ['bg','surface','surface-2','accent-weak','on-accent'])assert(colors.contrast(t.accent,t[background])>=4.5,`${seed} ${mode} ${background}`);
    for(const key of ['success','danger','warn'])assert.equal(t[key],base[key]);
    for(const text of ['text-1','text-2','text-3','placeholder'])for(const bg of ['bg','surface','surface-2','input-focused'])assert(colors.contrast(t[text],t[bg])>=4.5,`${seed} ${mode} ${text}/${bg}`);
    assert.notEqual(t['gradient-open-start'],t.bg);
  }
});
test('色盘 HSV 往返、输入校验和非法主题拒绝；保存与后续切换可保留自定义种子',()=>{
  for(const hex of Object.values(colors.PRESETS).concat('#000000','#ffffff','#ff0088')){const v=colors.hexToHsv(hex);assert.equal(colors.hsvToHex(v.h,v.s,v.v),hex);}
  assert.equal(colors.normalize('#FF00AA'),'#ff00aa');assert.equal(colors.normalize('red;--bg:black'),'');
  assert.equal(theme.setPreference({mode:'dark',palette:'custom',customColor:'#ffffff'}),true);assert.equal(theme.getState().customColor,'#ffffff');
  assert.equal(theme.setPreference({mode:'light'}),true);assert.equal(theme.getState().palette,'custom');
  assert.equal(theme.setPreference({mode:'dark',palette:'custom',customColor:'bad'}),false);
  theme.setPreference({mode:'system',palette:'green'});
});
test('深色主题尽可能保留自定义色的色相，不把高饱和颜色统一混成灰白色',()=>{
  for(const seed of ['#4268af','#a56b28','#916098','#9f2925','#00c8d7','#ff00ff']){
    const original=colors.hexToHsv(seed), t=theme.getTokens('dark','custom',seed), actual=colors.hexToHsv(t.accent);
    const distance=Math.min(Math.abs(original.h-actual.h),360-Math.abs(original.h-actual.h));
    assert(distance<2,`${seed} hue changed ${distance}`);assert(actual.s>=.3,`${seed} faded to grey`);
    assert(colors.contrast(t.accent,t.surface)>=4.5);assert(colors.contrast(t.accent,t['on-accent'])>=4.5);
  }
  for(const seed of ['#000000','#ffffff','#808080'])assert(colors.hexToHsv(theme.getTokens('dark','custom',seed).accent).s<.01);
});
test('非绿色深色主题的背景和卡片体现所选色相，灰色种子仍保持中性',()=>{
  const channel=h=>h.slice(1).match(/../g).map(x=>parseInt(x,16));
  for(const seed of ['#9f2925','#ff0000','#450909']){
    const t=theme.getTokens('dark','custom',seed);for(const key of ['bg','surface']){const [r,g,b]=channel(t[key]);assert(r>g+5&&r>b+5,`${seed} ${key} lacks red tint`);}
  }
  for(const seed of ['#4268af','#0055ff','#092045']){
    const t=theme.getTokens('dark','custom',seed);for(const key of ['bg','surface']){const [r,g,b]=channel(t[key]);assert(b>r+5&&b>g+3,`${seed} ${key} lacks blue tint`);}
  }
  for(const seed of ['#000000','#ffffff','#808080']){
    const [r,g,b]=channel(theme.getTokens('dark','custom',seed).surface);assert(Math.max(r,g,b)-Math.min(r,g,b)<=3);
  }
});
