import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
const fileOff = (rva) => rva - 0x1000000; // rawPtr==rva for .text/.rdata
for(let rva=0x1026f00;rva<0x1027500;rva+=16) console.log('0x'+rva.toString(16)+': '+hex(fileOff(rva),16));
