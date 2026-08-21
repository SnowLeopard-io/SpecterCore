/**
 * Dump imports using the engine's own PeLoaderImpl (matches what the JIT sees).
 *
 *   node loader-imp.mjs <exe>
 */
import { readFileSync } from 'node:fs';
import { PeLoaderImpl } from '@specter-core/core';

const [exePath] = process.argv.slice(2);
if (!exePath) {
  console.error('usage: loader-imp <exe>');
  process.exit(1);
}
const image = new Uint8Array(readFileSync(exePath));
const loader = new PeLoaderImpl();
const pe = await loader.load(image);
for (const imp of pe.imports) {
  for (const fn of imp.functions) {
    console.log(`${imp.moduleName}.${fn.name ?? `#${fn.ordinal}`}`);
  }
}
console.log(`\n[loader-imp] ${pe.imports.reduce((a, i) => a + i.functions.length, 0)} imports`);
