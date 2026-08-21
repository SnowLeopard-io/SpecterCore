import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d16=(o)=>view.getUint16(o,true), d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
for(let i=0;i<5;i++){
  const o=0x298d8+i*20;
  console.log(`desc[${i}] @0x298d8: ${hex(o,20)}  OFT=${d32(o)} name=${d32(o+12)} FT=${d32(o+16)}`);
}
console.log('--- slot region 0x29860-0x299e0 as u64 ---');
for(let r=0x29860;r<0x299e0;r+=8){
  const v=u64(r);
  let tag='';
  if(v>=0x100000&&v<0x200000) tag='<- code ptr?';
  console.log('0x'+r.toString(16)+': 0x'+v.toString(16)+'   (mapped 0x'+(0x1000000+v).toString(16)+')'+tag);
}
