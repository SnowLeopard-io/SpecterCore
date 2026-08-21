import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const foff=(rva)=>{
  // section headers start at e_lfanew+24
  const pe=d32(0x3c);
  const nsec=d16(pe+6);
  const opt=pe+24;
  const sec=opt+d16(pe+20);
  for(let i=0;i<nsec;i++){
    const s=sec+i*40;
    const va=d32(s+12), vs=d32(s+8), raw=d32(s+20), rs=d32(s+16);
    if(rva>=va&&rva<va+Math.max(vs,rs)) return raw+(rva-va);
  }
  return rva;
};
const d16=(o)=>view.getUint16(o,true);
const pe=d32(0x3c);
const opt=pe+24;
const magic=d16(opt);
const ddOff=opt+(magic===0x20b?112:96)+13*8;
const ddRva=d32(ddOff), ddSize=d32(ddOff+4);
console.log('delay dir rva=0x'+ddRva.toString(16)+' size=0x'+ddSize.toString(16));
let n=ddSize/32;
for(let i=0;i<n;i++){
  const o=foff(ddRva+i*32);
  const grAttrs=d32(o), dllName=d32(o+4), hmod=d32(o+8), iat=d32(o+12), int=d32(o+16), bound=d32(o+20), unload=d32(o+24), ts=d32(o+28);
  console.log(`desc[${i}] grAttrs=0x${grAttrs.toString(16)} dllName=0x${dllName.toString(16)} hmod=0x${hmod.toString(16)} iat=0x${iat.toString(16)} int=0x${int.toString(16)} bound=0x${bound.toString(16)} unload=0x${unload.toString(16)} ts=0x${ts.toString(16)}`);
}
// dump the IAT array around 0x29928 to see if it belongs to a descriptor
console.log('--- iat array at 0x29920..0x29940 ---');
for(let rva=0x29920;rva<0x29940;rva+=8){ console.log('rva 0x'+rva.toString(16)+' = 0x'+u64(rva).toString(16)); }
