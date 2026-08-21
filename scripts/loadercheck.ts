import { readFile } from 'node:fs/promises';
import { PeLoaderImpl } from '../packages/core/src/pe/loader';
import { WasmRuntimeImpl } from '../packages/core/src/jit/runtime';
import { mapPeImage } from '../packages/core/src/pe/mapper';
const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
const loader = new PeLoaderImpl();
const pe = await loader.load(image);
console.log('is64='+pe.is64+' base=0x'+pe.baseAddress.toString(16)+' entry=0x'+pe.entryPoint.toString(16));
console.log('imports count: '+pe.imports.length);
for(const imp of pe.imports){
  console.log('  '+imp.moduleName+' iatRva=0x'+imp.iatRva.toString(16)+' fns='+imp.functions.map(f=>f.name??'#'+f.ordinal).join(','));
}
const runtime = new WasmRuntimeImpl();
const mapped = mapPeImage(runtime, image, pe);
console.log('mapped base=0x'+mapped.baseAddress.toString(16)+' stubs='+mapped.stubs.length);
for(const s of [0x29890,0x298d8,0x29920,0x29928,0x29930,0x29938,0x2a218]){
  const a = mapped.baseAddress + s;
  const v = runtime.readInt32(a) >>> 0;
  console.log('runtime slot 0x'+s.toString(16)+' (addr 0x'+a.toString(16)+') = 0x'+v.toString(16)+'  high=0x'+(runtime.readInt32(a+4)>>>0).toString(16));
}
const st = mapped.stubs.find(x=>x.stubAddress===0x200350);
console.log('stub 0x200350 -> '+JSON.stringify(st));
