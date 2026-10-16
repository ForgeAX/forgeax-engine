// hello-debug-draw type-inference test (feat-20260615-debug-draw M5 / w35)
//
// Proves AC-15: demo main.ts color parameters infer as Color | ColorLike
// without explicit `as` casts, and `as Vec4` does not appear anywhere.
//
// Scope:
//   (a) grep 'as Vec4' on main.ts returns 0 matches
//   (b) shape-call lines (dd.line / dd.sphere / dd.aabb / dd.frustum)
//       contain zero `as ` type assertions on the color argument
//
// Non-scope (expected in a low-path RHI demo):
//   - `as HTMLCanvasElement` for document.getElementById
//   - `as any` for opaque RHI handle interop (GPUTextureView -> TextureView)
//   - `as GPUTextureFormat` for raw WebGPU format literals
//   - `as any` for generic asset registration API

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MAIN_TS = new URL('../src/main.ts', import.meta.url).pathname;

function loadLines(): string[] {
  return readFileSync(MAIN_TS, 'utf8').split('\n');
}

describe('w35: type inference (AC-15)', () => {
  it('grep "as Vec4" on main.ts returns 0 matches', () => {
    const lines = loadLines();
    const hits = lines.filter((line) => line.includes('as Vec4'));
    expect(hits).toHaveLength(0);
  });

  it('shape-call lines contain zero `as` type assertions on the color argument', () => {
    const lines = loadLines();
    const shapePattern = /\.(line|sphere|aabb|frustum)\(/;
    const shapeLines = lines.filter((line) => shapePattern.test(line));

    // Each shape call line must NOT contain `as ` (type assertion).
    // Biome-ignore comments alongside `as any` in the same line (for RHI
    // interop) would already be a concern, but shape calls should never
    // need type assertions — ColorLike widening handles the color param.
    const hits = shapeLines.filter((line) => /\bas /.test(line));

    if (hits.length > 0) {
      throw new Error(
        `Shape calls with explicit type assertion found:\n${hits.join('\n')}\n\n` +
          'AC-15: color parameters must infer as Color | ColorLike without as-casting.',
      );
    }
  });

  it('main.ts contains at least one dd.line/sphere/aabb/frustum call (presence gate)', () => {
    // Sanity check: this test file would be vacuously green if the demo
    // never calls any shape method.  Fail early with a clear message.
    const lines = loadLines();
    const shapeCalls = lines.filter((line) => /\.(line|sphere|aabb|frustum)\(/.test(line));
    if (shapeCalls.length === 0) {
      throw new Error(
        'No debug-draw shape calls found in main.ts. ' +
          'The test is vacuously passing — check that the demo source has not been emptied.',
      );
    }
    // At least 4 shape invocations (line + sphere + aabb + frustum)
    expect(shapeCalls.length).toBeGreaterThanOrEqual(4);
  });
});