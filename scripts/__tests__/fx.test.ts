// fx.test.ts — pure-helper contract for scripts/fx.ts (the `bun fx` dev CLI).
//
// Only the pure, exported helpers are asserted here; the mutating commands
// (setup / update / clean) spawn git and are NOT exercised in CI. This mirrors
// studio's scripts/fx.spec.ts intent (command routing + report formatting +
// flag parsing) but uses vitest (engine convention) instead of bun:test.
//
// Run in isolation via `pnpm test:fx` (the dedicated scripts-only Vitest config)
// — this file is gated through the dedicated script + a portability-bun CI step,
// not the full workspace project graph.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanFlagsFor,
  didCreateStash,
  findOrphanSubmoduleDirs,
  formatStepReport,
  parseSubmodulePaths,
  parseSubmoduleStatusPaths,
  resolveCommand,
  type StepResult,
  stashPopArgsForRef,
  submoduleUpdateAllArgs,
  submoduleUpdateArgs,
  troubleshootHints,
  updateShouldStash,
  updateStashMessage,
} from '../fx.ts';

const ROOT = resolve(__dirname, '..', '..');
// formatStepReport honours NO_COLOR; set it so table assertions see plain text
// (avoids a control-character regex to strip ANSI).
process.env.NO_COLOR = '1';

describe('package.json wiring', () => {
  it('registers fx + test:fx scripts and typechecks scripts/tsconfig.json', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.fx).toBe('bun scripts/fx.ts');
    expect(pkg.scripts['test:fx']).toBe(
      'vitest run --config scripts/vitest.fx.config.ts scripts/__tests__/fx.test.ts scripts/__tests__/worktree.test.ts scripts/__tests__/link-template-agents.test.ts',
    );
    expect(pkg.scripts.typecheck).toContain('tsc -p scripts/tsconfig.json');
  });
});

describe('resolveCommand', () => {
  it('routes builtin commands to internal', () => {
    expect(resolveCommand(['setup'])).toEqual({ type: 'internal', command: 'setup', args: [] });
    expect(resolveCommand(['update', '--dry-run'])).toEqual({
      type: 'internal',
      command: 'update',
      args: ['--dry-run'],
    });
    expect(resolveCommand(['clean', '-x'])).toEqual({
      type: 'internal',
      command: 'clean',
      args: ['-x'],
    });
    expect(resolveCommand(['ci', '--kind', 'dawn', '--select', 'transmission'])).toEqual({
      type: 'internal',
      command: 'ci',
      args: ['--kind', 'dawn', '--select', 'transmission'],
    });
    expect(resolveCommand(['worktree', 'feature-name'])).toEqual({
      type: 'internal',
      command: 'worktree',
      args: ['feature-name'],
    });
  });

  it('defaults empty argv to help', () => {
    expect(resolveCommand([])).toEqual({ type: 'internal', command: 'help', args: [] });
  });

  it('routes unknown commands to unknown', () => {
    expect(resolveCommand(['bootstrap'])).toEqual({
      type: 'unknown',
      command: 'bootstrap',
      args: [],
    });
    expect(resolveCommand(['start'])).toEqual({ type: 'unknown', command: 'start', args: [] });
  });
});

describe('parseSubmodulePaths', () => {
  it('extracts the single assets submodule', () => {
    expect(
      parseSubmodulePaths('submodule.forgeax-engine-assets.path forgeax-engine-assets\n'),
    ).toEqual(['forgeax-engine-assets']);
  });

  it('handles blank / empty output', () => {
    expect(parseSubmodulePaths('')).toEqual([]);
    expect(parseSubmodulePaths('\n\n')).toEqual([]);
  });

  it('is future-proof for multiple submodules', () => {
    expect(
      parseSubmodulePaths(['submodule.a.path pkg/a', 'submodule.b.path pkg/b', ''].join('\n')),
    ).toEqual(['pkg/a', 'pkg/b']);
  });
});

describe('submoduleUpdateArgs', () => {
  it('builds the recursive init update args', () => {
    expect(submoduleUpdateArgs('forgeax-engine-assets')).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '1',
      '--',
      'forgeax-engine-assets',
    ]);
  });

  it('keeps the all-submodule bootstrap shallow and single-job', () => {
    expect(submoduleUpdateAllArgs()).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--depth',
      '1',
      '--jobs',
      '1',
    ]);
  });
});

describe('parseSubmoduleStatusPaths', () => {
  it('extracts initialized, shallow, and dirty status paths', () => {
    expect(
      parseSubmoduleStatusPaths(
        [' 280094a assets', '-abcdef0 nested/child', '+1234567 dirty'].join('\n'),
      ),
    ).toEqual(['assets', 'nested/child', 'dirty']);
  });
});

