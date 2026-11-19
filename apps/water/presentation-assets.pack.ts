import {
  createBoxGeometry,
  createCylinderGeometry,
  createIcosahedronGeometry,
} from '@forgeax/engine/geometry';
import { definePack } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok, type TextureAsset } from '@forgeax/engine/types';
import { presentationGuid, WATER_PRESENTATION_PACKAGE } from './presentation-identity';
import {
  environment,
  palmFrondMesh,
  surfaceTexture,
} from './r8-integration-acceptance/assets/procedural';

function limestoneTexture(): TextureAsset {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const vein = Math.sin(x * 0.045 + Math.sin(y * 0.025) * 3.5);
      let hash = Math.imul(x + y * size + 17, 0x45d9f3b);
      hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
      const grain = ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
      const shade = 0.92 + vein * 0.012 + grain * 0.025;
      const index = (y * size + x) * 4;
      data[index] = Math.round(244 * shade);
      data[index + 1] = Math.round(238 * shade);
      data[index + 2] = Math.round(221 * shade);
      data[index + 3] = 255;
    }
  return {
    kind: 'texture',
    shape: { viewDimension: '2d', extent: { width: size, height: size } },
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    data,
    mips: { kind: 'generate' },
  };
}

/** Shared authored set dressing. Water products remain owned by each stage's own Pack. */
export default definePack({
  schemaVersion: '2.0.0',
  packageId: WATER_PRESENTATION_PACKAGE,
  name: 'Water observatory assets',
  build: () =>
    ok({
      'texture/fft-phase': {
        kind: 'texture',
        shape: { viewDimension: '2d', extent: { width: 64, height: 64 } },
        format: 'rgba8unorm',
        colorSpace: 'linear',
        mips: { kind: 'none' },
        data: Uint8Array.from(
          { length: 64 * 64 * 4 },
          (_, index) => (Math.imul(index + 731, 1664525) + 1013904223) >>> 24,
        ),
      },
      'texture/wood': surfaceTexture('wood'),
      'texture/rock': surfaceTexture('rock'),
      'texture/sand': surfaceTexture('sand'),
      'texture/limestone': limestoneTexture(),
      'sky/day': environment('day', false, 512),
      'mesh/plank': createBoxGeometry(1, 1, 1).unwrap(),
      'mesh/post': createCylinderGeometry(0.15, 0.18, 1, 12).unwrap(),
      'mesh/rock': createIcosahedronGeometry(1, 2).unwrap(),
      'mesh/frond': palmFrondMesh(),
      'material/wood': Materials.standard({
        baseColor: [0.45, 0.26, 0.12, 1],
        roughness: 0.78,
        baseColorTexture: presentationGuid('texture/wood'),
      }),
      'material/rock': Materials.standard({
        baseColor: [0.56, 0.61, 0.58, 1],
        roughness: 0.92,
        baseColorTexture: presentationGuid('texture/rock'),
      }),
      'material/sand': Materials.standard({
        baseColor: [0.74, 0.61, 0.39, 1],
        roughness: 0.94,
        baseColorTexture: presentationGuid('texture/sand'),
      }),
      'material/leaf': Materials.standard({
        baseColor: [0.09, 0.29, 0.14, 1],
        roughness: 0.8,
        doubleSided: true,
      }),
      'material/brass': Materials.standard({
        baseColor: [0.72, 0.49, 0.17, 1],
        metallic: 0.68,
        roughness: 0.3,
      }),
      'material/limestone': Materials.standard({
        baseColor: [0.76, 0.73, 0.65, 1],
        roughness: 0.55,
        baseColorTexture: presentationGuid('texture/limestone'),
      }),
      'material/plaster': Materials.standard({
        baseColor: [0.63, 0.67, 0.62, 1],
        roughness: 0.86,
      }),
      'material/ink': Materials.standard({
        baseColor: [0.035, 0.085, 0.09, 1],
        metallic: 0.25,
        roughness: 0.36,
      }),
      'material/lamp': Materials.standard({
        baseColor: [0.88, 0.76, 0.5, 1],
        emissive: [1, 0.77, 0.4],
        emissiveIntensity: 1.2,
        roughness: 0.55,
      }),
    }),
});
