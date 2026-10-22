import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass } from '@forgeax/engine-types';
import { assert, expect, it, vi } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import {
  type BatchArtifactResolver,
  prepareBatchExecution,
} from '../../gpu-driven/batch-execution';
import { BatchTopology } from '../../gpu-driven/batch-topology';
import { GpuDrawSelection } from '../../gpu-driven/draw-selection';
import {
  collectGpuDrivenMaterialArtifacts,
  GpuDrivenMaterialProgramProjection,
} from '../../gpu-driven/material-artifacts';
import { meshGeometryDraws } from '../../gpu-driven/mesh-batches';
import { InstanceProjectionStore } from '../../instances';
import { Materials } from '../../materials';
import type { RenderableSnapshot } from '../../render-system-extract';
import { MaterialDispatch } from '../../scene/material-dispatch';
import { effectiveMeshMaterials } from '../../scene/mesh-materials';
import { PersistentRenderScene } from '../../scene/render-scene';
import { renderPublicationTransfers } from '../contract';
import { preparePublicationGeometry } from '../prepare-geometry';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function artifact(material: string, pass: 'forward' | 'shadow'): MaterialShaderArtifact {
  const receipt = createStandardPbrArtifactReceipt();
  return {
    material,
    pass,
    program: createMaterialShaderProgram(`shadow-admission-${pass}`),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
}

function fixture(materialAsset: MaterialAsset = Materials.standard({ baseColor: [1, 1, 1, 1] })) {
  const assets = new AssetRegistry();
  const world = new World({ assets });
  const identity = { source: 'shadow-admission', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene({ assets });
  const instances = new InstanceProjectionStore();
  const material = assets.create(materialAsset).unwrap();
  const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const forward = artifact('forgeax::default-standard-pbr', 'forward');
  const shadow = artifact('forgeax::default-shadow-caster', 'shadow');
  const requests: { material: string; pass: string }[] = [];
  const resolve: BatchArtifactResolver = (material, request) => {
    requests.push({ material, pass: request.pass });
    const selected = request.pass === 'shadow' ? shadow : forward;
    return selected.material === material ? selected : undefined;
  };
  const publish = () => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const replay = structuredClone(packet);
    const received = receiver.accept(packet).unwrap();
    const prepared = preparePublicationGeometry(received, assets, instances);
    const frame = scene.consumePublication(prepared);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { received, frame, packet: replay };
  };
  const admit = (select: BatchArtifactResolver = resolve, source = scene) => {
    const slots = source.compositionSlots();
    const retained = source.compositionRetainedScene();
    assert(retained);
    const topology = new BatchTopology();
    topology.rebuild(slots);
    const dispatch = new MaterialDispatch();
    for (const slot of slots) dispatch.bind(slot.slot, slot.snapshot);
    dispatch.prepare(retained.meshes);
    const plan = topology.query(topology.sourcePlan(), retained.meshes);
    const selected = collectGpuDrivenMaterialArtifacts({
      batches: plan.batches,
      programs: new GpuDrivenMaterialProgramProjection().project(
        dispatch.query(slots, retained.meshes),
        dispatch.materials(),
      ),
      resolve: (id, request) => {
        assert(
          typeof request === 'object' &&
            request.deformation &&
            request.pass &&
            request.address === 'scene-index',
        );
        return select(id, {
          deformation: request.deformation,
          pass: request.pass,
          address: request.address,
          vertexColorAvailable: request.vertexColorAvailable ?? false,
        });
      },
      clustered: false,
      reflectionFallback: false,
      probeBlend: false,
      shadowViews: true,
    });
    const batches = plan.batches.filter(
      (batch) =>
        batch.binding !== undefined &&
        selected.batchExecutions.get(batch.binding)?.shadow.route === 'gpu',
    );
    return { ...selected, batches: plan.batches, selection: new GpuDrawSelection(batches) };
  };
  return {
    world,
    assets,
    publisher,
    receiver,
    scene,
    entity,
    material,
    mesh,
    forward,
    shadow,
    requests,
    resolve,
    publish,
    admit,
    actualSource(snapshot: RenderableSnapshot) {
      const retained = scene.compositionRetainedScene();
      assert(retained && snapshot.assetHandle !== undefined);
      const mesh = retained.meshes?.get(snapshot.worldId, snapshot.assetHandle);
      assert(mesh);
      const materials = effectiveMeshMaterials(snapshot, mesh);
      return {
        ...snapshot,
        ...materials,
        gpuDrivenDraws: meshGeometryDraws(mesh, materials.materials, 'rigid'),
      };
    },
    close() {
      publisher.dispose();
      receiver.dispose();
      scene.dispose();
      assets.dispose();
    },
  };
}

it('admits transferred geometry and independent Shadow programs through shared material execution', () => {
  const f = fixture();
  try {
    const { received } = f.publish();
    const accepted = f.scene.compositionSlots().at(0)?.snapshot;
    assert(accepted);
    expect(received.frame.renderables).toHaveLength(1);
    expect(accepted.gpuDrivenDraws?.[0]?.geometry).toBeDefined();
    const selected = f.admit();
    expect(
      [...selected.batchExecutions.values()].map(({ forward, shadow }) => [
        forward.route,
        shadow.route,
      ]),
    ).toEqual([['gpu', 'gpu']]);
    expect(selected.selection.has(f.actualSource(accepted), 0)).toBe(true);
    expect(f.requests).toEqual([
      { material: f.forward.material, pass: 'forward' },
      { material: f.shadow.material, pass: 'shadow' },
    ]);
  } finally {
    f.close();
  }
});

it('keeps a transferred caster on the direct lane until its independent Shadow program is available', () => {
  const f = fixture();
  try {
    f.publish();
    const withoutShadow = f.admit((material, request) =>
      request.pass === 'shadow' ? undefined : f.resolve(material, request),
    );
    expect(
      [...withoutShadow.batchExecutions.values()].map(({ forward, shadow }) => [
        forward.route,
        shadow.route,
      ]),
    ).toEqual([['gpu', 'direct']]);
    const source = f.scene.compositionSlots().at(0)?.snapshot;
    assert(source);
    expect(withoutShadow.selection.has(f.actualSource(source), 0)).toBe(false);
    expect(f.admit().selection.has(f.actualSource(source), 0)).toBe(true);
  } finally {
    f.close();
  }
});

function shadowMaterial(
  update: (shadow: MaterialPass) => readonly MaterialPass[],
): ReturnType<typeof Materials.standard> {
  const source = Materials.standard({ baseColor: [1, 1, 1, 1] });
  assert(source.passes);
  const [first, ...rest] = source.passes;
  return {
    ...source,
    passes: [
      first,
      ...rest.flatMap((pass) => (pass.name === 'shadow-caster' ? update(pass) : [pass])),
    ],
  };
}

it.each([
  [
    'unsupported-render-state',
    () =>
      shadowMaterial((pass) => [
        { ...pass, renderState: { ...pass.renderState, depthWriteEnabled: false } },
      ]),
  ],
  ['multi-pass', () => shadowMaterial((pass) => [pass, { ...pass, name: 'second-shadow' }])],
  [
    'transparent-shadow',
    () =>
      shadowMaterial((pass) => [
        {
          ...pass,
          renderState: {
            ...pass.renderState,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          },
        },
      ]),
  ],
] as const)('retains the actual %s direct Shadow lane after transfer', (_reason, material) => {
  const f = fixture(material());
  try {
    f.publish();
    const selected = f.admit();
    expect(selected.batchExecutions.size).toBe(1);
    expect(
      [...selected.batchExecutions.values()].every(({ shadow }) => shadow.route === 'direct'),
    ).toBe(true);
    expect([...selected.shadowMaterialArtifacts]).toEqual([]);
  } finally {
    f.close();
  }
});

it('adopts an edited shared asset without an entity update and uses the current Shadow receipt', () => {
  const f = fixture();
  try {
    f.publish();
    const before = [...f.admit().batchExecutions.values()][0]?.shadow;
    assert(before?.route === 'gpu');
    const source = f.scene.compositionSlots().at(0)?.snapshot;
    assert(source);
    f.assets.update(f.material, { values: { baseColor: [0.5, 0.25, 1, 1] } }).unwrap();
    const { received } = f.publish();
    expect(received.operations.filter((operation) => operation.kind === 'update')).toEqual([]);
    const next = f.admit((id, request) => {
      const selected = f.resolve(id, request);
      assert(selected?.receipt);
      return { ...selected, receipt: { ...selected.receipt, generation: 4 } };
    });
    const execution = [...next.batchExecutions.values()][0]?.shadow;
    assert(execution?.route === 'gpu');
    expect(execution.prepared.receiptGeneration).toBe(4);
    expect(execution.material.baseColor).toEqual(new Float32Array([0.5, 0.25, 1]));
    expect(execution.material).not.toBe(before.material);
    expect(before.material.baseColor).toEqual(new Float32Array([1, 1, 1]));
    expect(next.selection.has(f.actualSource(source), 0)).toBe(true);
  } finally {
    f.close();
  }
});

it('keeps active morph deformation on the direct lane and admits neutralized geometry', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    assert(mesh.attributes.position instanceof Float32Array);
    const handle = f.assets
      .create({
        ...mesh,
        morphTargets: [{ position: new Float32Array(mesh.attributes.position.length).fill(0.1) }],
      })
      .unwrap();
    f.world.set(f.entity, MeshFilter, { assetHandle: handle }).unwrap();
    f.world
      .addComponent(f.entity, { component: MorphWeights, data: { weights: new Float32Array([1]) } })
      .unwrap();
    f.publish();
    expect(f.scene.compositionSlots().at(0)?.snapshot.morph).toBeDefined();
    expect(f.admit().batches.length).toBe(0);
    f.world.set(f.entity, MorphWeights, { weights: new Float32Array([0]) }).unwrap();
    f.publish();
    const neutral = f.scene.compositionSlots().at(0)?.snapshot;
    assert(neutral);
    expect(neutral.morph).toBeUndefined();
    expect(f.admit().selection.has(f.actualSource(neutral), 0)).toBe(true);
  } finally {
    f.close();
  }
});

