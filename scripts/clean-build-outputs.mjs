#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.env.FORGEAX_REPO_ROOT ?? '.');
const roots = [];

function collect(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = resolve(directory, entry.name);
    const manifestPath = resolve(child, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.scripts?.build) roots.push(resolve(child, 'dist'));
    } else collect(child);
  }
}

collect(resolve(root, 'packages'));
collect(resolve(root, 'apps'));
roots.push(resolve(root, 'shared-build-inputs'));

for (const directory of roots) {
  if (!existsSync(directory)) continue;
  rmSync(directory, { recursive: true, force: true });
  console.error(`[build-clean] removed ${directory}`);
}
