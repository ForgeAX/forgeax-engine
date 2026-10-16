#!/usr/bin/env node
// AC-29: @forgeax/engine-ecs/src/**/*.ts must not value-import @forgeax/engine-runtime.
// feat-20260531-ecs-relationship-abstraction-bidirectional-sync M4 / t22.
//
// The relationship abstraction lets ECS components (ChildOf) name their mirror
// component (Children) by STRING (`relationship.mirror = 'Children'`) instead of
// by type reference. The mirror is resolved at hook time via
// World._getComponentByName, so engine-ecs never has to import the runtime-side
// ChildOf / Children tokens. This gate guards that boundary: a value-import of
// @forgeax/engine-runtime from engine-ecs would invert the dependency arrow
// (runtime depends on ecs, not the reverse) and create a cyclic chain.
//
// Type-only imports (`import type ... from '@forgeax/engine-runtime'`) are not
// matched -- they erase at build time and carry no runtime edge. In practice
// engine-ecs has zero references of either kind today; the gate keeps it so.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2] ?? 'packages/ecs/src';
// Match `import <bindings> from '@forgeax/engine-runtime'` and
// `require('@forgeax/engine-runtime')`, but NOT `import type ... from ...`
// (type-only, build-time erased) and NOT comment mentions of the package name.
const valueImportPat =
  /(?:import(?!\s+type\b)\s+[^'"]*|require\s*\(\s*)['"]@forgeax\/engine-runtime['"]/;
const hits = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (p.endsWith('.ts')) {
      const content = readFileSync(p, 'utf8');
      const m = content.match(valueImportPat);
      if (m) hits.push({ path: p, hit: m[0] });
    }
  }
}

walk(root);

if (hits.length > 0) {
  process.stderr.write(`AC-29 FAIL: ${root} contains value-import of @forgeax/engine-runtime:\n`);
  for (const h of hits) process.stderr.write(`  ${h.path}: ${h.hit}\n`);
  process.stderr.write(
    '[hint] @forgeax/engine-ecs must not depend on @forgeax/engine-runtime. ' +
      'Relationship mirrors name their component by string (relationship.mirror) ' +
      'and resolve via World._getComponentByName -- no runtime type import needed.\n',
  );
  process.exit(1);
}
process.stdout.write(`AC-29 OK: ${root} value-import grep clean (0 @forgeax/engine-runtime)\n`);
