#!/usr/bin/env node
// feat: bug-20260609-learn-render-onerror-gate-coverage M5
// Purpose: CI grep gate that verifies every demo under apps/learn-render/**/src
// has (a) __tests__/onerror-gate.browser.test.ts, and (b) index.ts or main.ts
// containing the __learnRenderErrors bus push literal. Dev asset consumers must
// also share one scoped runtime binding across source, registry, and Vite host.
//
// Governance: AGENTS.md "Demo failures route to engine fixes, not workarounds"
// — this gate prevents demos from silently drifting out of onerror-gate coverage.
//
// Usage:
//   node scripts/check-learn-render-onerror-gate.mjs               # default: walk up from cwd to pnpm-workspace.yaml / .git
//   node scripts/check-learn-render-onerror-gate.mjs --repo-root <path>  # explicit root (for testing)
//
// Exit 0 if all demos compliant; exit 1 with per-demo stderr diagnostics otherwise.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

function parseArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo-root' && i + 1 < args.length) {
      return resolve(args[i + 1] ?? '.');
    }
  }
  return null;
}

function upwalkToRepoRoot(cwd) {
  let dir = resolve(cwd);
  for (let i = 0; i < 10; i++) {
    try {
      if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
      if (existsSync(join(dir, '.git'))) return dir;
    } catch {
      // permission errors on unreadable ancestors — keep walking
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function findRepoRoot() {
  return parseArgs() ?? upwalkToRepoRoot(process.cwd());
}

const repoRoot = findRepoRoot();
if (!repoRoot) {
  process.stderr.write('[onerror-gate-coverage] error: --repo-root <path> is required\n');
  process.exit(2);
}

// EXEMPT_DEMOS — onerror-gate browser test cannot run for these demos
// because they require a live vite dev server (POST /__import) that the
// vitest browser project does not provide. Each entry must point at a
// sibling smoke that exercises the same SUT in a dawn-node / preview path.
//
// Re-EXEMPT 3.model-loading after feat-20260611 M2 atomic restore: the
// Sponza demo issues `loadByGuid<SceneAsset>` against `createDevImportTransport`,
// which dispatches POST /__import; under vitest browser preview no dev
// server is available and runtime fails fast with `asset-not-imported`.
// The sibling dawn-node smoke (smoke-dawn.mjs, 60-frame Sponza walk-through)
// covers the same surface; surfacing the dev-only AssetError as an
// onerror-gate violation would force a workaround inside the demo, which
// AGENTS.md "Demo failures route to engine fixes" forbids. Sibling
// bug-20260611-asset-registry-fetch-pack-file-undefined-find tracks the
// underlying engine gap (unhandled-rejection escape from
// fetchAndCachePackFile) — addressed in this PR via a ParsedPackFile
// shape guard but the dev-only POST /__import path still fails fast.
const EXEMPT_DEMOS = [
  {
    demoDir: 'apps/learn-render/3.model-loading/1.model-loading',
    siblingSmoke: 'scripts/smoke-dawn.mjs',
    reason:
      'onerror-gate browser test requires vite dev server for POST /__import; covered by sibling smoke-dawn.mjs (Sponza 60-frame end-to-end)',
  },
  {
    demoDir: 'apps/learn-render/4.advanced-opengl/9.instancing',
    siblingSmoke: 'scripts/smoke-dawn.mjs',
    reason:
      'the browser tripwire duplicated the asset/import path through an unbounded dev-server bootstrap; the CI-owned sibling smoke exercises all four assets, WebGPU instancing, 60 frames, pixel evidence, and the RHI error contract deterministically',
  },
];

const learnRenderDir = join(repoRoot, 'apps', 'learn-render');

function findDemoDirs() {
  /** @type {string[]} */
  const demos = [];
  if (!existsSync(learnRenderDir)) return demos;

  /** @param {string} dir */
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules')
        continue;
      const child = join(dir, entry.name);
      if (entry.name === 'src') {
        demos.push(child);
      } else {
        visit(child);
      }
    }
  }

  visit(learnRenderDir);
  return demos.sort();
}

const demoDirs = findDemoDirs();

/** @type {{ dim: string; path: string }[]} */
const violations = [];

for (const dir of demoDirs) {
  const relative = dir.slice(repoRoot.length + 1); // e.g. apps/learn-render/1.getting-started/1.hello-window/src

  // Convert the src dir to the demo root (strip trailing "/src")
  const demoRoot = relative.replace(/\/src$/, '');

  // (a) test file existence
  const testFile = join(dir, '__tests__', 'onerror-gate.browser.test.ts');
  const exempt = EXEMPT_DEMOS.find((e) => e.demoDir === demoRoot);
  if (exempt) {
    const smokePath = join(repoRoot, demoRoot, exempt.siblingSmoke);
    if (!existsSync(smokePath)) {
      violations.push({
        dim: 'exempt-smoke-missing',
        path: join(demoRoot, exempt.siblingSmoke),
      });
    }
    // Skip test-file-existence check for exempted demos
  } else if (!existsSync(testFile)) {
    violations.push({ dim: 'missing-test', path: testFile.slice(repoRoot.length + 1) });
  }

  // (b) entry file existence
  const indexTs = join(dir, 'index.ts');
  const mainTs = join(dir, 'main.ts');
  const hasIndex = existsSync(indexTs);
  const hasMain = existsSync(mainTs);
  if (!hasIndex && !hasMain) {
    violations.push({ dim: 'missing-entry', path: relative });
    continue; // can't check bus push without an entry
  }

  // (c) bus push literal in entry
  const entryPath = hasIndex ? indexTs : mainTs;
  const content = readFileSync(entryPath, 'utf8');
  if (!content.includes('__learnRenderErrors')) {
    const entryRelative = entryPath.slice(repoRoot.length + 1);
    violations.push({ dim: 'missing-bus-push', path: entryRelative });
  }

  if (content.includes('createDevImportTransport')) {
    const entryRelative = entryPath.slice(repoRoot.length + 1);
    if (!content.includes('createStandaloneRuntimeAssetBinding')) {
      violations.push({ dim: 'missing-runtime-binding', path: entryRelative });
    }
    if (!content.includes('createDevImportTransport(runtimeBinding)')) {
      violations.push({ dim: 'unscoped-import-transport', path: entryRelative });
    }
    if (!content.includes('configureRuntimeAssetCatalog(assets, runtimeBinding)')) {
      violations.push({ dim: 'unscoped-asset-registry', path: entryRelative });
    }

    const viteConfig = join(dir, '..', 'vite.config.ts');
    const viteContent = existsSync(viteConfig) ? readFileSync(viteConfig, 'utf8') : '';
    if (!/\bruntimeBinding\s*[:,]/.test(viteContent)) {
      violations.push({
        dim: 'unscoped-pack-host',
        path: viteConfig.slice(repoRoot.length + 1),
      });
    }
  }
}

if (violations.length > 0) {
  for (const v of violations) {
    process.stderr.write(`[onerror-gate-coverage] ${v.dim}: ${v.path}\n`);
  }
  process.stderr.write(`[onerror-gate-coverage] total violations: ${violations.length}\n`);
  process.exit(1);
}

process.stdout.write('[onerror-gate-coverage] OK: all demos compliant\n');
