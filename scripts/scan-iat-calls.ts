/**
 * Scan .text for `call dword ptr [0x42XXXX]` (indirect IAT calls) and group by
 * resolved import name. Prints every call site of a given API, or all sites if
 * no filter given.
 *
 * Usage: node scripts/scan-iat-calls.ts [<exe>] [<name-filter-regex>]
 */
import { readFile } from 'node:fs/promises';

async function main(): Promise<void> {
  const exe = process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe';
  const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const peOff = dv.getUint32(0x3c, true);
  const numSections = dv.getUint16(peOff + 6, true);
  const optSize = dv.getUint16(peOff + 20, true);
  const imgBase = dv.getUint32(peOff + 24 + 28, true);
  const secTab = peOff + 24 + optSize;

  const secs: Array<{ va: number; vsize: number; raw: number; rsize: number; name: string }> = [];
  for (let i = 0; i < numSections; i++) {
    const off = secTab + i * 40;
    const name = String.fromCharCode(...buf.subarray(off, off + 8)).replace(/\0/g, '');
    secs.push({
      name,
      va: dv.getUint32(off + 12, true),
      vsize: dv.getUint32(off + 8, true),
      raw: dv.getUint32(off + 20, true),
      rsize: dv.getUint32(off + 16, true),
    });
  }
  const rvaToOff = (rva: number): number | null => {
    for (const s of secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) return s.raw + (rva - s.va);
    }
    return null;
  };
  const vaToOff = (va: number): number | null => rvaToOff(va - imgBase);

  // Resolve import name for an IAT address (0x42a270 -> DLL!Func).
  const impDirRva = dv.getUint32(peOff + 24 + 104, true);
  const impOff = rvaToOff(impDirRva);
  const iatName = new Map<number, string>();
  if (impOff !== null) {
    for (let d = 0; d < 64; d++) {
      const desc = impOff + d * 20;
      const nameRva = dv.getUint32(desc + 12, true);
      const iatRva = dv.getUint32(desc + 16, true);
      if (!nameRva || !iatRva) break;
      const nameOff = rvaToOff(nameRva);
      if (nameOff === null) continue;
      let dllName = '';
      for (let i = nameOff; buf[i]; i++) dllName += String.fromCharCode(buf[i]);
      // Walk the IAT (first thunk == IAT for x86) resolving hint/name entries.
      const firstThunkRva = dv.getUint32(desc + 16, true);
      const firstThunkOff = rvaToOff(firstThunkRva);
      if (firstThunkOff === null) continue;
      for (let idx = 0; ; idx++) {
        const entry = dv.getUint32(firstThunkOff + idx * 4, true);
        if (!entry) break;
        const iatVa = imgBase + firstThunkRva + idx * 4;
        const hintOff = rvaToOff(entry & 0x7fffffff);
        let fnName = '';
        if (hintOff !== null) {
          for (let i = hintOff + 2; buf[i]; i++) fnName += String.fromCharCode(buf[i]);
        }
        iatName.set(iatVa, `${dllName}!${fnName}`);
      }
    }
  }

  // Walk .text looking for `FF 15 <iat-va-le>` (call dword ptr [abs]).
  const text = secs.find((s) => s.name === '.text');
  if (!text) {
    console.error('no .text');
    process.exit(2);
  }
  const out: Array<{ va: number; name: string }> = [];
  for (let off = text.raw; off < text.raw + text.rsize - 6; off++) {
    if (buf[off] === 0xff && buf[off + 1] === 0x15) {
      const iatVa = dv.getUint32(off + 2, true);
      const name = iatName.get(iatVa) ?? `?0x${iatVa.toString(16)}`;
      if (!filter || filter.test(name)) {
        out.push({ va: imgBase + (off - text.raw) + text.va, name });
      }
    }
  }
  if (filter) {
    for (const { va, name } of out) console.log(`0x${va.toString(16)}  ${name}`);
  } else {
    // Group by name.
    const byName = new Map<string, number[]>();
    for (const { va, name } of out) {
      const key = name.split('!')[1] ?? name;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(va);
    }
    for (const [name, vas] of [...byName.entries()].sort()) {
      console.log(`${name}: ${vas.length} sites`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
