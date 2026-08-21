/** Dump all PE data directories. node pe-dirs.mjs <exe> */
import { readFileSync } from 'node:fs';
const exe = readFileSync(process.argv[2]);
const peOff = exe.readUInt32LE(0x3c);
const opt = exe.readUInt16LE(peOff + 20);
const magic = exe.readUInt16LE(peOff + 24);
const numDirs = exe.readUInt32LE(peOff + 24 + (magic === 0x10b ? 0x60 : 0x70));
const dirBase = peOff + 24 + (magic === 0x10b ? 0x60 : 0x70) + 4;
const names = ['Export', 'Import', 'Resource', 'Exception', 'Security', 'BaseReloc', 'Debug', 'Architecture', 'GlobalPtr', 'TLS', 'LoadConfig', 'BoundImport', 'IAT', 'DelayImport', 'COM', 'Reserved'];
console.log(`magic=0x${magic.toString(16)} numDirs=${numDirs}`);
for (let i = 0; i < numDirs && i < names.length; i++) {
  const rva = exe.readUInt32LE(dirBase + i * 8);
  const size = exe.readUInt32LE(dirBase + i * 8 + 4);
  console.log(`  [${i}] ${names[i].padEnd(12)} rva=0x${rva.toString(16)} size=0x${size.toString(16)}`);
}
