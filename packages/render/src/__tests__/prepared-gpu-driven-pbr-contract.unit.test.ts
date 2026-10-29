import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { type PrepareGpuDrivenDrawInput, prepareGpuDrivenDraw } from '../gpu-driven/prepared-draw';

function input(skinned = false): PrepareGpuDrivenDrawInput {
  const receipt = createStandardPbrArtifactReceipt(skinned);
  return {
    material: { baseColor: vec3.create(1, 1, 1), metallic: 0, roughness: 0.5, passes: [] },
    deformation: skinned ? 'skin' : 'rigid',
    artifact: {
      material: 'forgeax::default-standard-pbr',
      pass: 'forward',
      program: createMaterialShaderProgram('fixture'),
      layoutIdentity: receipt.reflection.layoutIdentity,
      bindings: [],
      deps: [],
      vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
      receipt,
    },
    geometry: {
      identity: 'box',
      vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
      topology: 'triangle-list',
      indexed: true,
    },
    generation: receipt.generation,
    draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
  };
}

it('carries both addressing entries and the producer material ABI into preparation', () => {
  const value = input(),
    result = prepareGpuDrivenDraw(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    directEntry: value.artifact.receipt?.directEntry,
    sceneIndexEntry: value.artifact.receipt?.sceneIndexEntry,
    materialRow: value.artifact.receipt?.materialRow,
    resourceSlots: value.artifact.receipt?.resourceSlots,
  });
});

it('uses the published receipt independently of the logical shader name', () => {
  const value = input();
  const result = prepareGpuDrivenDraw({
    ...value,
    artifact: { ...value.artifact, material: 'game::custom' },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.identity.material).toBe('game::custom');
  expect(result.value.vertexInputs).toBe(value.artifact.receipt?.vertexInputs);
  expect(result.value.receiptGeneration).toBe(value.generation);
});

it.each([
  'missing-uv',
  'reflection-mismatch',
  'vertex-input-mismatch',
  'alpha-mask-mismatch',
  'stale-generation',
] as const)('rejects %s before a draw can be recorded', (code) => {
  let value = input();
  const receipt = value.artifact.receipt;
  if (receipt === undefined) throw new Error('Missing fixture receipt');
  switch (code) {
    case 'missing-uv':
      value = {
        ...value,
        geometry: { ...value.geometry, vertexInputs: [] },
        artifact: {
          ...value.artifact,
          receipt: { ...receipt, uvSets: receipt.uvSets.map((uv) => ({ ...uv, set: 1 })) },
        },
      };
      break;
    case 'reflection-mismatch':
      value = { ...value, artifact: { ...value.artifact, layoutIdentity: 'wrong-layout' } };
      break;
    case 'vertex-input-mismatch':
      value = {
        ...value,
        geometry: {
          ...value.geometry,
          vertexInputs: value.geometry.vertexInputs.filter(
            (vertex) => vertex.semantic !== 'normal',
          ),
        },
      };
      break;
    case 'alpha-mask-mismatch':
      value = {
        ...value,
        artifact: {
          ...value.artifact,
          receipt: {
            ...receipt,
            alphaMask: { ...receipt.alphaMask, cutoff: 'alphaCutoff', source: '' },
          },
        },
      };
      break;
    case 'stale-generation':
      value = { ...value, generation: value.generation + 1 };
      break;
  }
  expect(prepareGpuDrivenDraw(value)).toMatchObject({ ok: false, error: { code } });
});

it('derives Skin admission from the actual paired vertex contract', () => {
  const valid = prepareGpuDrivenDraw(input(true));
  expect(valid.ok).toBe(true);
  if (!valid.ok) throw valid.error;
  expect(valid.value.identity.deformation).toBe('skin');
  expect(valid.value.vertexInputs.some((input) => input.semantic === 'skinIndex')).toBe(true);
  expect(valid.value.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(true);
  expect(prepareGpuDrivenDraw({ ...input(), deformation: 'skin' })).toMatchObject({
    ok: false,
    error: { code: 'skin-receipt-mismatch' },
  });
});
