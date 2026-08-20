import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const eLfanew = view.getUint32(0x3c, true);
const rdU32=(o)=>view.getUint32(o,true);
const rdU16=(o)=>view.getUint16(o,true);
const nsec = rdU16(eLfanew+6);
const secTable = eLfanew + 24 + rdU16(eLfanew+20);
// find non-cc bytes in fothk (raw 0x28000, size 0x1000)
const st=[]; for(let i=0;i<0x1000;i++){ const b=image[0x28000+i]; if(b!==0xcc){ st.push('0x'+(0x28000+i).toString(16)+'='+b.toString(16)); } }
console.log('non-cc in fothk ('+st.length+'):'); console.log(st.slice(0,60).join(' '));
// dump around rva 0x28000-0x28030
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
console.log('\n0x28010 region: '+hex(0x28010,16));
// disasm of delay helper region 0x10272c0-0x1027300 (from trace) via raw bytes
const hexRva=(rva,n)=>hex(0x28000+(rva-0x28000),n); // no, sections raw==VA here since rawPtr==VA for text/fothk/rdata
const txtHex=(rva,n)=>hex(rva,n); // rawPtr==rva for .text (rawPtr 0x1000==VA 0x1000)
console.log('\n0x10274d8-0x1027530: '+txtHex(0x274d8,0x60));
console.log('\n0x10272c0-0x1027300: '+txtHex(0x272c0,0x40));