describe('cleanFlagsFor', () => {
  it('defaults to conservative root clean', () => {
    expect(cleanFlagsFor([])).toMatchObject({
      dryRun: false,
      deepRoot: false,
      rootCleanFlags: '-fd',
    });
  });

  it('maps --deep/-x to a root deep clean', () => {
    expect(cleanFlagsFor(['--deep'])).toMatchObject({ deepRoot: true, rootCleanFlags: '-fdx' });
    expect(cleanFlagsFor(['-x'])).toMatchObject({ deepRoot: true, rootCleanFlags: '-fdx' });
  });

  it('maps --dry-run/-n to a preview and uses -ffndx for submodules', () => {
    expect(cleanFlagsFor(['-n'])).toMatchObject({ dryRun: true });
    expect(cleanFlagsFor(['--dry-run']).subForeachCmd).toContain('clean -ffndx');
    expect(cleanFlagsFor([]).subForeachCmd).toContain('clean -ffdx');
  });
});

describe('stash helpers', () => {
  it('stashes by default and honours --no-stash', () => {
    expect(updateShouldStash([])).toBe(true);
    expect(updateShouldStash(['--dry-run'])).toBe(true);
    expect(updateShouldStash(['--no-stash'])).toBe(false);
  });

  it('detects a stash only when the top oid changed', () => {
    expect(didCreateStash('', 'abc')).toBe(true);
    expect(didCreateStash('old', 'new')).toBe(true);
    expect(didCreateStash('same', 'same')).toBe(false);
    expect(didCreateStash('had', '')).toBe(false);
  });

  it('builds a stash pop for a ref', () => {
    expect(stashPopArgsForRef('stash@{0}')).toEqual(['stash', 'pop', 'stash@{0}']);
  });

  it('stamps the stash message with the given iso', () => {
    expect(updateStashMessage('2026-07-10T00:00:00Z')).toBe(
      'forgeax pre-update 2026-07-10T00:00:00Z',
    );
  });
});

describe('findOrphanSubmoduleDirs', () => {
  it('returns dirs registered on disk but dropped from .gitmodules', () => {
    expect(
      findOrphanSubmoduleDirs(
        ['forgeax-engine-assets', 'old-sub'],
        ['forgeax-engine-assets'],
        ['.forgeax-harness'],
      ),
    ).toEqual(['old-sub']);
  });

  it('never returns whitelisted names (harness / live submodules)', () => {
    expect(
      findOrphanSubmoduleDirs(
        ['.forgeax-harness', 'forgeax-engine-assets'],
        ['forgeax-engine-assets'],
        ['.forgeax-harness'],
      ),
    ).toEqual([]);
  });

  it('returns nothing when everything is declared', () => {
    expect(
      findOrphanSubmoduleDirs(['forgeax-engine-assets'], ['forgeax-engine-assets'], []),
    ).toEqual([]);
  });
});

describe('formatStepReport', () => {
  it('renders header, separator, and one row per result', () => {
    const rows: StepResult[] = [
      { scope: 'root', name: '.', result: 'ok', detail: 'pulled latest root' },
      {
        scope: 'submodule',
        name: 'forgeax-engine-assets',
        result: 'failed',
        detail: 'git submodule update exited 1',
      },
      {
        scope: 'root',
        name: '.forgeax-harness',
        result: 'ok',
        detail: 'fast-forwarded / up to date',
      },
    ];
    const out = formatStepReport(rows);
    const lines = out.split('\n');
    expect(lines[0]).toContain('RESULT');
    expect(lines[0]).toContain('SCOPE');
    expect(lines[1]).toMatch(/^-+/);
    expect(lines).toHaveLength(2 + rows.length);
    expect(out).toContain('FAILED');
    expect(out).toContain('.forgeax-harness');
  });

  it('collapses newlines in detail cells', () => {
    const out = formatStepReport([
      { scope: 'root', name: '.', result: 'ok', detail: 'line1\nline2' },
    ]);
    expect(out).toContain('line1 line2');
  });
});

describe('troubleshootHints', () => {
  it('is empty when nothing failed', () => {
    expect(troubleshootHints([{ scope: 'root', name: '.', result: 'ok' }])).toEqual([]);
  });

  it('emits a root-divergence hint on root failure', () => {
    const hints = troubleshootHints([{ scope: 'root', name: '.', result: 'failed' }]);
    expect(hints.some((h) => h.includes('origin/main'))).toBe(true);
  });

  it('emits a stash-pop hint on a failed stash restore', () => {
    const hints = troubleshootHints([{ scope: 'root', name: 'stash-pop', result: 'failed' }]);
    expect(hints.some((h) => h.includes('git stash'))).toBe(true);
  });
});
