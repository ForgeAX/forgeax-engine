// w16 — colocated test for packages/ecs/scripts/grep-no-set-managed-ref-store.mjs.
// @perf-budget-skip: intentional repository-wide freeze-gate subprocess scan.
//
// feat-20260515-string-managed-collapse M4 / w16 — verifies the two-mode
// contract of the setManagedRefStore freeze gate:
//   (a) clean tree (default scan, fixtures skipped) -> exit 0
//   (b) seeded fixture under __tests__/fixtures/set-managed-ref-store-bad/
//       containing `w.setManagedRefStore(s)` -> exit 1 + stderr triple
//       ([reason] / [rerun] / [hint]).
//
// Pattern mirrors grep-no-string-view-import.test.mjs (same file lives
// in this directory).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';

const here = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(here, '..', '..', '..', '..');
const script = resolve(here, '..', 'grep-no-set-managed-ref-store.mjs');
const fixtureDir = resolve(here, 'fixtures', 'set-managed-ref-store-bad');

beforeAll(() => {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    resolve(fixtureDir, 'bad.ts'),
    "const w = {} as any;\nconst store = {} as any;\nw.setManagedRefStore(store);\nconst s = w.getManagedRefStore();\n",
    'utf8',
  );
});

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('grep-no-set-managed-ref-store', () => {
  it('exits 0 on the live tree (default scan, fixtures skipped)', () => {
    const r = run([]);
    expect(r.status).toBe(0);
  }, 30_000);

  it('exits 1 with stderr triple when scanning the seeded fixture root', () => {
    const r = run(['--scan-fixtures', fixtureDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[reason\] setManagedRefStore reference detected at/);
    expect(r.stderr).toMatch(/\[reason\] getManagedRefStore reference detected at/);
    expect(r.stderr).toMatch(/\[rerun\] pnpm grep:no-set-managed-ref-store/);
    expect(r.stderr).toMatch(/\[hint\] World owns ManagedRefStore privately/);
  });
  it('still detects violations in another package or source .native-build directory', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'managed-ref-source-scan-'));
    try {
      for (const directory of ['ordinary/.native-build', 'dawn-node/src/.native-build']) {
        const source = resolve(root, directory);
        mkdirSync(source, { recursive: true });
        writeFileSync(resolve(source, 'bad.ts'), 'world.setManagedRefStore(store);\n');
      }
      const result = run([root]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('ordinary/.native-build/bad.ts:1');
      expect(result.stderr).toContain('dawn-node/src/.native-build/bad.ts:1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
