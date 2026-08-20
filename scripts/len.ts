import { readFile } from 'node:fs/promises';
const buf = await readFile('apps/web/public/win/notepad-x64.exe');
console.log('file bytes:', buf.byteLength, '= 0x'+buf.byteLength.toString(16));