it.each([
  true,
  false,
])('rebuilds receiver execution from current receipts (GPU Shadow: %s)', (gpu) => {
  const f = fixture(
    shadowMaterial((pass) => [
      {
        ...pass,
        renderState: {
          ...pass.renderState,
          ...(gpu ? { cullMode: 'back' as const } : { depthWriteEnabled: false }),
        },
      },
    ]),
  );
  const rebuilt = new PersistentRenderScene({ assets: f.assets });
  const receiver = new RenderPublicationReceiver(f.publisher.identity);
  try {
    const { packet } = f.publish();
    const received = receiver.accept(packet).unwrap();
    rebuilt.consumePublication(
      preparePublicationGeometry(received, f.assets, new InstanceProjectionStore()),
    );
    const selected = f.admit((id, request) => {
      const current = f.resolve(id, request);
      assert(current?.receipt);
      return { ...current, receipt: { ...current.receipt, generation: 4 } };
    }, rebuilt);
    const execution = [...selected.batchExecutions.values()][0]?.shadow;
    expect(execution?.route).toBe(gpu ? 'gpu' : 'direct');
    if (execution?.route === 'gpu') expect(execution.prepared.receiptGeneration).toBe(4);
  } finally {
    receiver.dispose();
    rebuilt.dispose();
    f.close();
  }
});

