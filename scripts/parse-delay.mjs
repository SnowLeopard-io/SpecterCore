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
// descriptor at VA 0x1041e20 -> rva 0x41e20
const descRva = 0x41e20;
const doff = rvaToOff(descRva);
const grAttrs = dv.getUint32(doff, true);
const rvaDLLName = dv.getUint32(doff + 4, true);
const rvaHmod = dv.getUint32(doff + 8, true);
const rvaIAT = dv.getUint32(doff + 12, true);
const rvaINT = dv.getUint32(doff + 16, true);
const nameOff = rvaToOff(rvaDLLName);
let dllName = '';
for (let i = nameOff; i < buf.length; i++) { if (buf[i] === 0) break; dllName += String.fromCharCode(buf[i]); }
console.error('grAttrs', grAttrs, 'dllName', dllName);
console.error('rvaIAT', rvaIAT.toString(16), 'rvaINT', rvaINT.toString(16));
// INT entries: array of RVAs (each 4 bytes, high bit set => ordinal, else RVA to IMAGE_IMPORT_BY_NAME {hint(2), name})
const iatOff = rvaToOff(rvaIAT);
const intOff = rvaToOff(rvaINT);
const names = [];
for (let k = 0; k < 200; k++) {
  const r = dv.getUint32(intOff + k * 4, true);
  if (r === 0) break;
  if (r & 0x80000000) { names.push(`ord=${r & 0xffff}`); continue; }
  const no = rvaToOff(r);
  if (no < 0) break;
  let nm = '';
  for (let i = no + 2; i < buf.length; i++) { if (buf[i] === 0) break; nm += String.fromCharCode(buf[i]); }
  names.push(nm);
}
console.error('imports:', names.join(', '));
