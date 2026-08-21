import { readFileSync } from 'node:fs';
const buf = readFileSync('apps/web/public/win/cmd-x64.exe');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const eLfanew = dv.getUint32(0x3c, true);
const optSize = dv.getUint16(eLfanew + 20, true);
const sectionBase = eLfanew + 24 + optSize;
const imageBase = Number(dv.getBigUint64(eLfanew + 24 + 24, true));
const secs = [];
const numSections = dv.getUint16(eLfanew + 6, true);
for (let i = 0; i < numSections; i++) {
  const off = sectionBase + i * 40;
  const name = Buffer.from(buf.buffer, buf.byteOffset + off, 8).toString('latin1').replace(/\0/g, '');
  secs.push({ name, va: dv.getUint32(off + 12, true), raw: dv.getUint32(off + 20, true), size: dv.getUint32(off + 16, true) });
}
const rvaToOff = (rva) => { for (const s of secs) if (rva >= s.va && rva < s.va + s.size) return s.raw + (rva - s.va); return -1; };
const intOff = rvaToOff(0x41e60);
console.error('intOff', intOff);
const names = [];
for (let k = 0; k < 64; k++) {
  const r = dv.getUint32(intOff + k * 4, true);
  if (r === 0) break;
  if (r & 0x80000000) { names.push('ord=' + (r & 0xffff)); continue; }
  const no = rvaToOff(r);
  let nm = '';
  for (let i = no + 2; i < buf.length; i++) { if (buf[i] === 0) break; nm += String.fromCharCode(buf[i]); }
  names.push(nm);
}
console.error('Wldp imports:', names.join(', '));
