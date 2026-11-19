#!/usr/bin/env node
// Pack owns offline source/evidence. Games use AssetRegistry.load at runtime;
// that valid API must not pull runtime ownership into Pack's production code.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const patterns = [
  String.raw`engine\s*\.\s*assets\s*\.\s*load\s*\(`,
  "['\"`]@forgeax/engine([/-](assets-runtime|runtime)(/[^'\"`]*)?)?['\"`]",
];
const forbidden = new RegExp(patterns.join('|'), 'u');
const hits = [];
function scan(directory) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') scan(path);
    } else if (!entry.name.endsWith('.d.ts')) {
      const lines = readFileSync(resolve(root, path), 'utf8').split(/\r?\n/u);
      for (let index = 0; index < lines.length; index++)
        if (forbidden.test(lines[index])) hits.push(`${path}:${index + 1}:${lines[index]}`);
    }
  }
}
scan('packages/pack/src');
if (hits.length === 0) process.exit(0);
process.stderr.write(
  '[check-no-assets-load] FAIL: runtime loading or imports found in packages/pack/src.\n' +
  'Keep Pack source/evidence offline; inject the build-time AssetReader.\n\n' +
  hits.join('\n') + '\n',
);
process.exit(1);
