import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const bevyRoot = join(process.cwd(), 'apps', 'bevy');

test('Bevy smoke scripts declare every direct ForgeaX package import', () => {
  const missing = [];
  for (const app of readdirSync(bevyRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appRoot = join(bevyRoot, app.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ]);
    let scripts;
    try {
      scripts = readdirSync(join(appRoot, 'scripts'));
    } catch {
      continue;
    }
    for (const file of scripts.filter((name) => name.endsWith('.mjs'))) {
      const source = readFileSync(join(appRoot, 'scripts', file), 'utf8');
      const imports = source.matchAll(/(?:from\s+|import\()\s*['"](@forgeax\/[^/'"]+)/g);
      for (const match of imports) {
        const packageName = match[1];
        if (!declared.has(packageName)) missing.push(`${app.name}/${file}: ${packageName}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
