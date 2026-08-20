import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const counts = new Map();
let total=0;
for(let rva=0x1000;rva<0x28000;rva++){
  const b=image[rva];
  if(b===0xe8||b===0xe9){
    const disp=view.getInt32(rva+1,true);
    const tgt=(0x1000000+rva+5+disp)>>>0;
    if(tgt>=0x1028000 && tgt<0x1029000){
      counts.set(tgt,(counts.get(tgt)??0)+1); total++;
    }
  }
}
console.log('total e8/e9 into fothk (0x1028000-0x1029000):',total);
console.log('distinct targets:',counts.size);
for(const [t,c] of [...counts.entries()].sort((a,b)=>a[1]-b[1])) console.log('  0x'+t.toString(16)+' x'+c);
