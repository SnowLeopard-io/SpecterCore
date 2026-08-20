import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
const found=[];
for(let rva=0x1000;rva<0x28000;rva++){
  // call [rip+disp] = ff 15 <disp32>
  if(image[rva]===0xff && image[rva+1]===0x15){
    const disp=view.getInt32(rva+2,true);
    const tgt=(0x1000000+rva+6+disp)>>>0;
    if(tgt===0x102a218){ found.push({rva,bytes:hex(rva,6),kind:'call[rip]'}); }
  }
  // mov rax,[rip+disp]; call rax -> 48 8b 05 <disp> ; ff d0 (later)
  if(image[rva]===0x48 && image[rva+1]===0x8b && image[rva+2]===0x05){
    const disp=view.getInt32(rva+3,true);
    const tgt=(0x1000000+rva+7+disp)>>>0;
    if(tgt===0x102a218){ found.push({rva,bytes:hex(rva,7),kind:'mov rax,[rip]'}); }
  }
  // jmp [rip+disp] = ff 25 <disp32>
  if(image[rva]===0xff && image[rva+1]===0x25){
    const disp=view.getInt32(rva+2,true);
    const tgt=(0x1000000+rva+6+disp)>>>0;
    if(tgt===0x102a218){ found.push({rva,bytes:hex(rva,6),kind:'jmp[rip]'}); }
  }
}
console.log('refs to slot 0x102a218:');
for(const f of found) console.log('  rva 0x'+f.rva.toString(16)+' '+f.kind+' '+f.bytes);