it('preserves source submesh identity through direct-lane filtering, motion and removal', () => {
  const f = fixture();
  try {
    const mesh = createBoxGeometry(1, 1, 1).unwrap();
    const submesh = mesh.submeshes[0];
    assert(submesh);
    const handle = f.assets
      .create({
        ...mesh,
        materialSlots: [{ slotName: 'direct' }, { slotName: 'gpu' }],
        submeshes: [
          { ...submesh, indexOffset: 0, indexCount: 18, materialSlot: 0 },
          { ...submesh, indexOffset: 18, indexCount: 18, materialSlot: 1 },
        ],
      })
      .unwrap();
    const direct = f.assets
      .create(
        shadowMaterial((pass) => [
          { ...pass, renderState: { ...pass.renderState, depthWriteEnabled: false } },
        ]),
      )
      .unwrap();
    f.world.set(f.entity, MeshFilter, { assetHandle: handle }).unwrap();
    f.world.set(f.entity, MeshRenderer, { materials: [direct, f.material] }).unwrap();
    for (const x of [0, 2]) {
      f.world.set(f.entity, Transform, { pos: [x, 0, 0] }).unwrap();
      f.publish();
      const source = f.scene.compositionSlots().at(0)?.snapshot;
      assert(source);
      const selected = f.admit();
      expect(
        selected.batches.map((batch) => [
          batch.binding?.drawItemIndex,
          batch.binding === undefined
            ? undefined
            : selected.batchExecutions.get(batch.binding)?.shadow.route,
        ]),
      ).toEqual([
        [0, 'direct'],
        [1, 'gpu'],
      ]);
      expect(selected.selection.has(f.actualSource(source), 0)).toBe(false);
      expect(selected.selection.has(f.actualSource(source), 1)).toBe(true);
    }
    f.world.despawn(f.entity).unwrap();
    f.publish();
    expect(f.scene.compositionSlots()).toHaveLength(0);
    expect(f.admit().batchExecutions.size).toBe(0);
  } finally {
    f.close();
  }
});

