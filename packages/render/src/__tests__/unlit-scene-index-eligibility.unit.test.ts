import { vec3 } from '@forgeax/engine-math';
import {
  createMaterialProgramArtifactReceipt,
  createMaterialShaderProgram,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
import { resolveMaterialShaderArtifact } from '../assembly/material/assembly';
import {
  type BatchArtifactResolver,
  type BatchGeometry,
  prepareBatchExecution,
} from '../gpu-driven/batch-execution';
import {
  defaultMaterialSnapshot,
  type MaterialSnapshot,
  runtimeMaterialShaderId,
} from '../render-system-extract';

const UNLIT = 'forgeax::default-unlit';
const vertexInputs = [
  { semantic: 'position', location: 0, format: 'float32x3' },
  { semantic: 'normal', location: 1, format: 'float32x3' },
  { semantic: 'uv', location: 2, format: 'float32x2' },
  { semantic: 'tangent', location: 3, format: 'float32x4' },
] as const;
// The producer publishes a receipt only for the rigid scene-index variant.
const sceneReceipt = createMaterialProgramArtifactReceipt({
  schema: DEFAULT_UNLIT_PARAM_SCHEMA,
  directEntry: 'vs_main',
  sceneIndexEntry: 'vs_main',
  vertexInputs,
});
const variant = (gpu: boolean, rigid: boolean) => ({
  definesKey: `GPU_DRIVEN_SCENE_INDEX_AVAILABLE=${gpu}+SKINNING_DISABLED=${rigid}+STORAGE_BUFFER_AVAILABLE=true`,
  defines: {
    GPU_DRIVEN_SCENE_INDEX_AVAILABLE: gpu,
    SKINNING_DISABLED: rigid,
    STORAGE_BUFFER_AVAILABLE: true,
  },
  composedWgsl: `unlit gpu=${gpu} rigid=${rigid}`,
  ...(gpu && rigid ? { receipt: sceneReceipt } : {}),
});
const shader = {
  materialProgram: createMaterialShaderProgram,
  findMaterialArtifact: () => ({
    ok: true as const,
    value: {
      program: createMaterialShaderProgram('unlit default'),
      source: 'unlit default',
      paramSchema: DEFAULT_UNLIT_PARAM_SCHEMA,
    },
  }),
  materialShaderManifestEntry: (identifier: string) =>
    identifier === UNLIT
      ? {
          identifier: UNLIT,
          sourcePath: 'unlit.wgsl',
          composedWgsl: 'unlit default',
          paramSchema: '[]',
          variants: [variant(true, true), variant(true, false), variant(false, true)],
        }
      : undefined,
} as unknown as Parameters<typeof resolveMaterialShaderArtifact>[1];
const resolve: BatchArtifactResolver = (id, request) =>
  resolveMaterialShaderArtifact(id, shader, request);
const geometry = (deformation: 'rigid' | 'skin'): BatchGeometry => ({
  receipt: {
    identity: `box-${deformation}`,
    vertexInputs: [
      ...vertexInputs,
      ...(deformation === 'skin'
        ? [
            { semantic: 'skinIndex', location: 4, format: 'uint16x4' },
            { semantic: 'skinWeight', location: 5, format: 'float32x4' },
          ]
        : []),
    ],
    topology: 'triangle-list',
    indexed: true,
  },
  draw: { kind: 'indexed', first: 0, count: 36, baseVertex: 0, topology: 'triangle-list' },
  deformation,
});
const material: MaterialSnapshot = {
  baseColor: vec3.create(1, 1, 1),
  metallic: 0,
  roughness: 1,
  passes: [],
  materialShaderId: UNLIT,
};

it('admits opaque unlit color and shadow Passes to the GPU-driven lane', () => {
  const forward = prepareBatchExecution(
    geometry('rigid'),
    material,
    { kind: 'forward', shaderId: UNLIT },
    resolve,
  ).unwrap();
  expect(forward.route).toBe('gpu');
  if (forward.route !== 'gpu') throw new Error('expected a scene-index execution');
  expect(forward.artifact.program.source).toBe('unlit gpu=true rigid=true');
  expect(forward.artifact.vertexEntry).toBe('vs_main');
  expect(forward.prepared.sceneIndexEntry).toBe('vs_main');
  // The scene row is the schema-derived unlit uniform layout.
  expect(forward.prepared.materialRow.byteLength).toBe(144);

  // The ShadowCaster Pass keeps its authored light-view entry in the same program.
  const shadow = prepareBatchExecution(
    geometry('rigid'),
    material,
    { kind: 'shadow', shaderId: UNLIT, vertexEntry: 'vs_shadow' },
    resolve,
  ).unwrap();
  expect(shadow.route).toBe('gpu');
  if (shadow.route !== 'gpu') throw new Error('expected a scene-index shadow execution');
  expect(shadow.artifact.vertexEntry).toBe('vs_shadow');
  expect(shadow.artifact.fragmentEntry).toBe('fs_shadow');
});

it('keeps blended, late-queue, skinned and direct-only unlit rows on the CPU lane', () => {
  const blend = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  } as const;
  expect(
    prepareBatchExecution(
      geometry('rigid'),
      material,
      { kind: 'forward', shaderId: UNLIT, renderState: { blend } },
      resolve,
    ).unwrap().route,
  ).toBe('direct');
  // GPU batches encode before the CPU list, so a later queue (x-ray overlay) stays direct.
  expect(
    prepareBatchExecution(
      geometry('rigid'),
      material,
      { kind: 'forward', shaderId: UNLIT, queue: 3000 },
      resolve,
    ).unwrap().route,
  ).toBe('direct');
  // The skinned scene-index variant publishes no receipt.
  expect(
    resolveMaterialShaderArtifact(UNLIT, shader, {
      address: 'scene-index',
      deformation: 'skin',
      vertexColorAvailable: false,
      pass: 'forward',
    }),
  ).toBeUndefined();
  expect(
    prepareBatchExecution(
      geometry('skin'),
      material,
      { kind: 'forward', shaderId: UNLIT },
      resolve,
    ).unwrap().route,
  ).toBe('direct');
  // Direct addressing never selects the scene-index program.
  expect(
    resolveMaterialShaderArtifact(UNLIT, shader, {
      address: 'direct',
      deformation: 'rigid',
      pass: 'forward',
    }),
  ).toBeUndefined();
});

