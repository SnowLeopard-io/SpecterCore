/**
 * List notepad.exe imports (from the IAT) and flag any User32/COMCTL32/
 * comdlg32/kernel32-adjacent stdcall function missing from X86_API_ARG_COUNT
 * (their dynamic stubs would ret 0 and leak stack).
 */
import { readFile } from 'node:fs/promises';
import { X86_API_ARG_COUNT } from '../packages/core/src/pe/mapper';

async function main(): Promise<void> {
  const exe = process.argv[2] ?? 'C:/Windows/SysWOW64/notepad.exe';
  const buf = await readFile(exe);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pe = dv.getUint32(0x3c, true);
  const num = dv.getUint16(pe + 6, true);
  const optsz = dv.getUint16(pe + 20, true);
  const secTab = pe + 24 + optsz;
  const secs: Array<{ va: number; vs: number; raw: number; rs: number }> = [];
  for (let i = 0; i < num; i++) {
    const off = secTab + i * 40;
    secs.push({
      va: dv.getUint32(off + 12, true),
      vs: dv.getUint32(off + 8, true),
      raw: dv.getUint32(off + 20, true),
      rs: dv.getUint32(off + 16, true),
    });
  }
  const rva2off = (rva: number): number | null => {
    for (const s of secs) {
      if (rva >= s.va && rva < s.va + Math.max(s.vs, s.rs)) return s.raw + (rva - s.va);
    }
    return null;
  };
  const impRva = dv.getUint32(pe + 24 + 104, true);
  const impOff = rva2off(impRva);
  const missing: Array<[string, string]> = [];
  const present: Array<[string, string]> = [];
  if (impOff !== null) {
    for (let d = 0; d < 64; d++) {
      const desc = impOff + d * 20;
      const nameRva = dv.getUint32(desc + 12, true);
      const iatRva = dv.getUint32(desc + 16, true);
      if (!nameRva || !iatRva) break;
      const nameOff = rva2off(nameRva);
      if (nameOff === null) continue;
      let dll = '';
      for (let i = nameOff; buf[i]; i++) dll += String.fromCharCode(buf[i]);
      const thunkOff = rva2off(iatRva);
      if (thunkOff === null) continue;
      for (let idx = 0; ; idx++) {
        const entry = dv.getUint32(thunkOff + idx * 4, true);
        if (!entry) break;
        const hintOff = rva2off(entry & 0x7fffffff);
        let fn = '';
        if (hintOff !== null) for (let i = hintOff + 2; buf[i]; i++) fn += String.fromCharCode(buf[i]);
        if (!fn) continue;
        const key = fn.toLowerCase();
        if (X86_API_ARG_COUNT[key] !== undefined) present.push([dll, fn]);
        else missing.push([dll, fn]);
      }
    }
  }
  console.log('=== MISSING from X86_API_ARG_COUNT ===');
  for (const [dll, fn] of missing.sort()) console.log(`  ${dll}!${fn}`);
  console.log(`=== present: ${present.length} funcs ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
