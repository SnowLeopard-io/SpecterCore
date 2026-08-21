import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const cstr=(rva)=>{let s='';let o=rva;while(image[o]&&s.length<64){s+=String.fromCharCode(image[o++]);}return s;};
// find COMCTL32 descriptor (name rva -> string)
for(let i=0;i<60;i++){
  const o=0x309c0+i*20;
  const oft=d32(o),name=d32(o+12),ft=d32(o+16);
  if(!oft&&!name&&!ft) break;
  if(cstr(name).toLowerCase().includes('comctl')){
    console.log(`COMCTL32 desc[${i}] OFT=0x${oft.toString(16)} FT=0x${ft.toString(16)}`);
    console.log('--- ILT (OFT) entries ---');
    let t=0;
    for(;;t++){
      const e=u64(oft+t*8);
      if(e===0){console.log(`  [${t}] 0 (end)`);break;}
      if(e&0x8000000000000000) console.log(`  [${t}] ORDINAL ${e&0xffff}`);
      else console.log(`  [${t}] hint/name rva=0x${e.toString(16)} -> "${cstr(e+2)}"`);
    }
    console.log('--- IAT (FT) entries ---');
    for(let k=0;k<11;k++) console.log(`  [${k}] slot rva 0x${(ft+k*8).toString(16)} = 0x${u64(ft+k*8).toString(16)}`);
  }
}
