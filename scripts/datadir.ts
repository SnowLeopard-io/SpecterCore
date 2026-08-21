import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const d16=(o)=>view.getUint16(o,true), d32=(o)=>view.getUint32(o,true);
const pe=d32(0x3c),opt=pe+24;
const n=d16(opt+108);
const names=['EXPORT','IMPORT','RESOURCE','EXCEPTION','SECURITY','BASERELOC','DEBUG','ARCH','GLOBALPTR','TLS','LOADCFG','BOUND_IMPORT','IAT','DELAY_IMPORT','COM_DESCRIPTOR','RESERVED'];
for(let i=0;i<n;i++){
  const o=opt+112+i*8;
  const rva=d32(o),size=d32(o+4);
  console.log((names[i]||'idx'+i)+': rva=0x'+rva.toString(16)+' size=0x'+size.toString(16));
}
