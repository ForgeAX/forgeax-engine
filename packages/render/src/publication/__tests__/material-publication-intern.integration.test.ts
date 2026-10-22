import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { AssetHandle, MaterialAsset, MaterialProgramAbi } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { materialRecordFixture } from '../../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { MeshFilter, MeshRenderer } from '../../components';
import { renderMaterialContext } from '../../extract/material-context';
import { isOwnedRenderFeatureProgramData } from '../../features/prepared-gpu-work';
import { type RenderPublication, renderPublicationTransfers } from '../contract';
import { PublicationMaterialProjectionAdmission } from '../programs';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

type Projection = NonNullable<RenderPublication['assets'][number]['materialProjection']>;

/** A Standard-sized ABI: row fields, texture slots, vertex inputs and entry reads. */
function abi(generation: number, index: number): MaterialProgramAbi {
  const fields = Array.from({ length: 24 }, (_, field) => `field_${index}_${field}`);
  const slots = Array.from({ length: 6 }, (_, slot) => ({
    name: `texture_${slot}`,
    parameter: `texture_${slot}`,
    kind: 'texture' as const,
    group: 2,
    binding: slot + 1,
  }));
  const inputs = [
    { semantic: 'position', location: 0, format: 'float32x3' },
    { semantic: 'normal', location: 1, format: 'float32x3' },
    { semantic: 'uv0', location: 2, format: 'float32x2' },
  ];
  return {
    entryPoints: [
      {
        name: 'vs_main',
        stage: 'vertex',
        bindings: [
          { group: 0, binding: 0 },
          { group: 1, binding: 0, fields: fields.slice(0, 8) },
        ],
      },
      {
        name: 'fs_main',
        stage: 'fragment',
        bindings: [
          { group: 1, binding: 0, fields },
          ...slots.map((slot) => ({ group: slot.group, binding: slot.binding })),
        ],
      },
    ],
    directEntry: 'vs_main',
    materialRow: { byteLength: fields.length * 16, fields },
    resourceSlots: slots,
    uvSets: [{ parameter: 'texture_0', set: 0 }],
    vertexInputs: inputs,
    alphaMask: { cutoff: 'alphaCutoff', source: 'baseColor.a' },
    reflection: { layoutIdentity: `layout-${index}`, resourceSlots: slots, vertexInputs: inputs },
    receiptIdentity: `layout-${index}`,
    generation,
  };
}

/** One cooked root whose runtime copies all share its program projection. */
async function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const context = renderMaterialContext(device.caps).materialContext;
  if (context === undefined) throw new Error('Missing material context');
  const variants = [
    'storage-buffer-minimum',
    'storage-buffer-projector',
    'storage-buffer-atmosphere',
  ] as const;
  const base = materialRecordFixture({
    passes: [
      { name: 'Forward', program: { module: 'game::forward' } },
      { name: 'ShadowCaster', program: { module: 'game::shadow' } },
    ],
    contexts: [
      context,
      ...variants
        .filter((capability) => capability !== context.capability)
        .map((capability) => ({ ...context, capability })),
    ],
  });
  let index = 0;
  const programs = base.programs.map((program) => ({
    ...program,
    selections: program.selections.map((selection) => ({
      ...selection,
      address: 'direct' as const,
      entry: 'vs_main',
      abi: abi(base.publicationGeneration, index++),
    })),
  }));
  const artifactDigest = createMaterialProgramSetDigest(programs, base.resolved.passes);
  const record = {
    ...base,
    programs,
    artifactDigest,
    receipt: { ...base.receipt, identity: { ...base.receipt.identity, artifactDigest } },
  };
  const [first, ...rest] = record.resolved.passes;
  if (first === undefined) throw new Error('Missing fixture pass');
  publishRuntimeAssets(assets, [
    {
      guid: record.guid,
      asset: { kind: 'material', passes: [first, ...rest], cooked: record } as MaterialAsset,
    },
  ]);
  const root = (await assets.load(record.guid, 'material')).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  const spawn = (material: AssetHandle<'material', MaterialAsset>) =>
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  spawn(root);
  const identity = { source: 'material-publication-intern', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity, device.caps);
  const receiver = new RenderPublicationReceiver(identity);
  const receiving = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const timings = { prepareMs: 0, transportMs: 0, acceptMs: 0 };
  const publish = () => {
    let start = performance.now();
    const candidate = publisher.prepare(0).unwrap();
    timings.prepareMs += performance.now() - start;
    start = performance.now();
    // The Worker boundary: one structured clone per packet.
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    timings.transportMs += performance.now() - start;
    start = performance.now();
    const accepted = receiver.accept(packet, receiving);
    timings.acceptMs += performance.now() - start;
    expect(accepted.ok).toBe(true);
    candidate.accept();
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return packet;
  };
  const copy = () => spawn(assets.copy(root).unwrap() as AssetHandle<'material', MaterialAsset>);
  const admitted = () =>
    [
      ...(
        receiver as unknown as { assets: Map<number, RenderPublication['assets'][number]> }
      ).assets.values(),
    ].flatMap((row) =>
      row.value.kind === 'material' && row.materialProjection != null
        ? [{ value: row.value, projection: row.materialProjection }]
        : [],
    );
  return {
    receiving,
    publish,
    copy,
    admitted,
    timings,
    reset: () => Object.assign(timings, { prepareMs: 0, transportMs: 0, acceptMs: 0 }),
    dispose: () => {
      receiver.dispose();
      publisher.dispose();
    },
  };
}

