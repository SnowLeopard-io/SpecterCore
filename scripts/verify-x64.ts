import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const eLfanew = view.getUint32(0x3c, true);
const nsec = view.getUint16(eLfanew+6, true);
const secTable = eLfanew + 24 + view.getUint16(eLfanew+20, true);
const rdU32=(o)=>view.getUint32(o,true);
console.log('=== sections ===');
for(let i=0;i<nsec;i++){
  const s=secTable+i*40;
  console.log('  '+new TextDecoder().decode(image.subarray(s,s+8)).replace(/\0+$/,'')+' VA=0x'+rdU32(s+12).toString(16)+' vsize=0x'+rdU32(s+8).toString(16)+' rawPtr=0x'+rdU32(s+20).toString(16)+' rawSize=0x'+rdU32(s+16).toString(16));
}
const rawOff=(va)=>{for(let i=0;i<nsec;i++){const s=secTable+i*40; if(rdU32(s+12)===va) return rdU32(s+20);}return 0;};
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
console.log('\n=== sample call sites (rva .text) ===');
for(const rva of [0x12c9,0x18fd,0x23a6,0x3082,0x4e2b,0x1266a]){
  const off=rawOff(rva)+rva; // only correct if rva<rawSize; use section base
  // recompute properly via section
  let o=0; for(let i=0;i<nsec;i++){const s=secTable+i*40; if(rva>=rdU32(s+12) && rva<rdU32(s+12)+rdU32(s+8)) o=rdU32(s+20)+(rva-rdU32(s+12));}
  console.log('  rva 0x'+rva.toString(16)+' ('+String(o).padStart(6)+'): '+hex(o,8));
}
console.log('\n=== jmp [rip+..] thunks in 0x1027400-0x1027560 ===');
const txtBase=0x1000, txtOff=rawOff(0x1000);
for(let rva=0x27400;rva<0x27560;rva++){
  const off=txtOff+(rva-txtBase);
  if(image[off]===0xff && image[off+1]===0x25){
    const disp=view.getInt32(off+2,true);
    const target=((0x1000000+rva+6+disp)>>>0);
    console.log('  rva 0x'+rva.toString(16)+': jmp [0x'+target.toString(16)+']   slot rva=0x'+(target-0x1000000).toString(16));
  }
}
console.log('\n=== .fothk rva 0x28000 region ===');
const foOff=rawOff(0x28000);
console.log('  bytes: '+hex(foOff,16));
