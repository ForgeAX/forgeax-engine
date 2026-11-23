#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  json: ['apps/hello'],
};

const LEGACY_SCRIPTABLE_AUTHORING =
  /schemaVersion:\s*['"]1\.0\.0['"]|\bexternalAssets\b|ScriptablePack(?:Definition|Outputs|AssetDeclaration)|output\.add\(|canonical-v1|BROTATO_ASSET_GUIDS|OUTPUT_GUIDS/;

export async function scanPackAuthoring(root) {
  const { parsePackSourceJson } = await import('@forgeax/engine-pack/source');
  const assetRepository = resolve(root, 'forgeax-engine-assets');
  const errors = [];
  let count = 0;
  for (const cwd of [
    root,
    ...(existsSync(join(assetRepository, '.git')) ? [assetRepository] : []),
  ]) {
    const files = execFileSync(
      'git',
      [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        '*.pack.json',
        'templates/*.pack.ts',
      ],
      { cwd, encoding: 'utf8' },
    );
    for (const name of new Set(files.split('\0').filter(Boolean))) {
      if (/(^|\/)tsconfig\./.test(name)) continue;
      const path = resolve(cwd, name);
      if (!existsSync(path)) continue;
      count++;
      try {
        const source = readFileSync(path, 'utf8');
        if (name.endsWith('.ts')) {
          if (!/\bdefinePack\s*\(/.test(source) || LEGACY_SCRIPTABLE_AUTHORING.test(source)) {
            errors.push(`invalid template Pack authoring: ${name}`);
          }
        } else {
          const parsed = parsePackSourceJson(JSON.parse(source));
          if (!parsed.ok) errors.push(`${name}: ${parsed.error.hint}`);
        }
      } catch (error) {
        errors.push(`${name}: ${error.message}`);
      }
    }
  }
  for (const name of ['asset-ids.ts', 'asset-ids.generated.ts']) {
    const path = `templates/game-3d/src/${name}`;
    if (existsSync(resolve(root, path))) errors.push(`${path}: generated output identity table`);
  }
  return { count, errors };
}

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

  return { ok: errors.length === 0, channels, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let errors;
  if (process.argv.includes('--authoring')) {
    const audit = await scanPackAuthoring(process.cwd()).catch((error) => {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      throw new Error('Build the Engine before auditing Pack authoring: pnpm build:engine', {
        cause: error,
      });
    });
    console.log(`[asset-cook-contract] audited ${audit.count} Pack source files`);
    errors = audit.errors;
  } else {
    const transport = scanAssetCookContract();
    for (const [channel, files] of transport.channels)
      console.log(`[asset-cook-contract] ${channel}: ${files.length} files`);
    errors = transport.errors;
  }
  for (const error of errors) console.error(`[asset-cook-contract] ${error}`);
  if (errors.length > 0) process.exitCode = 1;
}
