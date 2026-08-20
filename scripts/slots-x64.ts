import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
// slot region file offset = rva (rawPtr==rva for .rdata 0x29000)
console.log('=== slot region rva 0x2a438-0x2a478 (raw==rva) ===');
for(let rva=0x2a438;rva<0x2a478;rva+=8){
  const v=Number(view.getBigUint64(rva,true));
  console.log('  0x'+rva.toString(16)+': '+hex(rva,8)+'  = 0x'+v.toString(16)+'  (mapped 0x'+(0x1000000+(v&0xffffffff)).toString(16)+' if code addr)');
}
console.log('\n=== code region 0x274e0-0x27530 (raw==rva for .text 0x1000) ===');
for(let rva=0x274e0;rva<0x27530;rva+=16){
  console.log('  0x'+rva.toString(16)+': '+hex(rva,16));
}
// recompute the jmp targets
console.log('\n=== jmp [rip+..] targets in 0x274e0-0x27520 ===');
for(const rva of [0x274e0,0x27520]){
  const o=rva; const disp=view.getInt32(o+2,true);
  console.log('  rva 0x'+rva.toString(16)+': disp=0x'+disp.toString(16)+' target=0x'+(0x1000000+rva+6+disp).toString(16));
}
