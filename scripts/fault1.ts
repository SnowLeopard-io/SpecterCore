import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
for(let r=0x101f300;r<0x101f3a0;r+=16) console.log('0x'+r.toString(16)+': '+hex(r-0x1000000,16));
