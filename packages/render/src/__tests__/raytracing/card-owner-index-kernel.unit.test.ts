import { expect, it } from 'vitest';
import { compileShader } from '../../../../shader-compiler/src/index';
import { loadEngineShaderEntries } from '../../../../vite-plugin-shader/src/engine-inputs/load-engine-shader-entries';
import { irradianceFieldKernelWgsl } from '../../raytracing/irradiance-field';
import { screenProbeWorldWgsl } from '../../raytracing/screen-probe-kernels';
import {
  cardOwnerIndexExpected,
  cardOwnerIndexRows,
  cardOwnerIndexWorkKernel,
} from './card-owner-index.fixture';

it('prepares the exact owning lookup with reversible work observation through Naga', async () => {
  const code = cardOwnerIndexWorkKernel();
  const result = await compileShader(code, { id: 'card-owner-index-observed' });
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
});

it('keeps the independent physical-order stale and same-score tie oracle', () => {
  expect(cardOwnerIndexExpected([7, 1, 7], [1, 1, 0], 7)).toEqual({ state: 3, tile: 0 });
  expect(cardOwnerIndexExpected([7, 1, 7], [0, 1, 1], 7)).toEqual({ state: 1, tile: 2 });
  expect(cardOwnerIndexExpected([7, 1, 7], [1, 1, 1], 7)).toEqual({ state: 1, tile: 0 });
  expect(cardOwnerIndexExpected([7, 1, 7], [1, 1, 1], 7, new Set([0]))).toEqual({
    state: 1,
    tile: 2,
  });
  const rows = new DataView(cardOwnerIndexRows([7, 1, 7], [0, 1, 1]).buffer);
  expect(rows.getUint32(68, true)).toBe(0);
  expect(rows.getUint32(76, true)).toBe(3);
});

// Hardware modules use the owning Native fixture generator and Rust RayQuery
// validator: naga_oil WGSL writeback cannot serialize Statement::RayQuery.
it('validates the affected software Field and Screen compositions through Naga', async () => {
  const builtin = await loadEngineShaderEntries();
  const traversal = 'global-sdf';
  const field = irradianceFieldKernelWgsl(traversal);
  for (const stage of ['cardSurface', 'traceProbes', 'traceReflections'] as const) {
    const result = await compileShader(field[stage], {
      id: `card-owner-${traversal}-${stage}`,
      computeEntry: stage,
      imports: builtin.imports,
    });
    expect(
      result.ok,
      result.ok ? undefined : `${traversal}:${stage}: ${result.error.message}`,
    ).toBe(true);
  }
  const result = await compileShader(screenProbeWorldWgsl(traversal), {
    id: `card-owner-${traversal}-screen`,
    computeEntry: 'traceWorldProbes',
    imports: builtin.imports,
  });
  expect(result.ok, result.ok ? undefined : `${traversal}:Screen: ${result.error.message}`).toBe(
    true,
  );
}, 30_000);
