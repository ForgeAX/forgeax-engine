#!/usr/bin/env node
// feat-20260511-naga-rhi-wgpu-merge w13 — two reverse-coupling guards.
// architecture-principles #4 Pipeline Isolation + AGENTS.md §Shader pipeline.
//
// guarded edges (forbidden in both directions; minor violation = CI red):
//
//   (1) packages/shader-compiler/src/**/*.ts   --x->   '@forgeax/engine-rhi-wgpu'
//       (shader-compiler is a build-time pure function; reaching into the
//        RHI runtime backend would smuggle GPU state into the compile path
//        and break the static-only invariant.)
//
//   (2) packages/rhi-wgpu/src/**/*.ts          --x->   '@forgeax/engine-naga'
//       (rhi-wgpu is a runtime RHI thin shim; reaching into the build-time
//        shader pipeline would break the runtime / build-time concern
//        boundary plus reverse-couple wasm dependency direction.)
//
// CLI:
//   node scripts/check-concern-reverse-coupling.mjs [--root <dir>]
//   --root  default = process.cwd()
//
// Exit 0 when both src trees are clean; exit 1 with a 3-section stderr
// (reason / locations / hint) on first hit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      out.root = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const { root } = parseArgs(process.argv.slice(2));

const edges = [
  {
    label: 'shader-compiler -> rhi-wgpu',
    srcRoot: join(root, 'packages/shader-compiler/src'),
    pattern: /import\s+[^'"]*['"]@forgeax\/rhi-wgpu['"]/,
    hint: 'shader-compiler is a build-time pure function. Move the work that needs an RHI handle into @forgeax/engine-shader runtime or expose a callback through compileShader options.',
  },
  {
    label: 'rhi-wgpu -> naga',
    srcRoot: join(root, 'packages/rhi-wgpu/src'),
    pattern: /import\s+[^'"]*['"]@forgeax\/naga['"]/,
    hint: 'rhi-wgpu is a runtime thin shim. Route shader compilation through @forgeax/engine-shader-compiler (build-time) and pass the precompiled WGSL into rhi.createShaderModule.',
  },
];

const hits = [];
for (const edge of edges) {
  walk(edge.srcRoot, (path) => {
    if (!path.endsWith('.ts')) return;
    const content = readFileSync(path, 'utf8');
    const match = content.match(edge.pattern);
    if (match) hits.push({ edge: edge.label, path, hit: match[0], hint: edge.hint });
  });
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, visit);
    else visit(p);
  }
}

if (hits.length > 0) {
  process.stderr.write(
    `concern-reverse-coupling FAIL: forbidden import edge detected (architecture-principles #4 Pipeline Isolation).\n`,
  );
  for (const h of hits) {
    process.stderr.write(`  [${h.edge}] ${h.path}\n`);
    process.stderr.write(`    line: ${h.hit}\n`);
    process.stderr.write(`    [hint] ${h.hint}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `concern-reverse-coupling OK: shader-compiler does not depend on rhi-wgpu; rhi-wgpu does not depend on naga (root=${root}).\n`,
);
