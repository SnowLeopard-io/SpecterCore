/** Dump PE section headers + image base. */
import { readFileSync } from 'node:fs';

const exe = readFileSync(process.argv[2]);
const peOff = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(peOff + 6);
const opt = exe.readUInt16LE(peOff + 20);
const magic = exe.readUInt16LE(peOff + 24);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
console.log(`peOff=0x${peOff.toString(16)} nsec=${nsec} optMagic=0x${magic.toString(16)} imageBase=0x${imageBase.toString(16)}`);
const st = peOff + 24 + opt;
for (let i = 0; i < nsec; i++) {
  const o = st + i * 40;
  const name = exe.toString('latin1', o, o + 8).replace(/\0/g, '');
  const vs = exe.readUInt32LE(o + 8);
  const va = exe.readUInt32LE(o + 12);
  const rs = exe.readUInt32LE(o + 16);
  const raw = exe.readUInt32LE(o + 20);
  console.log(
    `#${i} ${name.padEnd(8)} VA=0x${va.toString(16)} VSize=0x${vs.toString(16)} RawPtr=0x${raw.toString(16)} RawSize=0x${rs.toString(16)}`,
  );
}
