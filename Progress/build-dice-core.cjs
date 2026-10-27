// 生成封闭圆角内芯：六面、十二条圆弧边、八个球面角。仅在构建时运算。
const fs = require('node:fs');
const path = require('node:path');
const HALF = 66.5, INNER = 47; // 标称半边67、圆角半径20；点阵另有1px前景间距。
const SIZE = 134;
const SEGMENTS = 3, RADIUS = HALF - INNER;
// 先将唯一的骰子尺寸换成实际像素，再由浏览器做比例运算。
// 微信会单独取整rpx；直接输出66.5rpx/67rpx会让内芯和外层落在同一平面。
const measure = n => Math.abs(n) < 1e-8 ? '0px' : `calc(var(--dice-size) * ${+((n / SIZE).toFixed(9))})`;
// 每片增加一像素覆盖量，避免深色背景从clip-path的抗锯齿边缘透出。
const bleed = (n,px) => `calc(var(--dice-size) * ${+((n / SIZE).toFixed(9))} ${px < 0 ? '-' : '+'} ${Math.abs(px)}px)`;
const add = (a,b) => a.map((v,i) => v+b[i]);
const sub = (a,b) => a.map((v,i) => v-b[i]);
const scale = (a,n) => a.map(v => v*n);
const dot = (a,b) => a.reduce((sum,v,i) => sum+v*b[i],0);
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit = a => scale(a,1/Math.hypot(...a));
const number = n => String(Math.abs(n)<.00001 ? 0 : +n.toFixed(5));
const vertex = values => values.map(n => +n.toFixed(9));
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
  const edge = (step,end) => { const angle=step*Math.PI/(2*SEGMENTS),p=[0,0,0];p[first]=a*(INNER+RADIUS*Math.cos(angle));p[second]=b*(INNER+RADIUS*Math.sin(angle));p[free]=end;return vertex(p); };
  for(let step=0;step<SEGMENTS;step++)faces.push([edge(step,-INNER),edge(step+1,-INNER),edge(step+1,INNER),edge(step,INNER)]);
}
for (const x of [-1,1]) for (const y of [-1,1]) for (const z of [-1,1]) {
  const corner = (row,column) => { const theta=row*Math.PI/(2*SEGMENTS),phi=column*Math.PI/(2*SEGMENTS);return vertex([
    x*(INNER+RADIUS*Math.sin(theta)*Math.cos(phi)),y*(INNER+RADIUS*Math.sin(theta)*Math.sin(phi)),z*(INNER+RADIUS*Math.cos(theta))]); };
  for(let row=0;row<SEGMENTS;row++)for(let column=0;column<SEGMENTS;column++) {
    const patch=[corner(row,column),corner(row,column+1),corner(row+1,column+1),corner(row+1,column)];
    faces.push(patch.filter((p,i)=>patch.findIndex(other=>other.every((v,axis)=>v===p[axis]))===i));
  }
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
    const translate=g.origin.map(measure).join(',');
    // 曲面按相邻原材质连续混合，平面色值保持原样，不产生色带或深色主题染色。
    const palette=[[244,248,242],g.normal[1]<0?[255,253,246]:[255,253,250],[255,253,250]];
    const weights=g.normal.map(n=>n*n);
    const color='#'+[0,1,2].map(channel=>Math.round(palette.reduce((sum,c,axis)=>sum+c[channel]*weights[axis],0)).toString(16).padStart(2,'0')).join('');
    return `.core-facet-${i} { width:${bleed(g.width,1)}; height:${bleed(g.height,1)}; margin-left:${bleed(-g.width/2,-.5)}; margin-top:${bleed(-g.height/2,-.5)}; clip-path:polygon(${polygon}); transform:translate3d(${translate}) matrix3d(${matrix}); background:${color}; }`;
  }).join('\n')+'\n';
}
if(require.main===module)fs.writeFileSync(path.resolve(__dirname,'../components/easter-dice/dice-core.wxss'),output());
module.exports={HALF,INNER,SIZE,SEGMENTS,measure,faces,geometry,output,dot};
