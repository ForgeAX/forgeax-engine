#!/usr/bin/env node
// ECS contracts have one public owner; the Engine umbrella may forward them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GATED_SYMBOLS = [
  'SchemaFieldType', 'EcsErrorCode', 'EcsError', 'TypedArrayFor',
  'System', 'SystemToken', 'SystemSet', 'SystemOrderReference', 'ScheduleToken',
  'Resource', 'defineResource', 'defineSystem', 'defineSystemSet', 'defineSchedule',
  'Update', 'FixedUpdate', 'Time', 'FixedTime', 'TimeDeltaInvalidError',
  'TimeConfigInvalidError', 'ScheduleScopeMismatchError',
];

const SYM_GROUP = `(${GATED_SYMBOLS.join('|')})`;
const RE_NAMED = new RegExp(
  String.raw`export\s+(?:type\s+)?\{[^}]*\b${SYM_GROUP}\b[^}]*\}\s*from\s*['"][^'"]*engine-ecs['"]`,
  'm',
);
const RE_STAR = /export\s+\*\s+(?:as\s+\w+\s+)?from\s*['"][^'"]*engine-ecs['"]/m;

const PACKAGES_DIR = process.argv[2] ?? 'packages';
// Allowlisted packages that ARE the engine-ecs surface itself.
const SELF_PACKAGES = new Set(['ecs']);
const exts = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', 'tests']);
const hits = [];

function walk(dir, pkgName) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(p, pkgName);
    } else if (exts.has(p.slice(p.lastIndexOf('.')))) {
      // Skip declaration files — they cannot affect runtime bundle resolution
      // and TS type-only re-export through .d.ts is harmless for the
      // single-import-path AI affordance (the IDE still routes to engine-ecs).
      if (p.endsWith('.d.ts') || p.endsWith('.d.mts')) continue;
      const text = readFileSync(p, 'utf8');
      const namedMatch = text.match(RE_NAMED);
      if (namedMatch) {
        hits.push({ pkg: pkgName, path: p, hit: namedMatch[0].slice(0, 200) });
      }
      const starMatch = text.match(RE_STAR);
      if (starMatch) {
        hits.push({ pkg: pkgName, path: p, hit: starMatch[0].slice(0, 200) });
      }
    }
  }
}

let pkgEntries;
try {
  pkgEntries = readdirSync(PACKAGES_DIR);
} catch (e) {
  console.error(`[check-single-exit] cannot read ${PACKAGES_DIR}: ${e.message}`);
  process.exit(2);
}
for (const pkg of pkgEntries) {
  if (SELF_PACKAGES.has(pkg)) continue;
  const pkgPath = join(PACKAGES_DIR, pkg);
  let st;
  try {
    st = statSync(pkgPath);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  walk(pkgPath, pkg);
}

if (hits.length > 0) {
  console.error(
    '[check-single-exit] ownership violation: gated @forgeax/engine-ecs symbols re-exported outside packages/ecs:',
  );
  for (const h of hits) {
    console.error(`  - ${h.path}`);
    console.error(`      ${h.hit}`);
  }
  console.error('Import ECS contracts from @forgeax/engine-ecs or the Engine umbrella.');
  process.exit(1);
}

console.log(
  `[check-single-exit] OK — no @forgeax/engine-ecs gated symbols re-exported from other packages.`,
);
