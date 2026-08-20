import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
// find all thunks: ff 25 <disp> in .text, list those whose slot is 0x2a218 or any known winrt slot
const thunks=[];
for(let rva=0x1000;rva<0x28000;rva++){
  if(image[rva]===0xff && image[rva+1]===0x25){
    const disp=view.getInt32(rva+2,true);
    const tgt=(0x1000000+rva+6+disp)>>>0;
    thunks.push({rva,tgt});
  }
}
for(const t of thunks){
  if(t.tgt===0x102a218) console.log('RoGetActivationFactory thunk at rva 0x'+t.rva.toString(16)+': '+hex(t.rva,6));
}
// find callers of that thunk rva (call thunk = e8 <rel> to thunk rva)
const rafThunk = thunks.find(t=>t.tgt===0x102a218);
if(rafThunk){
  const site=[]; const tgtRva=rafThunk.rva;
  for(let rva=0x1000;rva<0x28000;rva++){
    if(image[rva]===0xe8){
      const disp=view.getInt32(rva+1,true);
      if((0x1000000+rva+5+disp)>>>0 === 0x1000000+tgtRva) site.push(rva);
    }
  }
  console.log('callers of RoGetActivationFactory thunk:',site.map(s=>'0x'+s.toString(16)).join(', '));
  for(const s of site){
    console.log('\n=== code after call site 0x'+s.toString(16)+' (rva) ===');
    for(let rva=s+5;rva<s+5+80;rva+=16) console.log('0x'+rva.toString(16)+': '+hex(rva,Math.min(16,s+5+80-rva)));
  }
}
