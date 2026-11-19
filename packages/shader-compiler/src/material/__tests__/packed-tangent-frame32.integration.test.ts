import { expect, it } from 'vitest';
import { materialVertexInputs } from '../cook';
import { cookStaticShadow } from './standard-static-shadow.fixture';

it.each([
  'mesh',
  'skinned',
] as const)('compiles direct, scene and shadow %s inputs for one packed tangent frame', async (geometry) => {
  const { forward, shadow } = await cookStaticShadow({ normalMapped: true, context: { geometry } });
  for (const pass of [forward, shadow])
    for (const [address, compiled] of [
      ['direct', pass.compile],
      ['scene', pass.sceneCompile],
    ] as const) {
      expect(compiled).toBeDefined();
      if (!compiled) throw new Error('missing compiled pass');
      const ordinary = address === 'direct' ? 'vs_main' : 'vs_scene_index';
      const inputs = materialVertexInputs(compiled.wgsl, `${ordinary}_packed`);
      expect(pass.abi.tangentFrame32?.vertexInputs).toEqual(inputs);
      expect(inputs.find((input) => input.semantic === 'tangentFrame')).toEqual({
        semantic: 'tangentFrame',
        location: 14,
        format: 'uint32',
      });
      expect(
        inputs.some((input) => input.semantic === 'normal' || input.semantic === 'tangent'),
      ).toBe(false);
      expect(inputs.some((input) => input.semantic === 'position')).toBe(true);
      expect(inputs.some((input) => input.semantic === 'skinIndex')).toBe(geometry === 'skinned');
      expect(inputs.filter((input) => input.semantic !== 'tangentFrame')).toEqual(
        materialVertexInputs(compiled.wgsl, ordinary).filter(
          (input) => input.semantic !== 'normal' && input.semantic !== 'tangent',
        ),
      );
      expect(compiled.wgsl).toContain('decodeTangentFrame32');
    }
});
