import { readFile } from 'node:fs/promises';
import { PeLoaderImpl } from '@specter-core/core';
async function main() {
  const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
  const pe = await new PeLoaderImpl().load(image);
  const base = 0x1000000;
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const eLfanew = view.getUint32(0x3c, true);
  const opt = eLfanew + 4 + 20;
  const dataDirOff = opt + 112;
  const readU32 = (off) => view.getUint32(off, true);
  const ddRva = readU32(dataDirOff + 13*8);
  const rvaToOff = (rva) => { for (const s of pe.sections) { const a=s.virtualAddress, b=a+Math.max(s.virtualSize,s.rawSize); if (rva>=a && rva<b) return s.pointerToRawData + (rva-a); } return null; };
  const readCStr = (off) => { if (off==null) return '?'; let e=off; while(image[e]&&e-off<256)e++; return new TextDecoder().decode(image.subarray(off,e)); };
  const readU64 = (off)=>Number(view.getBigUint64(off,true));
  console.log('delay-dir rva=0x'+ddRva.toString(16));
  let d=0;
  while (true) {
    const off = rvaToOff(ddRva + d*32);
    if (off==null) break;
    const attr=readU32(off+0), nameRva=readU32(off+4), modRva=readU32(off+8), iatRva=readU32(off+12), intRva=readU32(off+16);
    if (!attr && !nameRva && !iatRva && !intRva) break;
    const dll = readCStr(rvaToOff(nameRva));
    const iatBase = base + iatRva;
    let t=0; const fs=[];
    while (true) {
      const thOff = rvaToOff(intRva + t*8);
      const v = thOff==null?0:readU64(thOff);
      if (!v) break;
      const nm = (v & 0x8000000000000000)?('#'+(v&0xffff)):readCStr(rvaToOff((v&0xffffffff)+2));
      fs.push({slot:(iatBase+t*8).toString(16),name:nm});
      t++;
    }
    console.log(`DL[${d}] ${dll} iat=0x${iatBase.toString(16)} n=${fs.length}`);
    for (const f of fs) if (parseInt(f.slot,16) >= 0x102a3e0 && parseInt(f.slot,16) <= 0x102a4a0) console.log(`   slot 0x${f.slot} = ${f.name}`);
    d++;
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
