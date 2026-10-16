import { describe, expect, it } from 'vitest';
import { validateMaterialTangentInputs } from '../bridge.js';
import { checkExtensions } from '../check-extensions.js';
import { parseMaterial } from '../material/parse-material.js';

describe('KHR_materials_clearcoat projection', () => {
  it('projects factor, R/G textures, coat normal RG, scale, and transform facts', () => {
    const result = parseMaterial(
      {
        extensions: {
          KHR_materials_clearcoat: {
            clearcoatFactor: 0.75,
            clearcoatTexture: {
              index: 0,
              texCoord: 2,
              extensions: { KHR_texture_transform: { offset: [0.25, 0.5] } },
            },
            clearcoatRoughnessFactor: 0.25,
            clearcoatRoughnessTexture: { index: 1, texCoord: 3 },
            clearcoatNormalTexture: { index: 2, texCoord: 4, scale: 0.5 },
          },
        },
      } as never,
      [{ source: 0 }, { source: 1 }, { source: 2 }],
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        clearcoatFactor: 0.75,
        clearcoatChannel: 0,
        clearcoatRoughnessFactor: 0.25,
        clearcoatRoughnessChannel: 1,
        clearcoatNormalTexture: { texture: 2, texCoord: 4, scale: 0.5 },
        clearcoatNormalChannel: [0, 1],
      });
      expect((result.value as unknown as Record<string, unknown>).clearcoatTexture).toMatchObject({
        texture: 0,
        texCoord: 2,
        transform: { offset: [0.25, 0.5] },
      });
    }
  });

  it('admits the clearcoat extension as a required extension', () => {
    const result = checkExtensions({ extensionsRequired: ['KHR_materials_clearcoat'] });
    expect(result.ok).toBe(true);
  });

  it('reports tangent admission with material, mesh, layer, UV, and attributes', () => {
    const result = validateMaterialTangentInputs(
      {
        name: 'coat',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5,
        clearcoatNormalTexture: { texture: 0 },
      } as never,
      {
        name: 'mesh',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        texcoord0: new Float32Array([0, 0, 0, 0, 0, 0]),
        materialIndex: 0,
        meshIndex: 0,
        indices: new Uint32Array([0, 1, 2]),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-tangent-required');
      expect(result.error.detail).toMatchObject({
        material: 'coat',
        mesh: 'mesh',
        layer: 'clearcoat',
        uv: 'TEXCOORD_0',
        attributes: ['NORMAL', 'TEXCOORD_0', 'TANGENT'],
      });
    }
  });

  it('requires a tangent frame for scalar-only anisotropy', () => {
    const result = validateMaterialTangentInputs(
      {
        name: 'anisotropic-scalar',
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.5,
        anisotropyStrength: 0.4,
        anisotropyRotation: 0,
      } as never,
      {
        name: 'mesh-without-frame',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        materialIndex: 0,
        meshIndex: 0,
        indices: new Uint32Array([0, 1, 2]),
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-tangent-required');
      expect(result.error.detail).toMatchObject({
        material: 'anisotropic-scalar',
        mesh: 'mesh-without-frame',
        layer: 'anisotropy',
        uv: 'TEXCOORD_0',
        attributes: ['NORMAL', 'TEXCOORD_0', 'TANGENT'],
      });
    }
  });
});
