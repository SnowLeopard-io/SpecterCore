import { readFile } from 'node:fs/promises';
const src = await readFile('packages/core/src/pe/mapper.ts','utf8');
const lines = src.split('\n');
// find where IAT slots are patched
const markers = lines.map((l,i)=>[i,l]).filter(([i,l])=>l.includes('iatRva')||l.includes('writeImportStubs')||l.includes('imports')||l.includes('stubAddr')||l.includes('relocation'));
for (const [i,l] of markers.slice(0,40)) console.log(String(i+1).padStart(4)+': '+l);
