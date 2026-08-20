import { readFile } from 'node:fs/promises';
const src = await readFile('scripts/trace-x64.ts', 'utf8');
console.log(src);
