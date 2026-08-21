import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d16=(o)=>view.getUint16(o,true), d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const cstr=(rva)=>{let s='';let o=rva;while(image[o]&&s.length<64){s+=String.fromCharCode(image[o++]);}return s;};
// .rdata rawPtr==rva assumption: verify via section table
const pe=d32(0x3c),opt=pe+24,nsec=d16(pe+6),sec=opt+d16(pe+20);
console.log('sections:');
for(let i=0;i<nsec;i++){const s=sec+i*40;console.log('  '+cstr(s)+' va=0x'+d32(s+12).toString(16)+' vs=0x'+d32(s+8).toString(16)+' raw=0x'+d32(s+20).toString(16)+' rs=0x'+d32(s+16).toString(16));}
const foff=(rva)=>{for(let i=0;i<nsec;i++){const s=sec+i*40;const va=d32(s+12),vs=d32(s+8),raw=d32(s+20),rs=d32(s+16);if(rva>=va&&rva<va+Math.max(vs,rs))return raw+(rva-va);}return rva;};
for(let i=0;i<8;i++){
  const o=foff(0x309c0+i*20);
  const oft=d32(o),name=d32(o+12),ft=d32(o+16);
  if(!oft&&!name&&!ft) break;
  const fc=d32(o+8);
  console.log(`desc[${i}] OFT=0x${oft.toString(16)} FCL=0x${fc.toString(16)} Name=0x${name.toString(16)} ("${cstr(foff(name))}") FT=0x${ft.toString(16)}`);
}
