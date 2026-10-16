import { describe, expect, it } from 'vitest';
import { toMaterialAsset } from '../bridge.js';
import { parseGltf, toAssetPack } from '../parse-gltf.js';

const noopLoader = async (_uri: string) => new ArrayBuffer(0);

describe('glTF transmission carrier route', () => {
  it('keeps required transmission extensions through parse, pack identity, and Standard bridge', async () => {
    const source = {
      asset: { version: '2.0' },
      extensionsRequired: [
        'KHR_materials_transmission',
        'KHR_materials_ior',
        'KHR_materials_volume',
      ],
      extensionsUsed: ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume'],
      materials: [
        {
          name: 'TransmissionSphere',
          pbrMetallicRoughness: {
            baseColorFactor: [0.76, 0.9, 1, 1],
            metallicFactor: 0,
            roughnessFactor: 0.06,
          },
          extensions: {
            KHR_materials_transmission: { transmissionFactor: 1 },
            KHR_materials_ior: { ior: 1.45 },
            KHR_materials_volume: {
              thicknessFactor: 0.12,
              attenuationColor: [0.9, 0.97, 1],
              attenuationDistance: 3,
            },
          },
        },
      ],
    };

    const parsed = await parseGltf(source, noopLoader, 'carrier/transmission.gltf');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const material = parsed.value.materials[0];
    if (material === undefined) throw new Error('transmission carrier did not parse a material');
    expect(material).toMatchObject({
      name: 'TransmissionSphere',
      transmissionFactor: 1,
      ior: 1.45,
      thicknessFactor: 0.12,
      attenuationColor: [0.9, 0.97, 1],
      attenuationDistance: 3,
    });

    const pack = toAssetPack(parsed.value, undefined, 'transmission.gltf');
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.value.subAssets).toEqual([
      expect.objectContaining({
        kind: 'material',
        name: 'TransmissionSphere',
        sourceKey: 'material:TransmissionSphere',
      }),
    ]);

    const bridged = toMaterialAsset(material);
    const pass = bridged.passes?.[0];
    if (pass === undefined) throw new Error('transmission bridge did not emit a Forward pass');
    if (pass.renderState === undefined)
      throw new Error('transmission bridge pass has no render state');
    expect(pass.program.module).toBe('forgeax::default-standard-pbr');
    expect(pass.renderState.queue).toBe(2000);
    expect(bridged.values).toMatchObject({
      baseColor: [0.76, 0.9, 1, 1],
      metallic: 0,
      roughness: 0.06,
      transmission: 1,
      ior: 1.45,
      thickness: 0.12,
      attenuationColor: [0.9, 0.97, 1],
      attenuationDistance: 3,
    });
  });
});
