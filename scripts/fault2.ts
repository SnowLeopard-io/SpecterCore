import { readFile } from 'node:fs/promises';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const hex=(off,n)=>{const a=[];for(let i=0;i<n;i++)a.push(image[off+i].toString(16).padStart(2,'0'));return a.join(' ');};
console.log('--- code at 0x10136d0 (rva 0x136d0) ---');
for(let r=0x136d0;r<0x136f0;r+=16) console.log('0x101'+r.toString(16).slice(1)+': '+hex(r,16));
console.log('--- data at 0x1033600 (rva 0x33600) ---');
for(let r=0x33600;r<0x33680;r+=16) console.log('0x103'+r.toString(16).slice(1)+': '+hex(r,16));
