import { readFileSync } from 'node:fs';

const buf = readFileSync('apps/web/public/win/cmd-x64.exe');
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const eLfanew = dv.getUint32(0x3c, true);
const optMagic = dv.getUint16(eLfanew + 24, true);
const is64 = optMagic === 0x20b;
const numSections = dv.getUint16(eLfanew + 6, true);
const optSize = dv.getUint16(eLfanew + 20, true);
const sectionBase = eLfanew + 24 + optSize;
const imageBase = is64 ? Number(dv.getBigUint64(eLfanew + 24 + 24, true)) : dv.getUint32(eLfanew + 24 + 28, true);

const secs = [];
for (let i = 0; i < numSections; i++) {
  const off = sectionBase + i * 40;
  const name = Buffer.from(buf.buffer, buf.byteOffset + off, 8).toString('latin1').replace(/\0/g, '');
  const va = dv.getUint32(off + 12, true);
  const raw = dv.getUint32(off + 20, true);
  const size = dv.getUint32(off + 16, true);
  secs.push({ name, va, raw, size });
}
const rvaToOff = (rva) => {
  for (const s of secs) if (rva >= s.va && rva < s.va + s.size) return s.raw + (rva - s.va);
  return -1;
};
const offToRva = (o) => {
  for (const s of secs) if (o >= s.raw && o < s.raw + s.size) return s.va + (o - s.raw);
  return -1;
};

// Step 1: find cookie-like qwords in .rdata: high bit set, low byte 0x00 (MSVC cookie invariant)
const rdata = secs.find((s) => s.name === '.rdata');
const cookies = [];
if (rdata) {
  for (let o = rdata.raw; o + 8 <= rdata.raw + rdata.size; o += 8) {
    const v = dv.getBigUint64(o, true);
    const lo = Number(v & 0xffn);
    const hi = Number((v >> 32n) & 0xffffffffn);
    if (lo === 0x00 && (hi & 0x80000000) !== 0) {
      cookies.push({ va: imageBase + (rdata.va + (o - rdata.raw)), off: o, val: '0x' + v.toString(16) });
    }
  }
}
console.error(`found ${cookies.length} candidate cookie globals`);
for (const c of cookies.slice(0, 20)) console.error(`  cookie @ VA 0x${c.va.toString(16)} = ${c.val}`);

// Step 2: count xrefs (rip-relative mem ops) into .rdata; the most-referenced qword is the cookie global
const text = secs.find((s) => s.name === '.text');
const rdataSec = secs.find((s) => s.name === '.rdata');
const counts = new Map();
if (text) {
  for (let i = 0; i + 7 <= text.size; i++) {
    const p = text.raw + i;
    const op = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
    const isRipMem = (op === 0x483b0d || op === 0x483b05 || op === 0x488b05 || op === 0x488b0d);
    if (!isRipMem) continue;
    const disp = dv.getInt32(p + 3, true);
    const instrVA = imageBase + text.va + i + 7;
    const targetVA = instrVA + disp;
    const to = rvaToOff(targetVA - imageBase);
    if (to < 0) continue;
    if (!rdataSec || to < rdataSec.raw || to >= rdataSec.raw + rdataSec.size) continue;
    counts.set(targetVA, (counts.get(targetVA) ?? 0) + 1);
  }
}
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.error('\nmost-referenced .rdata globals (likely cookie):');
for (const [va, c] of sorted) {
  const to = rvaToOff(va - imageBase);
  const v = to >= 0 ? '0x' + dv.getBigUint64(to, true).toString(16) : '?';
  console.error(`  VA 0x${va.toString(16)}  xrefs=${c}  value=${v}`);
}
const top = sorted[0];
if (top) {
  const cookieVA = top[0];
  const refs = [];
  for (let i = 0; i + 7 <= text.size; i++) {
    const p = text.raw + i;
    const op = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2];
    const isRipMem = (op === 0x483b0d || op === 0x483b05 || op === 0x488b05 || op === 0x488b0d);
    if (!isRipMem) continue;
    const disp = dv.getInt32(p + 3, true);
    const instrVA = imageBase + text.va + i + 7;
    const targetVA = instrVA + disp;
    if (targetVA !== cookieVA) continue;
    const nextOff = p + 7;
    const b = buf[nextOff];
    let jmpLen = 0;
    if (b === 0x75) jmpLen = 2;
    else if (b === 0x0f && buf[nextOff + 1] === 0x85) jmpLen = 6;
    const isCheck = jmpLen > 0 && buf[nextOff + jmpLen] === 0xc3;
    const dump = [...buf.slice(p, p + 14)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
    refs.push({ va: imageBase + text.va + i, dump, isCheck });
  }
  console.error(`\nxrefs to top cookie candidate 0x${cookieVA.toString(16)}:`);
  for (const r of refs.slice(0, 10)) console.error(`  @ VA 0x${r.va.toString(16)}  ${r.dump}  ${r.isCheck ? '<== CHECK FUNCTION' : ''}`);
}

