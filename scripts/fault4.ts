import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
for(const rva of [0x29900,0x29920,0x29928,0x29940,0x29960,0x29890,0x298a0]){
  const off=rva-0x29000+0x29000; // assume rva==off for .rdata? no
  console.log('rva 0x'+rva.toString(16)+' bytes: '+hex(rva,16));
  const v=Number(view.getBigUint64(rva,true));
  console.log('   as u64 = 0x'+v.toString(16)+'   -> mapped 0x'+(0x1000000+v).toString(16));
}
