// check-workspaces-equivalence-export.test.ts (M2 w5) — named-export contract
// for the helper extracted from scripts/check-workspaces-equivalence.mjs.
//
// w4 refactor adds:
//   export function getEquivalentWorkspaces(): string[]
//
// Contract (per plan-strategy K-9 + plan-tasks.json#w5):
//   (a) named import succeeds (function exported, not default)
//   (b) returns the 13 packages + 2 apps workspace member paths (unordered)
//   (c) calling the pure helper does NOT trigger process.exit (the IIFE
//       guard isolates CLI side-effects from the importable surface)
//
// Architecture principle #2 (Derive, Don't Duplicate): the drift detector
// (w9) reuses this helper instead of re-implementing workspace glob parsing.

import { describe, expect, it, vi } from 'vitest';
import * as mod from '../check-workspaces-equivalence.mjs';

const EXPECTED_WORKSPACE_MEMBERS: ReadonlySet<string> = new Set([
  'packages/core',
  'packages/ecs',
  'packages/engine',
  'packages/math',
  'packages/naga',
  'packages/rhi',
  'packages/rhi-webgpu',
  'packages/rhi-wgpu',
  'packages/shader',
  'packages/shader-compiler',
  'packages/types',
  'packages/vite-plugin-shader',
  'packages/wgpu-wasm',
  'apps/hello/cube',
  'apps/hello/triangle',
]);

describe('check-workspaces-equivalence.mjs named export (w5)', () => {
  it('(a) exports getEquivalentWorkspaces as a named function', () => {
    expect(typeof (mod as { getEquivalentWorkspaces?: unknown }).getEquivalentWorkspaces).toBe(
      'function',
    );
  });

  it('(b) returns the 13 packages + 2 apps workspace member paths', () => {
    const fn = (mod as { getEquivalentWorkspaces: () => string[] }).getEquivalentWorkspaces;
    const got = new Set(fn());
    expect(got.size).toBe(EXPECTED_WORKSPACE_MEMBERS.size);
    for (const expected of EXPECTED_WORKSPACE_MEMBERS) {
      expect(got.has(expected)).toBe(true);
    }
  });

  it('(c) does not invoke process.exit (pure helper isolated from IIFE)', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error(`process.exit was called with code=${String(_code)}`);
    }) as never);
    try {
      const fn = (mod as { getEquivalentWorkspaces: () => string[] }).getEquivalentWorkspaces;
      expect(() => fn()).not.toThrow();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });
});
