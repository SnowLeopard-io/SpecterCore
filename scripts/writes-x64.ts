import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
// scan .text raw (rawPtr==rva==offset for 0x1000..0x28000) for any RIP-relative operand into 0x2a400-0x2a480
const hit=[];
for(let rva=0x1000;rva<0x28000;rva++){
  const b=image[rva];
  if(b===0xff||b===0x48||b===0x8b||b===0x89||b===0x8d||b===0x0f||b===0x4c||b===0x48||b===0x8b){
    // try to locate modrm=05 (mod=00 reg=000 rm=101 => [rip+disp32]) following prefixes
    let i=rva;
    // skip REX prefixes
    if(image[i]===0x48||image[i]===0x4c||image[i]===0x49||image[i]===0x4d)i++;
    if(image[i]===0x48||image[i]===0x4c||image[i]===0x49||image[i]===0x4d)i++;
    if(i>rva){ const op=image[i]; const modrm=image[i+1];
      if(modrm===0x05){ const disp=view.getInt32(i+2,true); const target=0x1000000+i+6+disp;
        if(target>=0x102a3f0&&target<=0x102a488) hit.push({rva,i,target,bytes:[...image.subarray(rva,i+6)].map(x=>x.toString(16).padStart(2,'0')).join(' ')});
      }
    }
  }
}
console.log('RIP-relative ops targeting 0x2a3f0-0x2a488 ('+hit.length+'):');
for(const h of hit) console.log('  rva 0x'+h.rva.toString(16)+' (instr @0x'+h.i.toString(16)+') target 0x'+h.target.toString(16)+'  ['+h.bytes+']');
// also scan for any 64-bit mov rax, imm64 == slot addr or lea with that value (absolute addressing is unlikely)
console.log('\nsearching writes via lea/mov to slot area done. also check crt-private thunk pattern region 0x1027400-0x1027600 for lea rax,[rip+slot] stubs:');
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
console.log('  0x27400: '+hex(0x27400,0x40));
