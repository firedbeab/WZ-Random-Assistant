// 生成封闭削角内芯：六个面、十二条边、八个角。只在构建时运算，不引入几何库。
const fs = require('node:fs');
const path = require('node:path');
const HALF = 66.5, INNER = 54.5; // 外层面在 ±67rpx，内芯略退后，避免共面闪烁。
const add = (a,b) => a.map((v,i) => v+b[i]);
const sub = (a,b) => a.map((v,i) => v-b[i]);
const scale = (a,n) => a.map(v => v*n);
const dot = (a,b) => a.reduce((sum,v,i) => sum+v*b[i],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = a => scale(a,1/Math.hypot(...a));
const number = n => String(Math.abs(n)<.00001 ? 0 : +n.toFixed(5));
const faces = [];
for (let axis=0;axis<3;axis++) for (const sign of [-1,1]) {
  const other=[0,1,2].filter(i=>i!==axis);
  faces.push([[-1,-1],[1,-1],[1,1],[-1,1]].map(pair=>{
    const vertex=[0,0,0];vertex[axis]=sign*HALF;
    other.forEach((i,j)=>{vertex[i]=pair[j]*INNER;});return vertex;
  }));
}
for (let free=0;free<3;free++) for (const a of [-1,1]) for (const b of [-1,1]) {
  const [first,second]=[0,1,2].filter(i=>i!==free);
  faces.push([[HALF,INNER,-INNER],[INNER,HALF,-INNER],[INNER,HALF,INNER],[HALF,INNER,INNER]].map(values=>{
    const vertex=[0,0,0];vertex[first]=a*values[0];vertex[second]=b*values[1];vertex[free]=values[2];return vertex;
  }));
}
for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) {
  faces.push([[HALF,INNER,INNER],[INNER,HALF,INNER],[INNER,INNER,HALF]].map(p=>[p[0]*x,p[1]*y,p[2]*z]));
}
function geometry(vertices) {
  const center=scale(vertices.reduce(add,[0,0,0]),1/vertices.length);
  const u=unit(sub(vertices[1],vertices[0]));
  let normal=unit(cross(u,sub(vertices[2],vertices[0])));
  if(dot(normal,center)<0)normal=scale(normal,-1);
  const v=cross(normal,u);
  const points=vertices.map(p=>[dot(sub(p,center),u),dot(sub(p,center),v)]);
  const low=[0,1].map(i=>Math.min(...points.map(p=>p[i])));
  const high=[0,1].map(i=>Math.max(...points.map(p=>p[i])));
  const width=high[0]-low[0],height=high[1]-low[1];
  const origin=add(add(center,scale(u,(low[0]+high[0])/2)),scale(v,(low[1]+high[1])/2));
  return {center,normal,u,v,points,low,width,height,origin};
}
function output() {
  return '/* 由 Progress/build-dice-core.cjs 生成，勿手工调整面片位置。 */\n'+faces.map((vertices,i)=>{
    const g=geometry(vertices);
    const polygon=g.points.map(p=>`${number((p[0]-g.low[0])/g.width*100)}% ${number((p[1]-g.low[1])/g.height*100)}%`).join(',');
    const matrix=[...g.u,0,...g.v,0,...g.normal,0,0,0,0,1].map(number).join(',');
    const translate=g.origin.map(n=>number(n)+'rpx').join(',');
    const color=g.normal[1]<-.3?'#fffdf6':g.normal[2]>.5?'#fffdfa':'#f4f8f2';
    return `.core-facet-${i} { width:${number(g.width)}rpx; height:${number(g.height)}rpx; margin-left:${number(-g.width/2)}rpx; margin-top:${number(-g.height/2)}rpx; clip-path:polygon(${polygon}); transform:translate3d(${translate}) matrix3d(${matrix}) scale(1.01); background:${color}; }`;
  }).join('\n')+'\n';
}
if(require.main===module)fs.writeFileSync(path.resolve(__dirname,'../components/easter-dice/dice-core.wxss'),output());
module.exports={HALF,INNER,faces,geometry,output,dot};
