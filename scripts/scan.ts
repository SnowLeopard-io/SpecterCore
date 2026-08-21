import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const cstr=(rva)=>{let s='';let o=rva;while(image[o]&&s.length<64){s+=String.fromCharCode(image[o++]);}return s;};
const slots=new Set<number>();
let n=0;
for(let i=0;;i++){
  const o=0x309c0+i*20;
  const oft=d32(o),name=d32(o+12),ft=d32(o+16);
  if(!oft&&!name&&!ft) break;
  n++;
  const mod=cstr(name);
  let cnt=0;
  for(let t=0;;t++){
    const e=u64(ft+t*8);
    if(e===0) break;
    slots.add(ft+t*8); cnt++;
  }
  const hits=[];
  if(ft<=0x29890&&0x29890<ft+cnt*8) hits.push('0x29890');
  if(ft<=0x29928&&0x29928<ft+cnt*8) hits.push('0x29928');
  if(ft<=0x29938&&0x29938<ft+cnt*8) hits.push('0x29938');
  if(hits.length) console.log(`desc[${i}] ${mod} FT=0x${ft.toString(16)} count=${cnt} range 0x${ft.toString(16)}-0x${(ft+cnt*8).toString(16)} CONTAINS ${hits.join(',')}`);
}
console.log('total descriptors: '+n);
for(const s of [0x29890,0x29898,0x298a8,0x298b0,0x298b8,0x298c0,0x29920,0x29928,0x29930,0x29938]){
  console.log('slot 0x'+s.toString(16)+' covered='+slots.has(s));
}
