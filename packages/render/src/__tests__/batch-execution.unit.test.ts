import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
} from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import {
  type BatchGeometry,
  type BatchPass,
  captureBatchGeometry,
  prepareBatchExecution,
} from '../gpu-driven/batch-execution';
import type { MaterialSnapshot } from '../render-system-extract';

const receipt = createStandardPbrArtifactReceipt();
const artifact = {
  material: 'forgeax::default-standard-pbr',
  pass: 'forward',
  program: createMaterialShaderProgram('fixture'),
  layoutIdentity: receipt.reflection.layoutIdentity,
  bindings: [],
  deps: [],
  vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
  receipt,
};
const geometry: BatchGeometry = {
  receipt: {
    identity: 'box',
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    topology: 'triangle-list',
    indexed: true,
  },
  draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
  deformation: 'rigid',
};
const pass: BatchPass = { kind: 'forward', shaderId: artifact.material };
const material: MaterialSnapshot = {
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 0.5,
  passes: [],
};

it('prepares one shared geometry and material version without entity inputs', () => {
  const resolve = vi.fn(() => artifact);
  const accepted = prepareBatchExecution(geometry, material, pass, resolve).unwrap();
  expect(accepted.route).toBe('gpu');
  expect(resolve).toHaveBeenCalledExactlyOnceWith(pass.shaderId, {
    vertexColorAvailable: false,
    deformation: 'rigid',
    pass: 'forward',
    address: 'scene-index',
  });
  if (accepted.route !== 'gpu') throw new Error('Expected shared GPU execution');
  const next = { ...material, roughness: 0.9 };
  const replaced = prepareBatchExecution(geometry, next, pass, resolve).unwrap();
  expect(accepted.material).toBe(material);
  expect(accepted.material.roughness).toBe(0.5);
  expect(replaced.route).toBe('gpu');
});

it('routes each selected Pass independently of the primary material summary', () => {
  const resolve = vi.fn(() => artifact);
  const opaque = prepareBatchExecution(
    geometry,
    { ...material, transparent: true },
    pass,
    resolve,
  ).unwrap();
  expect(opaque.route).toBe('gpu');
  const blend = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  } as const;
  resolve.mockClear();
  const transparent = prepareBatchExecution(
    geometry,
    material,
    { ...pass, renderState: { blend } },
    resolve,
  ).unwrap();
  expect(transparent.route).toBe('direct');
  expect(resolve).not.toHaveBeenCalled();
});

it('does not request scene programs for absent Passes or external texture routes', () => {
  const resolve = vi.fn(() => undefined);
  expect(prepareBatchExecution(geometry, material, undefined, resolve).unwrap()).toEqual({
    route: 'none',
  });
  expect(
    prepareBatchExecution(
      geometry,
      { ...material, videoTextureFields: new Map([['baseColorTexture', 1]]) as never },
      pass,
      resolve,
    ).unwrap().route,
  ).toBe('direct');
  expect(resolve).not.toHaveBeenCalled();
});

it('checks the ShadowCaster depth state independently of the Forward route', () => {
  const resolve = vi.fn(() => artifact);
  const execution = prepareBatchExecution(
    geometry,
    material,
    { ...pass, kind: 'shadow', renderState: { depthWriteEnabled: false } },
    resolve,
  ).unwrap();
  expect(execution.route).toBe('direct');
  expect(resolve).not.toHaveBeenCalled();
});

it('keeps missing declared receipts and incompatible geometry as structured failures', () => {
  const published = { ...pass, shaderId: 'game::direct', sceneIndexProgramKey: 'game::scene' };
  expect(prepareBatchExecution(geometry, material, published, () => undefined)).toMatchObject({
    ok: false,
    error: { code: 'missing-material-receipt' },
  });
  const incompatible = {
    ...geometry,
    receipt: {
      ...geometry.receipt,
      vertexInputs: geometry.receipt.vertexInputs.filter((input) => input.semantic !== 'normal'),
    },
  };
  expect(prepareBatchExecution(incompatible, material, pass, () => artifact)).toMatchObject({
    ok: false,
    error: { code: 'vertex-input-mismatch' },
  });
  expect(
    prepareBatchExecution({ ...geometry, deformation: 'skin' }, material, pass, () => artifact),
  ).toMatchObject({ ok: false, error: { code: 'skin-receipt-mismatch' } });
});

it('selects a replacement program under the same logical material name', () => {
  const first = prepareBatchExecution(geometry, material, pass, () => artifact).unwrap();
  const replacement = {
    ...artifact,
    program: createMaterialShaderProgram('changed fixture'),
    receipt: { ...receipt, generation: receipt.generation + 1 },
  };
  const second = prepareBatchExecution(geometry, material, pass, () => replacement).unwrap();
  if (first.route !== 'gpu' || second.route !== 'gpu')
    throw new Error('Expected shared GPU executions');
  expect(first.artifact.program).toBe(artifact.program);
  expect(second.artifact.program).toBe(replacement.program);
  expect(second.prepared.receiptGeneration).toBe(receipt.generation + 1);
});

it('captures geometry bytes independently and shares only its owned immutable result', () => {
  const borrowed = {
    ...geometry,
    draw: { ...geometry.draw },
    receipt: {
      ...geometry.receipt,
      vertexInputs: geometry.receipt.vertexInputs.map((input) => ({ ...input })),
    },
  };
  const captured = captureBatchGeometry(borrowed);
  expect(captureBatchGeometry(captured)).toBe(captured);
  borrowed.draw.count = 6;
  borrowed.receipt.vertexInputs.length = 0;
  expect(captured.draw.count).toBe(36);
  expect(captured.receipt.vertexInputs.length).toBeGreaterThan(0);
  expect(Object.isFrozen(captured.draw)).toBe(true);
  const next = captureBatchGeometry(borrowed);
  expect(next.draw.count).toBe(6);
  expect(next.receipt.vertexInputs).toHaveLength(0);
});

it.each([
  'point-list',
  'line-list',
  'line-strip',
] as const)('omits %s Shadow Passes before requesting a program', (topology) => {
  const resolve = vi.fn(() => artifact);
  const result = prepareBatchExecution(
    { ...geometry, draw: { ...geometry.draw, topology } },
    material,
    { ...pass, kind: 'shadow' },
    resolve,
  ).unwrap();
  expect(result.route).toBe('none');
  expect(resolve).not.toHaveBeenCalled();
});
