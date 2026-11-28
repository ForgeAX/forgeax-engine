#!/usr/bin/env node
// Public API ratchet for the `@forgeax/engine` facade.
//
//   node packages/engine/scripts/public-api.mjs                      check against the baseline
//   node packages/engine/scripts/public-api.mjs --write              lock in removals
//   node packages/engine/scripts/public-api.mjs --write --accept-increase   also accept new exports
//
// The baseline records, for every facade entry of a `game`, `addon` or
// `compat` tier package, the exported names read from source. A new export
// needs `--accept-increase` so it stays visible in review. Two rules accept no
// growth at all: a name exported by more than one recorded entry (one owner per
// symbol), and plan-ID comments such as `feat-20260704` in package sources.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import {
  engineApiTiers,
  publicEngineFacades,
  publicEngineMembers,
  SNAPSHOT_API_TIERS,
} from './public-facades.mjs';

export const BASELINE_PATH = 'config/public-api-baseline.json';
export const PLAN_ID_PATTERN = /\b(?:feat|tweak|fix|refactor|perf|chore)-20\d{6}\b/g;

const TAG = '[public-api]';

function exportTarget(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const condition of ['types', 'import', 'node', 'browser', 'default']) {
    const target = exportTarget(value[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** Maps a package export target such as `./dist/foo/index.d.ts` to its source module. */
export function sourceModuleFor(packageRoot, target) {
  const relative = target
    .replace(/^\.\/(?:dist|src)\//, '')
    .replace(/\.(?:d\.ts|d\.mts|mjs|js|cjs|ts|tsx)$/, '');
  const stems = [relative, relative.replace(/-compiled$/, '')];
  for (const stem of stems) {
    for (const candidate of [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}/index.ts`]) {
      const path = resolve(packageRoot, candidate);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
}

function facadeSources(members) {
  const byName = new Map(members.map((member) => [member.name, member]));
  const sources = new Map();
  for (const facade of publicEngineFacades(members)) {
    const [, packageName, subpath] = /^(@forgeax\/engine-[^/]+)(?:\/(.+))?$/.exec(facade.source);
    const member = byName.get(packageName);
    const exportKey = subpath === undefined ? '.' : `./${subpath}`;
    const target =
      member.exports === undefined || member.exports === null
        ? './src/index.ts'
        : exportTarget(member.exports[exportKey]);
    sources.set(facade.subpath, {
      directory: member.directory,
      specifier: facade.source,
      module: target === undefined ? undefined : sourceModuleFor(member.packageRoot, target),
    });
  }
  return sources;
}

/**
 * Maps every workspace package export (facaded or not, e.g. a kernel package a
 * facade re-exports from) to its source module, so the scan never depends on
 * built `dist` output.
 */
function workspaceSourcePaths(repositoryRoot) {
  const paths = {};
  for (const entry of readdirSync(resolve(repositoryRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = resolve(repositoryRoot, 'packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (typeof manifest.name !== 'string') continue;
    const exportMap =
      manifest.exports && typeof manifest.exports === 'object' && !Array.isArray(manifest.exports)
        ? manifest.exports
        : { '.': manifest.types ?? manifest.main ?? './src/index.ts' };
    for (const [key, value] of Object.entries(exportMap)) {
      if (key === './package.json' || key.includes('*')) continue;
      const target = exportTarget(value);
      const module = target === undefined ? undefined : sourceModuleFor(packageRoot, target);
      if (module !== undefined) paths[`${manifest.name}${key === '.' ? '' : key.slice(1)}`] = [module];
    }
  }
  return paths;
}

/**
 * Reads the exported names of every snapshot-tier facade entry from source,
 * and the declaration each name resolves to (its owner identity).
 */
export function readPublicExports(repositoryRoot, members, tiers) {
  const sources = facadeSources(members);
  const paths = workspaceSourcePaths(repositoryRoot);
  for (const source of sources.values()) {
    if (source.module !== undefined) paths[source.specifier] = [source.module];
  }
  const recorded = [...sources].filter(([, { directory }]) =>
    SNAPSHOT_API_TIERS.includes(tiers.get(directory)),
  );
  const unresolved = recorded.filter(([, { module }]) => module === undefined);
  if (unresolved.length > 0) {
    throw new Error(`public-api-source-unresolved: ${unresolved.map(([subpath]) => subpath).join(', ')}`);
  }
  const program = ts.createProgram(
    recorded.map(([, { module }]) => module),
    {
      allowJs: true,
      allowImportingTsExtensions: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      paths,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  );
  const checker = program.getTypeChecker();
  const entries = {};
  const identities = {};
  const unresolvedExports = [];
  for (const [subpath, { module }] of recorded.sort(([a], [b]) => a.localeCompare(b))) {
    const sourceFile = program.getSourceFile(module);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    const names = [];
    identities[subpath] = {};
    for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      let target = symbol;
      if (target.flags & ts.SymbolFlags.Alias) target = checker.getAliasedSymbol(target);
      if (!target.declarations?.length) unresolvedExports.push(`${subpath} ${symbol.name}`);
      names.push(target.flags & ts.SymbolFlags.Value ? symbol.name : `type ${symbol.name}`);
      const declaration = target.declarations?.[0];
      identities[subpath][symbol.name] = declaration
        ? `${declaration.getSourceFile().fileName}:${declaration.pos}`
        : `${subpath}:${symbol.name}`;
    }
    entries[subpath] = [...new Set(names)].sort();
  }
  // An unresolved re-export would be classified by accident; fail instead.
  if (unresolvedExports.length > 0) {
    throw new Error(`public-api-export-unresolved: ${unresolvedExports.slice(0, 20).join(', ')}`);
  }
  return { entries, identities };
}

/**
 * One declaration re-exported from more than one recorded entry, keyed by its
 * exported name. Distinct declarations that share a name (an ECS component and
 * the Three.js class it mirrors) are separate owners, not duplicates.
 * `identities` maps each entry to `{ name: declarationIdentity }`.
 */
export function duplicateExports(identities) {
  const owners = new Map();
  for (const [subpath, names] of Object.entries(identities)) {
    for (const [name, identity] of Object.entries(names)) {
      if (name === 'default') continue;
      const key = `${identity}\u0000${name}`;
      const entry = owners.get(key) ?? { name, subpaths: [] };
      entry.subpaths.push(subpath);
      owners.set(key, entry);
    }
  }
  const duplicates = {};
  for (const { name, subpaths } of owners.values()) {
    if (subpaths.length < 2) continue;
    duplicates[name] = [...new Set([...(duplicates[name] ?? []), ...subpaths])].sort();
  }
  return Object.fromEntries(Object.entries(duplicates).sort(([a], [b]) => a.localeCompare(b)));
}

function sourceFiles(directory) {
  const files = [];
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|mts)$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Plan-ID comment counts per public package source tree. */
export function planIdCounts(members) {
  const counts = {};
  for (const { directory, packageRoot } of members) {
    let count = 0;
    for (const file of sourceFiles(resolve(packageRoot, 'src'))) {
      count += readFileSync(file, 'utf8').match(PLAN_ID_PATTERN)?.length ?? 0;
    }
    if (count > 0) counts[directory] = count;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export async function scanPublicApi(repositoryRoot) {
  const members = await publicEngineMembers(repositoryRoot);
  const tiers = await engineApiTiers(repositoryRoot, members);
  const { entries, identities } = readPublicExports(repositoryRoot, members, tiers);
  return { entries, duplicates: duplicateExports(identities), planIds: planIdCounts(members) };
}

/**
 * Compares a scan with the baseline. `growth` may be accepted with
 * `--accept-increase`; `violations` never may; `stale` asks for `--write`.
 */
export function comparePublicApi(scan, baseline) {
  const growth = [];
  const violations = [];
  const stale = [];
  const subpaths = new Set([...Object.keys(scan.entries), ...Object.keys(baseline.entries)]);
  for (const subpath of [...subpaths].sort()) {
    const current = new Set(scan.entries[subpath] ?? []);
    const allowed = new Set(baseline.entries[subpath] ?? []);
    for (const name of current) if (!allowed.has(name)) growth.push(`export ${subpath} ${name}`);
    for (const name of allowed) if (!current.has(name)) stale.push(`export ${subpath} ${name}`);
  }
  for (const [name, subpaths] of Object.entries(scan.duplicates)) {
    const allowed = new Set(baseline.duplicates[name] ?? []);
    const added = subpaths.filter((subpath) => !allowed.has(subpath));
    if (added.length > 0) violations.push(`duplicate ${name} also exported by ${added.join(', ')}`);
  }
  for (const [name, subpaths] of Object.entries(baseline.duplicates)) {
    const current = new Set(scan.duplicates[name] ?? []);
    if (subpaths.some((subpath) => !current.has(subpath))) stale.push(`duplicate ${name}`);
  }
  const packages = new Set([...Object.keys(scan.planIds), ...Object.keys(baseline.planIds)]);
  for (const directory of [...packages].sort()) {
    const current = scan.planIds[directory] ?? 0;
    const allowed = baseline.planIds[directory] ?? 0;
    if (current > allowed) violations.push(`plan-id ${directory} ${current} > ${allowed}`);
    else if (current < allowed) stale.push(`plan-id ${directory} ${current} < ${allowed}`);
  }
  return { growth, violations, stale };
}

export function readBaseline(repositoryRoot) {
  const path = resolve(repositoryRoot, BASELINE_PATH);
  if (!existsSync(path)) return { entries: {}, duplicates: {}, planIds: {} };
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  return {
    entries: baseline.entries ?? {},
    duplicates: baseline.duplicates ?? {},
    planIds: baseline.planIds ?? {},
  };
}

/** Writes the baseline and formats it with the workspace Biome, as `pnpm lint` checks it. */
export function writeBaseline(repositoryRoot, scan) {
  const path = resolve(repositoryRoot, BASELINE_PATH);
  writeFileSync(path, serializeBaseline(scan));
  const biome = createRequire(resolve(repositoryRoot, 'package.json')).resolve(
    '@biomejs/biome/bin/biome',
  );
  const formatted = spawnSync(process.execPath, [biome, 'format', '--write', path], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (formatted.status !== 0) {
    throw new Error(`baseline format failed: ${formatted.stderr || formatted.stdout}`);
  }
}

export function serializeBaseline(scan) {
  const entries = Object.fromEntries(
    Object.entries(scan.entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify({ entries, duplicates: scan.duplicates, planIds: scan.planIds }, null, 2)}\n`;
}

async function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  let write = false;
  let acceptIncrease = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') root = resolve(argv[++index]);
    else if (arg === '--write') write = true;
    else if (arg === '--accept-increase') acceptIncrease = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (acceptIncrease && !write) throw new Error('--accept-increase requires --write');
  const scan = await scanPublicApi(root);
  // The first baseline records today's surface, including existing duplicates.
  const initial = !existsSync(resolve(root, BASELINE_PATH));
  if (initial && write && acceptIncrease) {
    writeBaseline(root, scan);
    process.stdout.write(`${TAG} created ${BASELINE_PATH} entries=${Object.keys(scan.entries).length}\n`);
    return 0;
  }
  const { growth, violations, stale } = comparePublicApi(scan, readBaseline(root));
  const lines = [
    ...violations.map((line) => `${TAG} FAIL ${line}`),
    ...(acceptIncrease ? [] : growth.map((line) => `${TAG} FAIL new ${line}`)),
  ];
  if (write) {
    if (lines.length > 0) {
      process.stderr.write(`${lines.join('\n')}\n${TAG} baseline not written\n`);
      return 1;
    }
    writeBaseline(root, scan);
    process.stdout.write(
      `${TAG} wrote ${BASELINE_PATH} entries=${Object.keys(scan.entries).length} accepted=${growth.length} removed=${stale.length}\n`,
    );
    return 0;
  }
  lines.push(...stale.map((line) => `${TAG} FAIL stale ${line}`));
  if (lines.length > 0) {
    process.stderr.write(`${lines.join('\n')}\n`);
    if (growth.length > 0 && violations.length === 0) {
      process.stderr.write(
        `${TAG} HINT a new export is public API; prefer an existing owner, or accept it with \`pnpm check:public-api --write --accept-increase\`.\n`,
      );
    }
    if (stale.length > 0) {
      process.stderr.write(`${TAG} HINT the surface shrank; run \`pnpm check:public-api --write\` to lock it in.\n`);
    }
    return 1;
  }
  const names = Object.values(scan.entries).reduce((sum, names) => sum + names.length, 0);
  process.stdout.write(`${TAG} ok entries=${Object.keys(scan.entries).length} exports=${names}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${TAG} setup error: ${String(error?.message ?? error)}\n`);
      process.exit(2);
    },
  );
}
