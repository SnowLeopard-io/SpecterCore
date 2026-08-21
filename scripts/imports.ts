import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d16=(o)=>view.getUint16(o,true), d32=(o)=>view.getUint32(o,true);
const u64=(o)=>Number(view.getBigUint64(o,true));
const foff=(rva)=>{const pe=d32(0x3c);const nsec=d16(pe+6);const opt=pe+24;const sec=opt+d16(pe+20);for(let i=0;i<nsec;i++){const s=sec+i*40;const va=d32(s+12),vs=d32(s+8),raw=d32(s+20),rs=d32(s+16);if(rva>=va&&rva<va+Math.max(vs,rs))return raw+(rva-va);}return rva;};
const cstr=(rva)=>{let o=foff(rva);let s='';while(image[o]&&s.length<64){s+=String.fromCharCode(image[o++]);}return s;};
const pe=d32(0x3c),opt=pe+24,ddOff=opt+112+12*8;
const idRva=d32(ddOff), idSize=d32(ddOff+4);
console.log('import dir rva=0x'+idRva.toString(16)+' size=0x'+idSize.toString(16));
const maxDesc=idSize/20;
let shown=0;
for(let i=0;i<maxDesc;i++){
  const o=foff(idRva+i*20);
  const oft=d32(o),name=d32(o+12),ft=d32(o+16);
  if(!name) break;
  if(i<3||name>=0x29880&&name<=0x29a00) console.log(`desc[${i}] OFT=0x${oft.toString(16)} name=0x${name.toString(16)} ("${cstr(name)}") FT=0x${ft.toString(16)}`);
  // scan FT/OFT arrays for 0x29928 or 0x29890
  for(const [label,rva] of [['OFT',oft],['FT',ft]]){
    if(!rva) continue;
    let j=0;
    while(true){
      const ent=u64(rva+j*8);
      if(ent===0) break;
      if(rva+j*8===0x29928||rva+j*8===0x29890||rva+j*8===0x29920||rva+j*8===0x29900) console.log(`   !! desc[${i}] ${label} slot rva 0x${(rva+j*8).toString(16)} idx=${j} contains 0x${ent.toString(16)}`);
      j++;
    }
  }
  shown++;
}
console.log('descriptors scanned: '+shown);
