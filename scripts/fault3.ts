import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
console.log('--- code 0x1013690-0x1013720 ---');
for(let r=0x13690;r<0x13720;r+=16) console.log('0x101'+r.toString(16).slice(1)+': '+hex(r,16));
// find rip-relative pointers referenced by code at 0x136e6..
for(let r=0x136e6;r<0x13710;r++){
  const b=image[r];
  if(b===0x48 && (image[r+1]===0x8b||image[r+1]===0x05) ){
    // mov reg,[rip] forms; crude: check modrm 0x05 or 0x0d
  }
}
const at=(rva)=>{ for(let r=rva;r<rva+16;r++) process.stdout.write(image[r].toString(16).padStart(2,'0')+' '); process.stdout.write('\n'); };
// decode rip-rel loads in the block starting 0x136e6
for(let r=0x136e6;r<0x13708;){
  const b=image[r];
  if(b===0x8b && image[r+1]===0x05){ const d=view.getInt32(r+2,true); const t=0x1000000+r+6+d; console.log('0x101'+(r).toString(16).slice(1)+' mov eax,[rip+0x'+d.toString(16)+'] -> 0x'+t.toString(16)); r+=6; }
  else if(b===0x48 && image[r+1]===0x8b && image[r+2]===0x05){ const d=view.getInt32(r+3,true); const t=0x1000000+r+7+d; console.log('0x101'+(r).toString(16).slice(1)+' mov rax,[rip+0x'+d.toString(16)+'] -> 0x'+t.toString(16)); r+=7; }
  else if(b===0x48 && image[r+1]===0xff && image[r+2]===0x15){ const d=view.getInt32(r+3,true); const t=0x1000000+r+7+d; console.log('0x101'+(r).toString(16).slice(1)+' call [rip+0x'+d.toString(16)+'] -> slot 0x'+t.toString(16)+' val=0x'+Number(view.getBigUint64(t-0x1000000,true)).toString(16)); r+=7; }
  else if(b===0xff && image[r+1]===0x25){ const d=view.getInt32(r+2,true); const t=0x1000000+r+6+d; console.log('0x101'+(r).toString(16).slice(1)+' jmp [rip+0x'+d.toString(16)+'] -> slot 0x'+t.toString(16)); r+=6; }
  else if(b===0xe8){ const d=view.getInt32(r+1,true); const t=0x1000000+r+5+d; console.log('0x101'+(r).toString(16).slice(1)+' call 0x'+t.toString(16)); r+=5; }
  else if(b===0xeb){ console.log('0x101'+(r).toString(16).slice(1)+' jmp rel'); r+=2; }
  else if(b===0x0f&&(image[r+1]>=0x80&&image[r+1]<=0x8f)){ r+=6; }
  else r+=1;
}
