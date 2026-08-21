/**
 * Dump the PE TLS directory (data directory index 10) + .tls section info.
 *   node pe-tls-dir.mjs <exe>
 */
import { readFileSync } from 'node:fs';

const exePath = process.argv[2];
if (!exePath) {
  console.error('usage: pe-tls-dir <exe>');
  process.exit(1);
}
const exe = readFileSync(exePath);
const peOff = exe.readUInt32LE(0x3c);
const nsec = exe.readUInt16LE(peOff + 6);
const opt = exe.readUInt16LE(peOff + 20);
const magic = exe.readUInt16LE(peOff + 24);
const imageBase = exe.readUInt32LE(peOff + 24 + 28);
const st = peOff + 24 + opt;
const secs: Array<{ va: number; vs: number; raw: number; rs: number; name: string }> = [];
for (let i = 0; i < nsec; i++) {
  const o = st + i * 40;
  secs.push({
    va: exe.readUInt32LE(o + 12),
    vs: exe.readUInt32LE(o + 8),
    raw: exe.readUInt32LE(o + 20),
    rs: exe.readUInt32LE(o + 16),
    name: exe.toString('latin1', o, o + 8).replace(/\0/g, ''),
  });
}
const rva2off = (rva: number): number | undefined => {
  for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return s.raw + (rva - s.va);
  return undefined;
};

// Data directory 9 = TLS. DataDirectory starts at optional header + 0x60 (PE32
// and PE32+), so TLS = 0x60 + 9*8 = 0xa8.
const tlsOff = peOff + 24 + 0xa8;
const tlsRva = exe.readUInt32LE(tlsOff);
const tlsSize = exe.readUInt32LE(tlsOff + 4);
console.log(`imageBase=0x${imageBase.toString(16)} magic=0x${magic.toString(16)}`);
console.log(`TLS dir: rva=0x${tlsRva.toString(16)} size=0x${tlsSize.toString(16)}`);
if (tlsRva) {
  const off = rva2off(tlsRva);
  console.log(`TLS dir file off=0x${off?.toString(16) ?? '?'}`);
  if (off !== undefined) {
    const startRaw = exe.readUInt32LE(off);
    const endRaw = exe.readUInt32LE(off + 4);
    const index = exe.readUInt32LE(off + 8);
    const callbacks = exe.readUInt32LE(off + 12);
    const zeroFill = exe.readUInt32LE(off + 16);
    const characteristics = exe.readUInt32LE(off + 20);
    console.log(`  StartAddressOfRawData=0x${startRaw.toString(16)} End=0x${endRaw.toString(16)}`);
    console.log(`  AddressOfIndex=0x${index.toString(16)} AddressOfCallBacks=0x${callbacks.toString(16)}`);
    console.log(`  SizeOfZeroFill=0x${zeroFill.toString(16)} Characteristics=0x${characteristics.toString(16)}`);
    // Dump the TLS template bytes (Start..End)
    const startOff = rva2off(startRaw - imageBase);
    const len = endRaw - startRaw;
    console.log(`  TLS template: off=0x${startOff?.toString(16) ?? '?'} len=0x${len.toString(16)}`);
    if (startOff !== undefined && len <= 0x1000) {
      const bytes = exe.subarray(startOff, startOff + len);
      console.log(`  template bytes: ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  }
}
console.log('sections:');
for (const s of secs) {
  console.log(`  ${s.name.padEnd(8)} va=0x${s.va.toString(16)} vs=0x${s.vs.toString(16)} raw=0x${s.raw.toString(16)} rs=0x${s.rs.toString(16)}`);
}
