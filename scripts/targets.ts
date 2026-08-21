import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
for(const [name,rva] of [['call1',0x1f35a],['call2',0x1f38a],['call3',0x1f339],['call4',0x1f32d],['call5',0x1f3b2]]){
  const b=image[rva];
  if(b===0xff&&image[rva+1]===0x15){
    const disp=view.getInt32(rva+2,true);
    const slot=0x1000000+rva+6+disp;
    console.log(name+' at rva 0x'+rva.toString(16)+' call[rip] -> slot 0x'+slot.toString(16));
    if(slot-0x1000000<image.byteLength){
      console.log('   value at slot = 0x'+Number(view.getBigUint64(slot-0x1000000,true)).toString(16));
    } else console.log('   slot beyond file');
  } else if(b===0xe8){
    const disp=view.getInt32(rva+1,true);
    console.log(name+' at rva 0x'+rva.toString(16)+' call rel -> 0x'+(0x1000000+rva+5+disp).toString(16));
  } else {
    console.log(name+' at rva 0x'+rva.toString(16)+' first bytes: '+[b,image[rva+1],image[rva+2]].map(x=>x.toString(16)).join(' '));
  }
}