it('reads the default material row through its own Unlit program in every Pass', () => {
  // The GPU Scene packs the default row with the snapshot's program ABI; a
  // Standard shadow caster would bind it as an 880-byte MaterialParameters.
  const snapshot = defaultMaterialSnapshot();
  expect(snapshot.materialShaderId).toBe(UNLIT);
  expect(snapshot.passes.map((pass) => pass.name)).toContain('shadow-caster');
  for (const pass of snapshot.passes)
    expect(runtimeMaterialShaderId(pass.program.module, pass.name)).toBe(UNLIT);
});

it('reports unlit geometry the scene-index receipt cannot consume as a CPU-lane recovery', () => {
  // hello-topology: position-only line geometry with the default material.
  const lines: BatchGeometry = {
    receipt: {
      identity: 'wireframe',
      vertexInputs: [{ semantic: 'position', location: 0, format: 'float32x3' }],
      topology: 'line-list',
      indexed: false,
    },
    draw: { kind: 'non-indexed', first: 0, count: 36, baseVertex: 0, topology: 'line-list' },
    deformation: 'rigid',
  };
  // The batch join routes it direct; the error stays visible as the producer fact.
  const prepared = prepareBatchExecution(
    lines,
    material,
    { kind: 'forward', shaderId: UNLIT },
    resolve,
  );
  expect(prepared.ok).toBe(false);
  if (prepared.ok) throw new Error('expected a vertex-input failure');
  expect(prepared.error.code).toBe('vertex-input-mismatch');
  expect(prepared.error.detail.recovery).toBe('route-cpu-lane');
});
