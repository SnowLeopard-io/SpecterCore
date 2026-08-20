import { readFile } from 'node:fs/promises';
import { PeLoaderImpl } from '@specter-core/core';
async function main() {
  const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
  const pe = await new PeLoaderImpl().load(image);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const rdU32 = (off) => view.getUint32(off, true);
  const rdU64 = (off) => Number(view.getBigUint64(off, true));
  const eLfanew = view.getUint32(0x3c, true);
  const nsec = view.getUint16(eLfanew+6, true);
  const secTable = eLfanew + 24 + view.getUint16(eLfanew+20, true);
  const rawPtr = (va) => { for (let i=0;i<nsec;i++){ const s=secTable+i*40; if (rdU32(s+12)===va) return rdU32(s+20);} return 0; };
  const rvaToOff = (rva) => { for (const s of pe.sections){ const span=Math.max(s.virtualSize,s.rawSize); if(rva>=s.virtualAddress && rva<s.virtualAddress+span){ const off=rva-s.virtualAddress+rawPtr(s.virtualAddress); return off>=0&&off<image.byteLength?off:null; } } return null; };
  const readCStr = (off) => { if (off==null) return '?'; let e=off; while(image[e]&&e-off<256)e++; return new TextDecoder().decode(image.subarray(off,e)); };
  // find ALL e8/e9 to 0x10274e0 and 0x1028010, and indirect refs
  console.log('=== callers of 0x274e0 / 0x28010 ===');
  for (let rva=0x1000; rva<0x2a000; rva++){
    const off=rvaToOff(rva); if(off==null) continue;
    if (image[off]===0xe8||image[off]===0xe9){
      const disp=view.getInt32(off+1,true);
      const tgt=(0x1000000+rva+5+disp)>>>0;
      if(tgt===0x10274e0||tgt===0x1028010) console.log('  rva 0x'+rva.toString(16)+' '+(image[off]===0xe8?'call':'jmp')+' 0x'+tgt.toString(16));
    }
  }
  // delay dir size check
  const optOff = eLfanew + 24;
  const ddOff = optOff + 112;
  console.log('\ndelay dir size field = 0x'+rdU32(ddOff+13*8+4).toString(16));
  console.log('import dir size field = 0x'+rdU32(ddOff+8+4).toString(16));
  // The delay INT name tables: dump function names for each delay desc
  const readNames = (intRva) => { const out=[]; const io=rvaToOff(intRva); if(io==null) return out; for(let i=0;i<200;i++){ const e=rdU64(io+i*8); if(e===0) break; if(e&0x8000000000000000n){ out.push('#'+Number(e&0xffffn)); } else { const no=rvaToOff(Number(e)); out.push(readCStr(no!=null?no+2:null)); } } return out; };
  for (const [name, intRva] of [['ADVAPI32',0x304c0],['COMDLG32',0x304d8],['PROPSYS',0x30528],['SHELL32',0x30540],['WINSPOOL',0x30588],['urlmon',0x305a8]]){
    console.log('  '+name+': '+readNames(intRva).join(', '));
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
