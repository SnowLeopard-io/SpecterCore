import { readFile } from 'node:fs/promises';
import { PeLoaderImpl } from '@specter-core/core';
async function main() {
  const image = new Uint8Array(await readFile('apps/web/public/win/notepad-x64.exe'));
  const pe = await new PeLoaderImpl().load(image);
  for (const imp of pe.imports) {
    const fns = imp.functions.map((f,i)=>`[${i}]${f.name??'#'+(f.ordinal??0)}@slot0x${(imp.iatRva+i*8).toString(16)}`);
    const hit = fns.filter(s=>/rogetactivationfactory|protectionpolicy|winrt|windowscreatestring|resolvedelayload/i.test(s));
    if (hit.length) console.log(`${imp.moduleName}: ${hit.join(', ')} (iatRva=0x${imp.iatRva.toString(16)})`);
  }
  // find any import whose iat range covers 0x2a450
  for (const imp of pe.imports) {
    const last = imp.iatRva + imp.functions.length*8;
    if (imp.iatRva<=0x2a450 && last>0x2a450) console.log('COVERS 0x2a450:', imp.moduleName, 'iatRva=0x'+imp.iatRva.toString(16), 'n='+imp.functions.length);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
