import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '..', '..');
const gatePath = resolve(repoRoot, 'scripts', 'check-package-directory-names.mjs');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(packagesRoot: string): RunResult {
  const result = spawnSync(process.execPath, [gatePath, '--packages-root', packagesRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function withFixture(
  create: (packagesRoot: string) => void,
  check: (packagesRoot: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-package-directory-gate-'));
  const packagesRoot = join(root, 'packages');
  mkdirSync(packagesRoot);
  try {
    create(packagesRoot);
    check(packagesRoot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function makeDirectory(parent: string, name: string): void {
  mkdirSync(join(parent, name), { recursive: true });
}

describe('package directory naming gate classification', () => {
  it('accepts the current package tree, including the engine placeholder', () => {
    const result = runGate(resolve(repoRoot, 'packages'));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      checkedRoot: resolve(repoRoot, 'packages'),
      violations: [],
    });
  });

  it('accepts engine placeholder, nested directories, files, and symlinks', () => {
    withFixture(
      (packagesRoot) => {
        makeDirectory(packagesRoot, 'engine');
        makeDirectory(packagesRoot, 'project');
        makeDirectory(packagesRoot, 'ordinary/engine-nested');
        writeFileSync(join(packagesRoot, 'engine-file'), 'file');
        makeDirectory(packagesRoot, 'symlink-target');
        symlinkSync('symlink-target', join(packagesRoot, 'engine-link'), 'dir');
      },
      (packagesRoot) => {
        const result = runGate(packagesRoot);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          ok: true,
          checkedRoot: packagesRoot,
          violations: [],
        });
      },
    );
  });

  it('reports one direct engine-prefixed directory', () => {
    withFixture(
      (packagesRoot) => makeDirectory(packagesRoot, 'engine-example'),
      (packagesRoot) => {
        const result = runGate(packagesRoot);
        expect(result.status).toBe(1);
        const report = JSON.parse(result.stdout);
        expect(report.ok).toBe(false);
        expect(report.error.code).toBe('engine-prefixed-package-directories');
        expect(report.error.detail.violations).toEqual(['packages/engine-example']);
      },
    );
  });

  it('rejects the retired engine-project directory name', () => {
    withFixture(
      (packagesRoot) => makeDirectory(packagesRoot, 'engine-project'),
      (packagesRoot) => {
        const result = runGate(packagesRoot);
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout).error.detail.violations).toEqual([
          'packages/engine-project',
        ]);
      },
    );
  });

  it('reports every direct violation in stable POSIX path order', () => {
    withFixture(
      (packagesRoot) => {
        makeDirectory(packagesRoot, 'engine-zeta');
        makeDirectory(packagesRoot, 'engine-alpha');
        makeDirectory(packagesRoot, 'engine-middle');
        makeDirectory(packagesRoot, 'nested/engine-ignored');
      },
      (packagesRoot) => {
        const first = runGate(packagesRoot);
        const second = runGate(packagesRoot);
        expect(first.status).toBe(1);
        expect(first.stdout).toBe(second.stdout);
        expect(JSON.parse(first.stdout).error.detail.violations).toEqual([
          'packages/engine-alpha',
          'packages/engine-middle',
          'packages/engine-zeta',
        ]);
      },
    );
  });
});

describe('package directory naming gate error contract', () => {
  it('separates a missing packages root from a valid tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-package-directory-error-'));
    const missingRoot = join(root, 'missing-packages');
    try {
      const result = runGate(missingRoot);
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: 'package-directory-check-unavailable',
          expected: 'packages root exists and is readable as a directory',
          hint: 'Restore the packages root or pass --packages-root to a readable directory, then rerun pnpm run check:package-directory-names.',
          detail: {
            checkedRoot: missingRoot,
            reason: expect.any(String),
          },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a scan failure when the injected packages root is a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-package-directory-scan-'));
    const fileRoot = join(root, 'packages');
    try {
      writeFileSync(fileRoot, 'not a directory');
      const result = runGate(fileRoot);
      expect(result.status).toBe(2);
      const report = JSON.parse(result.stdout);
      expect(report).toEqual({
        ok: false,
        error: {
          code: 'package-directory-check-unavailable',
          expected: 'packages root exists and is readable as a directory',
          hint: 'Restore the packages root or pass --packages-root to a readable directory, then rerun pnpm run check:package-directory-names.',
          detail: {
            checkedRoot: fileRoot,
            reason: expect.any(String),
          },
        },
      });
      expect(report.error.detail.reason).toContain('ENOTDIR');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the violation report fields machine-readable and complete', () => {
    withFixture(
      (packagesRoot) => {
        makeDirectory(packagesRoot, 'engine-one');
        makeDirectory(packagesRoot, 'engine-two');
      },
      (packagesRoot) => {
        const result = runGate(packagesRoot);
        expect(result.status).toBe(1);
        const report = JSON.parse(result.stdout);
        expect(report).toMatchObject({
          ok: false,
          error: {
            code: 'engine-prefixed-package-directories',
            expected: expect.any(String),
            hint: expect.any(String),
            detail: {
              checkedRoot: packagesRoot,
              violations: ['packages/engine-one', 'packages/engine-two'],
            },
          },
        });
        expect(Object.keys(report.error)).toEqual(['code', 'expected', 'hint', 'detail']);
      },
    );
  });
});

describe('package directory naming gate wiring', () => {
  it('uses one root script and one primary-pnpm named step', () => {
    const rootPackage = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const workflow = readFileSync(resolve(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const namedSteps = workflow.match(/^\s+- name: Package directory naming guard$/gm) ?? [];

    expect(rootPackage.scripts['check:package-directory-names']).toBe(
      'node scripts/check-package-directory-names.mjs',
    );
    expect(namedSteps).toHaveLength(1);
    expect(workflow.match(/check:package-directory-names/g)).toHaveLength(1);
    expect(workflow).toContain(
      '      - name: Package directory naming guard\n        run: pnpm run check:package-directory-names',
    );
  });
});
