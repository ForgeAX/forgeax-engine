import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseReflection } from '../reflection.js';

const commonWgsl = readFileSync(
  fileURLToPath(new URL('../../../shader/src/common.wgsl', import.meta.url)),
  'utf8',
);

describe('Fog View ABI reflection', () => {
  it('keeps analytic fog producers out of the shared View ABI', () => {
    // Volumetric fog owns its sampled density/integration inputs in the
    // render-graph feature.  The shared View UBO is intentionally limited to
    // camera, lighting, shadow, and temporal facts; reintroducing FogRay or a
    // finite FogViewParams member here would create a second producer path.
    expect(commonWgsl).not.toMatch(/struct FogViewParams\s*\{/);
    expect(commonWgsl).not.toMatch(/struct FogRay\s*\{/);
    expect(commonWgsl).not.toMatch(/\bfog\s*:\s*FogViewParams/);
    expect(commonWgsl).toMatch(/temporalPreviousCameraPos\s*:\s*vec4<f32>/);
  });

  it('round-trips reflected View fog metadata without changing JSON shape', () => {
    const reflection = {
      schemaVersion: 'shader-reflection/2',
      boundGlobals: [
        {
          group: 0,
          binding: 0,
          addressSpace: 'uniform',
          resourceKind: 'buffer',
          visibility: 2,
          members: [
            { name: 'fog.color', type: 'vec3<f32>', offset: 800, size: 16, alignment: 16 },
            { name: 'fog.density', type: 'f32', offset: 816, size: 4, alignment: 4 },
            { name: 'fog.heightFalloff', type: 'f32', offset: 820, size: 4, alignment: 4 },
            { name: 'fog.maxOpacity', type: 'f32', offset: 824, size: 4, alignment: 4 },
          ],
          span: 832,
        },
      ],
      uvSetCount: 0,
    } as const;
    const parsed = parseReflection(JSON.stringify(reflection));

    expect(parsed.wire).toEqual(reflection);
    expect(parsed.wire.boundGlobals[0]?.members?.map((member) => member.name)).toEqual([
      'fog.color',
      'fog.density',
      'fog.heightFalloff',
      'fog.maxOpacity',
    ]);
  });
});
