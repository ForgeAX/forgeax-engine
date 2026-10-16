import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const manifests = new Map();
for (const directory of readdirSync('packages', { withFileTypes: true })) {
  if (!directory.isDirectory()) continue;
  const path = join('packages', directory.name, 'package.json');
  if (!existsSync(path)) continue;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifests.set(manifest.name, manifest);
}

const root = '@forgeax/engine-render';
const target = '@forgeax/engine-animation';
const queue = [[root]];
const visited = new Set();

while (queue.length > 0) {
  const path = queue.shift();
  const current = path.at(-1);
  if (!current || visited.has(current)) continue;
  visited.add(current);
  if (current === target) {
    console.error(`[fail] render reaches animation through ${path.join(' -> ')}`);
    process.exit(1);
  }
  const manifest = manifests.get(current);
  if (!manifest) continue;
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    if (manifests.has(dependency)) queue.push([...path, dependency]);
  }
}

console.log('[ok] render package has no declared path to animation');
