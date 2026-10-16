#!/usr/bin/env node
// MVP-2.5 dual-path smoke test: (A) engine SDK install + (C) production grep (plan-strategy §6 M3 / w21).
// (A) `require.resolve('@forgeax/engine-naga')` not throwing → after pnpm install, developers can pull our own
//     build-time shader compiler chain. The historical wasm-pack shim that fronted naga was archived in
//     feat-20260511-naga-rhi-wgpu-merge M5 (D-P5); shader-compiler now depends on the
//     TS-only @forgeax/engine-naga thin shell that re-exports the merged @forgeax/engine-wgpu-wasm wasm bundle.
// (C) Invoke the three w20 AC-06 grep scripts (dist + dep graph + src); all must exit 0.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// (A) engine SDK install path: from the shader-compiler package's perspective, require.resolve hits the workspace link.
// shader-compiler is the direct consumer of @forgeax/engine-naga (post-M5 archive of the legacy wasm-pack naga shim); a
// successful resolve means that after pnpm install, the dependency tree contains the @forgeax/engine-naga workspace link
// (charter proposition 4 explicit failure: missing package → exit 1).
const consumerPkg = join(root, 'packages', 'shader-compiler', 'package.json');
const require = createRequire(consumerPkg);
try {
  // Resolve via /package.json subpath: a stable shape that does not depend on main / exports['.'] import conditions.
  const resolved = require.resolve('@forgeax/engine-naga/package.json');
  process.stdout.write(`MVP-2.5 (A) OK: @forgeax/engine-naga resolved at ${resolved}\n`);
} catch (e) {
  process.stderr.write(
    `MVP-2.5 (A) FAIL: cannot resolve @forgeax/engine-naga from packages/shader-compiler (run pnpm install): ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}

// (C) production grep: run the three AC-06 gate scripts in sequence.
const scripts = [
  'check-shader-no-naga-in-dist.mjs',
  'check-shader-runtime-deps.mjs',
  'check-shader-no-compiler-import.mjs',
];
for (const s of scripts) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', s)], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    process.stderr.write(`MVP-2.5 (C) FAIL: ${s} exited with status ${r.status}\n`);
    process.exit(1);
  }
}
process.stdout.write('MVP-2.5 (C) OK: AC-06 triple gate all green\n');
