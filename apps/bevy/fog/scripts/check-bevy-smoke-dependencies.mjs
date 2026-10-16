#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(scriptsDir, '..');
const sourceDir = resolve(appDir, 'src');
const forbidden = ['PostProcessParams', 'createFullscreenRenderFeature', 'applySceneFog'];
const sourceFiles = ['fog.ts', 'main.ts', 'fog-feature.ts', 'fog.wgsl'];

for (const file of sourceFiles) {
  const path = resolve(sourceDir, file);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, 'utf8');
  for (const token of forbidden) {
    if (source.includes(token)) throw new Error(`${file} still owns legacy Fog token ${token}`);
  }
}

const packageJson = JSON.parse(readFileSync(resolve(appDir, 'package.json'), 'utf8'));
if (!String(packageJson.description).includes('Engine Fog component')) {
  throw new Error('Bevy Fog package must declare the Engine Fog component owner');
}
console.log('bevy-fog smoke dependencies: Engine Fog owner verified');
