import { expect, it } from 'vitest';
import { compileShader } from '../../../shader-compiler/src/compile';

import {
  deferredShaderImports as imports,
  deferredShaderSource as source,
} from './deferred-shader.fixture';

it('keeps the zero-transmission assumption local to the deferred directional gate', () => {
  // Transmitting materials require back-side directional shadows. Changing this
  // deferred ABI must revisit the no-contribution proof, not inherit this gate.
  expect(source).toMatch(
    /evaluateStandardDirectSplit\(position, ndc, viewZ, in\.position\.xy, normal, direction, albedo\.rgb, vec3<f32>\(0\.0\),/,
  );
});

it('reuses the reconstructed clip reciprocal and the complete GBuffer context load', () => {
  expect(source).toContain(
    'sceneFragmentViewZ(vec4<f32>(in.position.xy, depth, homogeneous.w), view.temporalProjection)',
  );
  expect(source).not.toContain('view.worldViewProj * vec4<f32>(position, 1.0)');
  expect(source).toContain('let context = textureLoad(lightingContext, pixel, 0).rg;');
  expect(source).toContain('if (standardDeferredSubsurface && compactGBufferSubsurface(b))');
});

it('rejects pixels owned by another environment before reading their scene depth', () => {
  expect(source.indexOf('context.x >> 24u != expectedEnvironment')).toBeGreaterThan(0);
  expect(source.indexOf('context.x >> 24u != expectedEnvironment')).toBeLessThan(
    source.indexOf('let depth = textureLoad(sceneDepth, pixel, 0);'),
  );
});

const variants: Record<string, boolean>[] = [
  {},
  { ENV_BRDF_LUT: true },
  { STORAGE_BUFFER_AVAILABLE: true, CLUSTER_FORWARD_AVAILABLE: true },
  { DEFERRED_LIGHT_PROBE_AVAILABLE: true },
  { DEFERRED_DIFFUSE_GI_AVAILABLE: true },
  { DEFERRED_LIGHT_PROBE_AVAILABLE: true, DEFERRED_DIFFUSE_GI_AVAILABLE: true },
  {
    STORAGE_BUFFER_AVAILABLE: true,
    CLUSTER_FORWARD_AVAILABLE: true,
    POINT_SHADOW_AVAILABLE: true,
    DIRECTIONAL_PCSS_AVAILABLE: true,
    DIRECT_DFG_LUT_AVAILABLE: true,
  },
];

it.each(
  variants,
)('retains the deferred shader ABI with optional lighting features %j', async (defines) => {
  const reference = source.replace('receiveShadows && nDotL > 0.0', 'receiveShadows');
  const options = { id: 'forgeax_standard::deferred_lighting', imports, defines };
  const before = await compileShader(reference, options);
  const after = await compileShader(source, options);
  if (!before.ok) throw before.error;
  if (!after.ok) throw after.error;
  expect(after.value.bindings).toEqual(before.value.bindings);
  expect(after.value.reflection).toEqual(before.value.reflection);
  const reflection = after.value.reflection;
  expect(
    reflection?.boundGlobals.find((entry) => entry.group === 3 && entry.binding === 3)?.span,
  ).toBe(512);
  expect(reflection.entryPoints?.map(({ name }) => name)).toContain(
    'fs_standard_deferred_array_single',
  );
  expect(
    reflection.boundGlobals.find(({ group, binding }) => group === 0 && binding === 34)?.span,
  ).toBe(112);
  expect(reflection.boundGlobals.some(({ group, binding }) => group === 1 && binding === 8)).toBe(
    false,
  );
  const local = defines.DEFERRED_LIGHT_PROBE_AVAILABLE === true ? [0] : [];
  const gi = defines.DEFERRED_DIFFUSE_GI_AVAILABLE === true ? [4] : [];
  for (const suffix of ['', '_reflections', '_subsurface']) {
    const bindings = (arraySuffix: string) =>
      reflection?.entryPoints?.find(
        (entry) => entry.name === `fs_standard_deferred${suffix}${arraySuffix}`,
      )?.bindings;
    expect(
      bindings('')
        ?.filter(({ group }) => group === 3)
        .map(({ binding }) => binding),
    ).toEqual([...local, ...gi]);
    expect(
      bindings('_array_single')
        ?.filter(({ group }) => group === 3)
        .map(({ binding }) => binding),
    ).toEqual([...local, 1, 3, ...gi]);
    expect(
      bindings('_array_dual')
        ?.filter(({ group }) => group === 3)
        .map(({ binding }) => binding),
    ).toEqual([...local, 1, 2, 3, ...gi]);
    // Both array lanes retain the shared sky fallback for surfaces without a local probe.
    for (const arraySuffix of ['_array_single', '_array_dual']) {
      expect(
        bindings(arraySuffix)?.some(({ group, binding }) => group === 1 && binding === 9),
      ).toBe(true);
    }
  }
  const reflectedBindings = (name: string, groupId: number) =>
    reflection.entryPoints
      ?.find((entry) => entry.name === name)
      ?.bindings.filter(({ group }) => group === groupId)
      .map(({ binding }) => binding);
  const overflowMaterialBindings = [0, 1, 2, 3, 4, 5, 6, 7];
  if (defines.ENV_BRDF_LUT === true) overflowMaterialBindings.push(10);
  for (const entry of [
    'fs_standard_deferred_reflection_overflow',
    'fs_standard_deferred_reflections_overflow',
  ]) {
    expect(reflectedBindings(entry, 0)).toEqual([0]);
    expect(reflectedBindings(entry, 1)).toEqual(overflowMaterialBindings);
    expect(reflectedBindings(entry, 2)).toEqual([]);
    expect(reflectedBindings(entry, 3)).toEqual([1, 3]);
  }
  expect(reflectedBindings('vs_standard_deferred_reflection_overflow', 3)).toEqual([]);
  if (defines.DIRECTIONAL_PCSS_AVAILABLE === true) {
    for (const suffix of [
      '',
      '_channels',
      '_channels_array_single',
      '_channels_array_dual',
      '_overflow',
    ]) {
      const compact = `fs_standard_deferred_compact${suffix}`;
      const reflections = `fs_standard_deferred_compact_reflections${suffix}`;
      const bindings = reflectedBindings(compact, 1);
      expect(bindings).toContain(3);
      expect(bindings?.includes(15)).toBe(suffix !== '');
      expect(reflectedBindings(reflections, 1)).toEqual(bindings);
      expect(reflectedBindings(reflections, 3)).toEqual(reflectedBindings(compact, 3));
    }
  }
});