const N = 200;

it('publishes copied materials with one shared, validated program projection', async () => {
  const f = await fixture();
  try {
    f.publish();
    for (let i = 0; i < 20; i += 1) f.copy();
    f.publish();
    f.reset();
    for (let i = 0; i < N; i += 1) {
      f.copy();
      f.publish();
    }
    const incremental = { ...f.timings };
    f.reset();
    for (let i = 0; i < N; i += 1) f.copy();
    const batch = f.publish();
    const batched = { ...f.timings };
    if (process.env.FORGEAX_MATERIAL_PUBLICATION_BENCH !== undefined) {
      const format = (t: typeof incremental) =>
        `prepare=${t.prepareMs.toFixed(1)}ms transport=${t.transportMs.toFixed(1)}ms ` +
        `accept=${t.acceptMs.toFixed(1)}ms (${((t.prepareMs + t.acceptMs) / N).toFixed(3)} ms/material)`;
      process.stderr.write(
        `[material-publication] N=${N} incremental ${format(incremental)}; batch ${format(batched)}\n`,
      );
    }
    // Publisher: every copied row references one detached projection, and the
    // structured clone keeps that sharing across the Worker boundary.
    const rows = batch.assets.filter((row) => row.value.kind === 'material');
    expect(rows).toHaveLength(N);
    expect(new Set(rows.map((row) => row.materialProjection)).size).toBe(1);
    // Receiver: every admitted material, across all packets, holds the same
    // frozen owned projection, registered for its own payload.
    const admitted = f.admitted();
    expect(admitted.length).toBe(2 * N + 21);
    const projections = new Set(admitted.map((row) => row.projection));
    expect(projections.size).toBe(1);
    const [projection] = projections;
    expect(isOwnedRenderFeatureProgramData(projection)).toBe(true);
    expect(Object.isFrozen(projection?.passes[0]?.programs[0]?.abi)).toBe(true);
    for (const row of admitted)
      expect(f.receiving.getMaterialProjectionForPayload(row.value)).toBe(projection);
  } finally {
    f.dispose();
  }
}, 60_000);

function receivedProjection(): Projection {
  const program = {
    context: {
      backend: 'webgpu',
      capability: 'storage-buffer',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
    },
    specializationKey: 'program/a',
    artifactHash: 'sha256:a',
    address: 'direct',
    entry: 'vs_main',
    abi: abi(1, 0),
  } as const;
  return {
    materialGuid: 'material',
    publicationGeneration: 1,
    specializationKey: 'publication/a',
    artifactHash: 'sha256:set',
    passes: [{ name: 'Forward', module: 'game::forward', programs: [program] }],
    runtimeValues: { factor: 1 },
    staticSelection: [],
  };
}

const material = {
  kind: 'material',
  passes: [{ name: 'Forward', program: { module: 'game::forward' } }],
} as MaterialAsset;

it('reuses owned projections only for equal, validated content and rechecks receiver facts', () => {
  const admission = new PublicationMaterialProjectionAdmission();
  const available = () => true;
  const first = admission.admit(structuredClone(receivedProjection()), material, available);
  expect(first).toBeDefined();
  expect(isOwnedRenderFeatureProgramData(first)).toBe(true);
  // A fresh Worker clone with equal content reuses the owned copy.
  expect(admission.admit(structuredClone(receivedProjection()), material, available)).toBe(first);
  expect(admission.size).toEqual({ projections: 1, programs: 1 });
  // Receiver state and the material's own passes are never cached.
  expect(admission.admit(structuredClone(receivedProjection()), material, () => false)).toBe(
    undefined,
  );
  const otherPass = {
    kind: 'material',
    passes: [{ name: 'Forward', program: { module: 'game::other' } }],
  } as MaterialAsset;
  expect(admission.admit(structuredClone(receivedProjection()), otherPass, available)).toBe(
    undefined,
  );
  // The same digest with different content is validated, not trusted.
  const forged = structuredClone(receivedProjection()) as unknown as {
    passes: { programs: { abi: { generation: number } }[] }[];
  };
  const forgedAbi = forged.passes[0]?.programs[0]?.abi;
  if (forgedAbi === undefined) throw new Error('Missing ABI');
  forgedAbi.generation = 0;
  expect(admission.admit(forged, material, available)).toBe(undefined);
  // Different values keep a distinct projection that shares the program row.
  const changed = structuredClone(receivedProjection());
  const valued = admission.admit({ ...changed, runtimeValues: { factor: 2 } }, material, available);
  expect(valued).toBeDefined();
  expect(valued).not.toBe(first);
  expect(valued?.runtimeValues).toEqual({ factor: 2 });
  expect(valued?.passes[0]?.programs[0]).toBe(first?.passes[0]?.programs[0]);
  // A packet-local alias skips even the comparison.
  const aliases = new Map<object, Projection>();
  const shared = structuredClone(receivedProjection());
  expect(admission.admit(shared, material, available, aliases)).toBe(first);
  expect(aliases.get(shared)).toBe(first);
});