it('validates the selected Shadow ABI and propagates producer failures', () => {
  const f = fixture();
  try {
    f.publish();
    const selected = f.admit();
    const batch = selected.batches.at(0);
    assert(batch?.binding);
    const execution = selected.batchExecutions.get(batch.binding)?.shadow;
    assert(execution?.route === 'gpu');
    const { geometry } = batch.binding;
    const receipt = f.shadow.receipt;
    assert(receipt);
    const prepare = (resolve: BatchArtifactResolver) =>
      prepareBatchExecution(geometry, execution.material, execution.pass, resolve);
    expect(prepare(() => undefined).unwrap().route).toBe('direct');
    expect(
      prepare(
        () => ({ ...f.shadow, receipt: undefined }) as unknown as MaterialShaderArtifact,
      ).unwrap().route,
    ).toBe('direct');
    expect(
      prepare(
        () =>
          ({
            ...f.shadow,
            receipt: { ...receipt, sceneIndexEntry: undefined },
          }) as unknown as MaterialShaderArtifact,
      ).unwrap().route,
    ).toBe('direct');
    expect(prepare(() => ({ ...f.shadow, layoutIdentity: 'wrong-layout' }))).toMatchObject({
      ok: false,
      error: { code: 'reflection-mismatch' },
    });
    expect(
      prepare(() => ({
        ...f.shadow,
        receipt: {
          ...receipt,
          vertexInputs: [{ semantic: 'unavailable', location: 15, format: 'float32x4' }],
        },
      })),
    ).toMatchObject({ ok: false, error: { code: 'vertex-input-mismatch' } });
    expect(
      prepare(() => ({
        ...f.shadow,
        receipt: {
          ...receipt,
          alphaMask: { ...receipt.alphaMask, cutoff: '', source: 'baseColorTexture' },
        },
      })),
    ).toMatchObject({ ok: false, error: { code: 'alpha-mask-mismatch' } });
    const error = new Error('registry admission failed');
    expect(() =>
      prepare(() => {
        throw error;
      }),
    ).toThrow(error);
    const paired = { ...execution.pass, sceneIndexProgramKey: 'shadow-scene' };
    expect(
      prepareBatchExecution(geometry, execution.material, paired, () => undefined),
    ).toMatchObject({ ok: false, error: { code: 'missing-material-receipt' } });
    const requests: string[] = [];
    const specialized = prepareBatchExecution(geometry, execution.material, paired, (id) => {
      requests.push(id);
      return artifact(id, 'shadow');
    }).unwrap();
    expect(requests).toEqual(['shadow-scene']);
    assert(specialized.route === 'gpu');
    expect(specialized.artifact).toMatchObject({
      material: execution.pass.shaderId,
      specializationKey: 'shadow-scene',
    });
  } finally {
    f.close();
  }
});

it('rejects stale prepared publications before geometry or persistent scene mutation', () => {
  const f = fixture();
  try {
    const old = f.publish().received;
    f.assets.update(f.material, { values: { roughness: 0.25 } }).unwrap();
    f.publish();
    const current = f.scene.compositionRetainedScene();
    const projection = f.scene.shadowCasterProjection();
    assert(current && projection);
    const work = [...projection.dispatch];
    const instances = new InstanceProjectionStore();
    const release = vi.spyOn(instances, 'release');
    expect(() => preparePublicationGeometry(old, f.assets, instances)).toThrow(
      /stale prepared geometry input/,
    );
    expect(release).not.toHaveBeenCalled();
    expect(() => f.scene.consumePublication(old)).toThrow(/stale prepared scene input/);
    expect(f.scene.compositionRetainedScene()?.identity).toBe(current.identity);
    expect(f.scene.shadowCasterProjection()).toBe(projection);
    expect([...projection.dispatch]).toEqual(work);
  } finally {
    f.close();
  }
});
