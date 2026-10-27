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
