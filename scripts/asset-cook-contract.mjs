#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LEGACY_PATTERNS = [
  {
    label: ['relative', 'Url'].join(''),
    pattern: new RegExp(`\\b${['relative', 'Url'].join('')}\\b`),
  },
  {
    label: ['from', 'Catalog', 'Entry'].join(''),
    pattern: new RegExp(`\\b${['from', 'Catalog', 'Entry'].join('')}\\b`),
  },
  {
    label: ['UPSTREAM', 'ENTRY', '_'].join(''),
    pattern: new RegExp(`${['UPSTREAM', 'ENTRY', '_'].join('')}`),
  },
  { label: 'raw-container suffix', pattern: /endsWith\(['"]\.bin['"]\)/ },
];

const CHANNELS = {
  typescript: [
    'packages/assets-runtime/src',
    'packages/vite-plugin-pack/src',
    'packages/types/src',
  ],
  compiled: ['apps/hello', 'scripts'],
  json: ['apps/hello', 'packages/runtime/assets/builtin'],
};

const FIXTURES = [
  'apps/hello/cube/assets/cube-mesh.pack.json',
  'apps/hello/room/assets/room.pack.json',
  'apps/hello/scene-nesting/assets/outer-scene.pack.json',
  'packages/runtime/assets/builtin/cube.pack.json',
];

function walk(root, extensions, files = []) {
  if (root.includes('/__tests__/') || root.endsWith('/asset-cook-contract.mjs')) return files;
  if (!existsSync(root)) return files;
  const stat = statSync(root);
  if (stat.isFile()) {
    if (extensions.has(root.slice(root.lastIndexOf('.')))) files.push(root);
    return files;
  }
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === 'build')
      continue;
    walk(join(root, entry), extensions, files);
  }
  return files;
}

function readCandidates(root, roots, extensions) {
  return roots.flatMap((path) => walk(resolve(root, path), extensions));
}

export function scanAssetCookContract(root = process.cwd()) {
  const errors = [];
  const channels = [
    ['typescript-import', readCandidates(root, CHANNELS.typescript, new Set(['.ts', '.tsx']))],
    ['compiled-fixture', readCandidates(root, CHANNELS.compiled, new Set(['.mjs', '.cjs']))],
    ['json-meta-pack', readCandidates(root, CHANNELS.json, new Set(['.json']))],
  ];

  for (const [channel, files] of channels) {
    if (files.length === 0) errors.push(`${channel}: no files scanned`);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const legacy of LEGACY_PATTERNS) {
        if (legacy.pattern.test(source)) errors.push(`${channel}: ${legacy.label}: ${file}`);
      }
    }
  }

  for (const fixture of FIXTURES) {
    const path = resolve(root, fixture);
    if (!existsSync(path)) {
      errors.push(`missing fixture: ${fixture}`);
      continue;
    }
    const pack = JSON.parse(readFileSync(path, 'utf8'));
    if (pack.schemaVersion !== '2.0.0' || pack.kind !== 'internal-text-package')
      errors.push(`not Pack v2: ${fixture}`);
    if (!Array.isArray(pack.assets) || pack.assets.some((asset) => asset.artifacts === undefined))
      errors.push(`asset-local artifacts missing: ${fixture}`);
  }

  return { ok: errors.length === 0, channels, errors };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = scanAssetCookContract(process.cwd());
  for (const [channel, files] of result.channels)
    console.log(`[asset-cook-contract] ${channel}: ${files.length} files`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`[asset-cook-contract] ${error}`);
    process.exitCode = 1;
  } else {
    console.log('[asset-cook-contract] PASS - Pack v2/local artifact contract is clean');
  }
}
