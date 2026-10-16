#!/usr/bin/env node
// AC-02: @forgeax/engine-render-graph/src/**/*.ts must not import @forgeax/engine-runtime.
// Plan-strategy D-6 + feat-20260529-rendergraph-pass-abstraction M1 w8.
//
// This gate enforces the RHI-pure boundary: render-graph only depends on
// @forgeax/engine-rhi + @forgeax/engine-math; importing @forgeax/engine-runtime
// would create a cyclic dependency chain.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = process.argv[2] ?? 'packages/render/src';
const pat = /import\s+[^'"]*['"]@forgeax\/engine-runtime['"]/;
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
      const m = content.match(pat);
      if (m) hits.push({ path: p, hit: m[0] });
    }
  }
}

walk(root);

if (hits.length > 0) {
  process.stderr.write(`AC-02 FAIL: ${root} src imports contain @forgeax/engine-runtime:\n`);
  for (const h of hits) process.stderr.write(`  ${h.path}: ${h.hit}\n`);
  process.stderr.write(
    '[hint] @forgeax/engine-render-graph is RHI-pure; it must only depend on @forgeax/engine-rhi + @forgeax/engine-math.\n',
  );
  process.exit(1);
}
process.stdout.write(`AC-02 OK: ${root} src import grep clean\n`);
