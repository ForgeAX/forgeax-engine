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
    const vec3Descriptor = {
      kind: 'vector',
      scalarKind: 'float',
      width: 4,
      components: 3,
      byteSize: 12,
      alignment: 16,
    } as const;
    const f32Descriptor = {
      kind: 'scalar',
      scalarKind: 'float',
      width: 4,
      byteSize: 4,
      alignment: 4,
    } as const;
    const members = [
      {
        name: 'fog.color',
        type: 'vec3<f32>',
        offset: 800,
        size: 12,
        alignment: 16,
        typeDescriptor: vec3Descriptor,
      },
      {
        name: 'fog.density',
        type: 'f32',
        offset: 816,
        size: 4,
        alignment: 4,
        typeDescriptor: f32Descriptor,
      },
      {
        name: 'fog.heightFalloff',
        type: 'f32',
        offset: 820,
        size: 4,
        alignment: 4,
        typeDescriptor: f32Descriptor,
      },
      {
        name: 'fog.maxOpacity',
        type: 'f32',
        offset: 824,
        size: 4,
        alignment: 4,
        typeDescriptor: f32Descriptor,
      },
    ] as const;
    const reflection = {
      schemaVersion: 'shader-reflection/3',
      boundGlobals: [
        {
          group: 0,
          binding: 0,
          addressSpace: 'uniform',
          resourceKind: 'buffer',
          elementType: 'struct',
          visibility: 2,
          members,
          span: 832,
          typeDescriptor: {
            kind: 'struct',
            span: 832,
            byteSize: 832,
            alignment: 16,
            members,
          },
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
