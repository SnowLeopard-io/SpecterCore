import { readFile } from 'node:fs/promises';
for (const file of ['apps/web/public/win/notepad-x64.exe','apps/web/public/win/cmd-x64.exe','apps/web/public/win/notepad.exe']){
  const image = new Uint8Array(await readFile(file));
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const eLfanew = view.getUint32(0x3c, true);
  const rdU32=(o)=>view.getUint32(o,true);
  const rdU16=(o)=>view.getUint16(o,true);
  const nsec = rdU16(eLfanew+6);
  const secTable = eLfanew + 24 + rdU16(eLfanew+20);
  console.log('=== '+file+' ===');
  for(let i=0;i<nsec;i++){
    const s=secTable+i*40;
    const name=new TextDecoder().decode(image.subarray(s,s+8)).replace(/\0+$/,'');
    console.log('  '+name+' VA=0x'+rdU32(s+12).toString(16)+' vsize=0x'+rdU32(s+8).toString(16)+' raw=0x'+rdU32(s+20).toString(16));
  }
}
