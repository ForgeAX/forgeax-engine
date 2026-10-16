#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const bevyRoot = 'apps/bevy';
const missing = [];

for (const entry of readdirSync(bevyRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const appDir = join(bevyRoot, entry.name);
  if (!existsSync(join(appDir, 'package.json'))) continue;
  const packageJson = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
  const smokePath = join(appDir, 'scripts', 'smoke-dawn.mjs');
  let source;
  try {
    source = readFileSync(smokePath, 'utf8');
  } catch {
    continue;
  }

  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
  const imports = source.matchAll(
    /(?:import\s*(?:[^'"()]*(?:from\s*)?)?|import\s*\()['"](@forgeax\/[^/'"]+)/g,
  );
  for (const match of imports) {
    const dependency = match[1];
    if (dependency !== undefined && !declared.has(dependency)) {
      missing.push(`${packageJson.name}: ${dependency}`);
    }
  }
}

if (missing.length > 0) {
  console.error('[bevy-smoke-dependencies] missing package declarations:');
  for (const dependency of missing) console.error(`  ${dependency}`);
  process.exit(1);
}

console.log('[bevy-smoke-dependencies] PASS');
