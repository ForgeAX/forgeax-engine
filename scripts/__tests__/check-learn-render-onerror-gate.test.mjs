// Self-test fixture for scripts/check-learn-render-onerror-gate.mjs
// feat: bug-20260609-learn-render-onerror-gate-coverage M5
//
// Eight cases cover the gate contract:
//   1. clean repo: all demos compliant -> exit 0
//   2. missing-test mutation: no onerror-gate.browser.test.ts
//      -> exit != 0 + stderr contains 'missing-test'
//   3. missing-bus-push mutation: entry without __learnRenderErrors
//      -> exit != 0 + stderr contains 'missing-bus-push'
//   4. missing-entry: demo dir without index.ts/main.ts
//      -> exit != 0 + stderr contains 'missing-entry'
//   5. no-arg default: script invoked without --repo-root, cwd is repo root
//      -> exit 0 (git upwalk fallback finds pnpm-workspace.yaml)
//   6. scoped dev import consumer -> exit 0
//   7. unscoped dev import transport -> exit != 0
//   8. missing Vite runtime binding -> exit != 0
//
// Each mutation operates on a tmpdir copy of the minimal layout so live tree
// is never mutated.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const scriptPath = resolve(repoRoot, 'scripts/check-learn-render-onerror-gate.mjs');
const tmpBase = process.env.TMPDIR ?? '/tmp';

function run(repoRootPath) {
  const r = spawnSync('node', [scriptPath, '--repo-root', repoRootPath], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function runNoArg(cwdPath) {
  const r = spawnSync('node', [scriptPath], {
    encoding: 'utf8',
    cwd: cwdPath,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function makeFixture(opts = {}) {
  const {
    withTest = true,
    withBusPush = true,
    withEntry = true,
    withDevImport = false,
    withScopedTransport = true,
    withViteBinding = true,
  } = opts;
  const fixtureRoot = mkdtempSync(join(tmpBase, 'onerror-gate-fixture-'));
  const srcDir = join(fixtureRoot, 'apps', 'learn-render', '1.testing', '1.sample', 'src');
  const testDir = join(srcDir, '__tests__');

  mkdirSync(testDir, { recursive: true });

  if (withEntry) {
    let content = 'import { something } from "@forgeax/engine-runtime";\n';
    if (withBusPush) {
      content += 'globalThis.__learnRenderErrors?.push({ code: "test-error" });\n';
    } else {
      content += 'console.log("no bus push here");\n';
    }
    if (withDevImport) {
      content += 'const runtimeBinding = createStandaloneRuntimeAssetBinding("fixture");\n';
      content += withScopedTransport
        ? 'createDevImportTransport(runtimeBinding);\nconfigureRuntimeAssetCatalog(assets, runtimeBinding);\n'
        : 'createDevImportTransport();\n';
    }
    writeFileSync(join(srcDir, 'index.ts'), content, 'utf8');
  }

  if (withDevImport) {
    writeFileSync(
      join(fixtureRoot, 'apps', 'learn-render', '1.testing', '1.sample', 'vite.config.ts'),
      withViteBinding ? 'pluginPack({ runtimeBinding, });\n' : 'pluginPack({});\n',
      'utf8',
    );
  }

  if (withTest) {
    writeFileSync(join(testDir, 'onerror-gate.browser.test.ts'), '// test placeholder', 'utf8');
  }

  return fixtureRoot;
}

function cleanup(fixtureRoot) {
  try {
    rmSync(fixtureRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

describe('check-learn-render-onerror-gate', () => {
  it('case 1 (clean repo): script exits 0', () => {
    const fixtureRoot = makeFixture();
    try {
      const r = run(fixtureRoot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/OK/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 2 (missing-test mutation): exit != 0 + stderr missing-test', () => {
    const fixtureRoot = makeFixture({ withTest: false });
    try {
      const r = run(fixtureRoot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing-test/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 3 (missing-bus-push mutation): exit != 0 + stderr missing-bus-push', () => {
    const fixtureRoot = makeFixture({ withBusPush: false });
    try {
      const r = run(fixtureRoot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing-bus-push/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 4 (missing-entry): exit != 0 + stderr missing-entry', () => {
    const fixtureRoot = makeFixture({ withEntry: false });
    try {
      const r = run(fixtureRoot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/missing-entry/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 5 (no-arg default): script with no --repo-root, cwd=fixtureRoot -> exit 0', () => {
    const fixtureRoot = makeFixture();
    // upwalk needs pnpm-workspace.yaml to identify the repo root
    writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n', 'utf8');
    try {
      const r = runNoArg(fixtureRoot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toMatch(/OK/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 6 (scoped dev import consumer): script exits 0', () => {
    const fixtureRoot = makeFixture({ withDevImport: true });
    try {
      const r = run(fixtureRoot);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 7 (unscoped dev import transport): exit != 0 + scoped diagnostics', () => {
    const fixtureRoot = makeFixture({ withDevImport: true, withScopedTransport: false });
    try {
      const r = run(fixtureRoot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unscoped-import-transport/);
      expect(r.stderr).toMatch(/unscoped-asset-registry/);
    } finally {
      cleanup(fixtureRoot);
    }
  });

  it('case 8 (missing Vite runtime binding): exit != 0 + unscoped-pack-host', () => {
    const fixtureRoot = makeFixture({ withDevImport: true, withViteBinding: false });
    try {
      const r = run(fixtureRoot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/unscoped-pack-host/);
    } finally {
      cleanup(fixtureRoot);
    }
  });
});
