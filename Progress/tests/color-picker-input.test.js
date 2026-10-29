const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){
 let definition;const events=[];
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../../components/color-picker/color-picker.js'),'utf8'),{
  Component(value){definition=value;},require(name){return name.includes('theme')?{component:value=>value}:require('../../utils/color-palette');},
  Date,setTimeout,clearTimeout
 });
 const picker={...definition.methods,data:structuredClone(definition.data),properties:{value:'#28764f'},setData(patch){Object.assign(this.data,patch);},triggerEvent(name,detail){events.push({name,detail});}};
 picker.applyHex('#28764f');return {picker,events};
}
test('输入带或不带 # 的六位 RGB 色值会立即发出规范化颜色，大小写均可',()=>{
 const {picker,events}=fixture();picker.input({detail:{value:'256C71'}});assert.equal(picker.data.hex,'#256c71');assert.equal(picker.data.field,'#256c71');assert.equal(events.at(-1).detail.value,'#256c71');
 picker.input({detail:{value:'#AABBCC'}});assert.equal(picker.data.hex,'#aabbcc');assert.equal(events.at(-1).detail.value,'#aabbcc');
});
test('未填完整的色值不会误改主题，失焦时保留用户输入并明确提示',()=>{
 const {picker,events}=fixture();picker.input({detail:{value:'#12'}});assert.equal(picker.data.hex,'#28764f');assert.equal(events.length,0);
 picker.blur();assert.equal(picker.data.field,'#12');assert.equal(picker.data.invalid,true);assert.equal(events.filter(e=>e.name==='change').length,0);
 picker.input({detail:{value:'123456'}});assert.equal(picker.data.invalid,false);assert.equal(picker.data.hex,'#123456');
});
test('滑块两端及色盘角落能达到完整取值范围',()=>{
 const {picker}=fixture();picker._rect={left:10,top:20,width:300,height:120};picker._kind='hue';
 picker.movePoint({clientX:10,clientY:50});assert.equal(picker.data.hue,0);
 picker.movePoint({clientX:310,clientY:50});assert(picker.data.hue>359);
 picker._kind='plane';picker.movePoint({clientX:10,clientY:20});assert.equal(picker.data.sat,0);assert.equal(picker.data.val,0);
 picker.movePoint({clientX:310,clientY:140});assert.equal(picker.data.sat,100);assert.equal(picker.data.val,100);
});
