import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { MorphWeights, Transform } from '@forgeax/engine-scene';
import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
  ShaderRegistry,
} from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { MeshFilter, MeshRenderer } from '../../components';
import { ShadowClaimTable } from '../../gpu-driven/shadow-claims';
import { ShadowCasterOwnershipProjection } from '../../gpu-driven/shadow-ownership';
import { InstanceProjectionStore } from '../../instances';
import { Materials, standard } from '../../materials';
import type {
  DispatchEntry,
  MaterialSnapshot,
  RenderableSnapshot,
} from '../../render-system-extract';
import { PersistentRenderScene } from '../../scene/render-scene';
import { renderPublicationTransfers } from '../contract';
import { preparePublicationGeometry } from '../prepare-geometry';
import { preparePublishedShadowPasses } from '../prepare-shadow';
import { createRenderPublisher } from '../publisher';
import { RenderPublicationReceiver } from '../receiver';

function fixture(materialAsset = Materials.standard({ baseColor: [1, 1, 1, 1] })) {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'shadow-admission', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  const instances = new InstanceProjectionStore();
  const material = world.allocSharedRef('MaterialAsset', materialAsset);
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const receipt = createStandardPbrArtifactReceipt(false, false);
  const artifact: MaterialShaderArtifact = {
    material: 'forgeax::default-standard-pbr',
    pass: 'forward',
    program: createMaterialShaderProgram('shadow-admission-forward-fixture'),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: ['forgeax_material::standard'],
    vertexInputs: receipt.vertexInputs.map((input) => ({ ...input })),
    receipt,
  };
  const shadowArtifact: MaterialShaderArtifact = {
    ...artifact,
    material: 'forgeax::default-shadow-caster',
    pass: 'shadow',
    program: createMaterialShaderProgram('shadow-admission-shadow-fixture'),
  };
  const requests: { material: string; pass: string }[] = [];
  const resolveArtifact: NonNullable<Parameters<typeof preparePublicationGeometry>[5]> = (
    material,
    request,
  ) => {
    const pass = typeof request === 'object' ? (request.pass ?? 'forward') : 'forward';
    requests.push({ material, pass });
    const selected = pass === 'shadow' ? shadowArtifact : artifact;
    return selected.material === material ? selected : undefined;
  };
  const publish = (resolve: Parameters<typeof preparePublicationGeometry>[5] = resolveArtifact) => {
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.packet),
    });
    candidate.accept();
    const replay = structuredClone(packet);
    const received = receiver.accept(packet).unwrap();
    const prepared = preparePublicationGeometry(
      received,
      scene,
      undefined,
      assets,
      instances,
      resolve,
    );
    const frame = scene.consumePublication(prepared);
    publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
    return { received, prepared, frame, packet: replay };
  };
  return {
    world,
    assets,
    publisher,
    receiver,
    scene,
    entity,
    material,
    artifact,
    resolveArtifact,
    requests,
    publish,
  };
}

it('replaces source-only unprepared shadow state with receiver-owned GPU admission', () => {
  const f = fixture();
  try {
    const { received, frame } = f.publish();
    expect(received.frame.renderables[0]?.shadowCasterPasses?.[0]?.cpuReason).toBe('unprepared');
    const snapshot = frame.renderables[0];
    expect(snapshot?.gpuDrivenDraws?.[0]?.prepared).toBeDefined();
    expect(snapshot?.shadowCasterPasses?.[0]?.cpuReason).toBeUndefined();
    const ownership = new ShadowCasterOwnershipProjection().project(
      frame.renderables,
      frame.dispatch,
    );
    expect(ownership.membership[0]?.gpuDrivenEligible).toBe(true);
    expect(f.requests).toEqual([
      { material: 'forgeax::default-standard-pbr', pass: 'forward' },
      { material: 'forgeax::default-shadow-caster', pass: 'shadow' },
    ]);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

it('keeps a transferred caster on CPU when its independent Shadow program is absent', () => {
  const f = fixture();
  try {
    const { frame } = f.publish((material, request) =>
      typeof request === 'object' && request.pass === 'shadow'
        ? undefined
        : f.resolveArtifact(material, request),
    );
    const snapshot = frame.renderables[0];
    expect(snapshot?.gpuDrivenDraws?.[0]?.prepared).toBeDefined();
    expect(snapshot?.shadowCasterPasses?.[0]).toMatchObject({
      cpuReason: 'unprepared',
      gpuDrivenEligible: false,
    });
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

function shadowMaterial(update: (shadow: MaterialPass) => readonly MaterialPass[]): MaterialAsset {
  const source = Materials.standard({ baseColor: [1, 1, 1, 1] });
  if (source.parent !== undefined || source.passes === undefined)
    throw new Error('Expected root material');
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
    'transparent',
    () =>
      Materials.standard({
        baseColor: [1, 1, 1, 0.5],
        renderState: {
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        },
      }),
  ],
] as const)('retains the actual %s CPU shadow lane after transfer', (reason, material) => {
  const f = fixture(material());
  try {
    const { frame } = f.publish();
    const ownership = new ShadowCasterOwnershipProjection().project(
      frame.renderables,
      frame.dispatch,
    );
    expect(ownership.membership.length).toBeGreaterThan(0);
    expect(
      ownership.membership.every(
        (pass) => pass.cpuReason === reason && pass.gpuDrivenEligible === false,
      ),
    ).toBe(true);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

it('re-evaluates material edits against the current receiver receipt', () => {
  const f = fixture();
  const replace = (red: number) =>
    f.world
      .set(f.entity, MeshRenderer, {
        materials: [
          f.world.allocSharedRef(
            'MaterialAsset',
            Materials.standard({ baseColor: [red, 0.5, 1, 1] }),
          ),
        ],
      })
      .unwrap();
  try {
    expect(f.publish().frame.renderables[0]?.shadowCasterPasses?.[0]?.gpuDrivenEligible).toBe(true);
    replace(0.5);
    const unavailable = f.publish(() => undefined).frame.renderables[0];
    expect(unavailable?.gpuDrivenDraws?.[0]?.preparationError?.code).toBe(
      'missing-material-receipt',
    );
    expect(unavailable?.shadowCasterPasses?.[0]?.cpuReason).toBe('unprepared');
    replace(0.25);
    const mismatched = f.publish(() => ({ ...f.artifact, material: 'other-material' })).frame
      .renderables[0];
    expect(mismatched?.gpuDrivenDraws?.[0]?.prepared).toBeDefined();
    expect(mismatched?.shadowCasterPasses?.[0]?.cpuReason).toBe('prepared-contract');
    replace(1);
    expect(f.publish().frame.renderables[0]?.shadowCasterPasses?.[0]?.gpuDrivenEligible).toBe(true);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

it('keeps active morph deformation on CPU and admits it after neutralization', () => {
  const f = fixture();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  if (!(mesh.attributes.position instanceof Float32Array))
    throw new Error('Expected float positions');
  const handle = f.world.allocSharedRef('MeshAsset', {
    ...mesh,
    morphTargets: [{ position: new Float32Array(mesh.attributes.position.length).fill(0.1) }],
  });
  f.world.set(f.entity, MeshFilter, { assetHandle: handle }).unwrap();
  f.world
    .addComponent(f.entity, { component: MorphWeights, data: { weights: new Float32Array([1]) } })
    .unwrap();
  try {
    const active = f.publish().frame.renderables[0];
    expect(active?.morph).toBeDefined();
    expect(active?.gpuDrivenDraws).toEqual([]);
    expect(active?.shadowCasterPasses?.[0]?.cpuReason).toBe('morph');
    f.world.set(f.entity, MorphWeights, { weights: new Float32Array([0]) }).unwrap();
    const neutral = f.publish().frame.renderables[0];
    expect(neutral?.morph).toBeUndefined();
    expect(neutral?.gpuDrivenDraws?.[0]?.prepared).toBeDefined();
    expect(neutral?.shadowCasterPasses?.[0]?.gpuDrivenEligible).toBe(true);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

it.each([
  { state: { cullMode: 'none' }, reason: undefined },
  { state: { depthWriteEnabled: false }, reason: 'unsupported-render-state' },
] as const)('rebuilds receiver admission while retaining CPU reason $reason', ({
  state,
  reason,
}) => {
  const f = fixture(
    shadowMaterial((pass) => [{ ...pass, renderState: { ...pass.renderState, ...state } }]),
  );
  const rebuilt = new PersistentRenderScene();
  try {
    const { packet } = f.publish();
    const receiver = new RenderPublicationReceiver(f.publisher.identity);
    const received = receiver.accept(packet).unwrap();
    const prepared = preparePublicationGeometry(
      received,
      rebuilt,
      undefined,
      f.assets,
      new InstanceProjectionStore(),
      (material, request) => {
        const selected = f.resolveArtifact(material, request);
        if (selected?.receipt === undefined) throw new Error('Expected selected material receipt');
        return { ...selected, receipt: { ...selected.receipt, generation: 4 } };
      },
    );
    const frame = rebuilt.consumePublication(prepared);
    expect(frame.renderables[0]?.gpuDrivenDraws?.[0]?.prepared?.receiptGeneration).toBe(4);
    expect(frame.renderables[0]?.shadowCasterPasses?.[0]).toMatchObject({
      gpuDrivenEligible: reason === undefined,
      renderState: state,
    });
    expect(frame.renderables[0]?.shadowCasterPasses?.[0]?.cpuReason).toBe(reason);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
    rebuilt.dispose();
  }
});

it('preserves source submesh indices through transparent compaction, motion and removal', () => {
  const f = fixture();
  const mesh = createBoxGeometry(1, 1, 1).unwrap();
  const submesh = mesh.submeshes[0];
  if (submesh === undefined) throw new Error('Expected cube submesh');
  const handle = f.world.allocSharedRef('MeshAsset', {
    ...mesh,
    materialSlots: [{ slotName: 'transparent' }, { slotName: 'opaque' }],
    submeshes: [
      { ...submesh, indexOffset: 0, indexCount: 18, materialSlot: 0 },
      { ...submesh, indexOffset: 18, indexCount: 18, materialSlot: 1 },
    ],
  });
  const transparent = f.world.allocSharedRef(
    'MaterialAsset',
    Materials.standard({
      baseColor: [1, 1, 1, 0.5],
      renderState: {
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      },
    }),
  );
  f.world.set(f.entity, MeshFilter, { assetHandle: handle }).unwrap();
  f.world.set(f.entity, MeshRenderer, { materials: [transparent, f.material] }).unwrap();
  try {
    for (const x of [0, 2]) {
      f.world.set(f.entity, Transform, { pos: [x, 0, 0] }).unwrap();
      const frame = f.publish().frame;
      expect(frame.renderables[0]?.gpuDrivenDraws?.map((draw) => draw.drawItemIndex)).toEqual([1]);
      expect(
        frame.renderables[0]?.shadowCasterPasses?.map((pass) => [
          pass.drawItemIndex,
          pass.cpuReason,
          pass.gpuDrivenEligible,
        ]),
      ).toEqual([
        [0, 'transparent', false],
        [1, undefined, true],
      ]);
    }
    f.world.despawn(f.entity).unwrap();
    const removed = f.publish().frame;
    expect(removed.renderables).toHaveLength(0);
    expect(
      new ShadowCasterOwnershipProjection().project(removed.renderables, removed.dispatch)
        .membership,
    ).toHaveLength(0);
  } finally {
    f.publisher.dispose();
    f.scene.dispose();
  }
});

it('re-admits a published rigid shadow caster after Renderer-owned shader preparation', () => {
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const identity = { source: 'late-shadow', epoch: 1 };
  const publisher = createRenderPublisher(world, assets, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const scene = new PersistentRenderScene();
  const instances = new InstanceProjectionStore();
  try {
    const material = world.allocSharedRef(
      'MaterialAsset',
      standard({ baseColor: [0.5, 0.5, 0.5, 1], metallic: 0, roughness: 1 }),
    );
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
    world.update(0).unwrap();
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet);
    candidate.accept();
    const received = receiver.accept(packet).unwrap();
    expect(received.frame.renderables).toHaveLength(1);
    expect(received.frame.renderables[0]?.shadowCasterPasses?.[0]?.cpuReason).toBe('unprepared');
    const receipt = createStandardPbrArtifactReceipt();
    const requests: string[] = [];
    const prepared = preparePublicationGeometry(
      received,
      scene,
      undefined,
      assets,
      instances,
      (material, request) => {
        requests.push(typeof request === 'object' ? (request.pass ?? 'missing') : 'missing');
        return {
          material,
          pass: 'Forward',
          program: createMaterialShaderProgram(''),
          layoutIdentity: receipt.reflection.layoutIdentity,
          bindings: [],
          deps: [],
          vertexInputs: [],
          receipt,
        };
      },
    );
    expect(prepared.frame.renderables[0]?.gpuDrivenDraws?.[0]?.preparationError).toBeUndefined();
    expect(prepared.frame.renderables[0]?.gpuDrivenDraws?.[0]?.prepared).toBeDefined();
    const ownership = new ShadowCasterOwnershipProjection().project(
      prepared.frame.renderables,
      prepared.frame.dispatch,
    );
    expect(ownership.membership).toHaveLength(1);
    expect(ownership.membership[0]?.cpuReason).toBeUndefined();
    expect(ownership.membership[0]?.gpuDrivenEligible).toBe(true);
    expect(requests).toEqual(['forward', 'shadow']);
    const accepted = prepared.frame.renderables[0];
    if (accepted === undefined) throw new Error('missing actual published row');
    const claims = new ShadowClaimTable(ownership.drawKeys, ownership.membership);
    expect(
      claims.claim({ snapshot: accepted } as never, { drawItemIndex: 0 } as never).compatible,
    ).toBe(true);
    assertAdmissionBoundaries(accepted, prepared.frame.dispatch);
  } finally {
    publisher.dispose();
    receiver.dispose();
  }
});

function assertAdmissionBoundaries(
  accepted: RenderableSnapshot,
  dispatch: readonly DispatchEntry[],
) {
  const pass = accepted.shadowCasterPasses?.[0];
  const draw = accepted.gpuDrivenDraws?.[0];
  if (pass === undefined || draw?.prepared === undefined)
    throw new Error('missing prepared caster');
  const sourcePass = { ...pass, cpuReason: 'unprepared' as const };
  delete (sourcePass as { gpuDrivenEligible?: boolean }).gpuDrivenEligible;
  const source: RenderableSnapshot = { ...accepted, shadowCasterPasses: [sourcePass] };
  const entries = dispatch.filter((entry) => entry.tags.LightMode === 'ShadowCaster');
  const byMaterial = new Map([[pass.materialHandle, entries]]);
  const receipt = createStandardPbrArtifactReceipt();
  const artifact = (material: string): MaterialShaderArtifact => ({
    material,
    pass: 'ShadowCaster',
    program: createMaterialShaderProgram(''),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: [],
    receipt,
  });
  const prepare = (
    row = source,
    resolve: (id: string) => MaterialShaderArtifact | undefined = artifact,
  ) => preparePublishedShadowPasses(row, byMaterial, resolve);
  expect(prepare()?.[0]?.cpuReason).toBeUndefined();
  const noShadow = prepare(source, () => undefined);
  expect(noShadow?.[0]).toBe(sourcePass);
  expect(
    prepare(source, (id) => {
      const { receipt: _receipt, ...missing } = artifact(id);
      return missing;
    })?.[0],
  ).toBe(sourcePass);
  expect(
    prepare(source, (id) => ({
      ...artifact(id),
      receipt: (({ sceneIndexEntry: _entry, ...direct }) => direct)(receipt),
    }))?.[0],
  ).toBe(sourcePass);
  expect(prepare(source, (id) => ({ ...artifact(id), layoutIdentity: 'wrong-layout' }))?.[0]).toBe(
    sourcePass,
  );
  expect(
    prepare(source, (id) => ({ ...artifact(id), material: 'wrong-selected-program' }))?.[0],
  ).toBe(sourcePass);
  expect(
    prepare(source, (id) => ({
      ...artifact(id),
      receipt: {
        ...receipt,
        vertexInputs: [{ semantic: 'unavailable', location: 15, format: 'float32x4' }],
      },
    }))?.[0],
  ).toBe(sourcePass);
  const { prepared: _prepared, ...unprepared } = draw;
  expect(prepare({ ...source, gpuDrivenDraws: [unprepared, draw] })?.[0]).toBe(sourcePass);
  expect(
    prepare(source, (id) => ({
      ...artifact(id),
      receipt: { ...receipt, materialRow: { ...receipt.materialRow, fields: ['wrong'] } },
    }))?.[0],
  ).toBe(sourcePass);
  const explicitlyDisabled = { ...sourcePass, gpuDrivenEligible: false };
  expect(prepare({ ...source, shadowCasterPasses: [explicitlyDisabled] })?.[0]).toBe(
    explicitlyDisabled,
  );
  for (const cpuReason of [
    'transparent',
    'morph',
    'multi-pass',
    'missing-gpu-draw',
    'missing-skin-bounds',
    'prepared-contract',
    'unsupported-render-state',
  ] as const) {
    const rejected = { ...sourcePass, cpuReason };
    expect(prepare({ ...source, shadowCasterPasses: [rejected] })?.[0]).toBe(rejected);
  }
  expect(prepare({ ...source, skin: {} as never })).toBe(source.shadowCasterPasses);
  expect(prepare({ ...source, skinPose: {} as never })).toBe(source.shadowCasterPasses);
  expect(prepare({ ...source, shadowCasterPasses: [] })).toEqual([]);
  const error = new Error('registry admission failed');
  expect(() =>
    prepare(source, () => {
      throw error;
    }),
  ).toThrow(error);

  // Same logical material, but a modern Forward-only scene pair must not
  // cause the direct-only Shadow program to be interpreted as scene-index.
  const modernMaterial: MaterialSnapshot = {
    ...source.material,
    materialProgramKeys: { forward: source.material.materialShaderId as string },
    materialSceneIndexProgramKeys: {
      forward: { pass: 'forward' as const, specializationKey: 'forward-scene' },
    },
  };
  const modern = { ...source, material: modernMaterial, materials: [modernMaterial] };
  expect(prepare(modern)?.[0]).toBe(sourcePass);
  const pairedMaterial: MaterialSnapshot = {
    ...modernMaterial,
    materialProgramKeys: {
      ...modernMaterial.materialProgramKeys,
      shadow: sourcePass.materialShaderId as string,
    },
    materialSceneIndexProgramKeys: {
      ...modernMaterial.materialSceneIndexProgramKeys,
      shadow: { pass: 'shadow', specializationKey: 'shadow-scene' },
    },
  };
  const paired = { ...source, material: pairedMaterial, materials: [pairedMaterial] };
  const ids: string[] = [];
  expect(
    prepare(paired, (id) => {
      ids.push(id);
      return artifact(id);
    })?.[0]?.cpuReason,
  ).toBeUndefined();
  expect(ids).toEqual(['shadow-scene']);
  const changed = prepare(paired, (id) => {
    const { receipt: _receipt, ...missing } = artifact(id);
    return missing;
  });
  expect(changed?.[0]).toBe(sourcePass);

  // Compact draw ordinal zero belongs to source submesh two and material
  // slot one. Neither ordinal nor the fallback material selects its contract.
  const selectedMaterial = { ...source.material, materialHandle: sourcePass.materialHandle + 1 };
  const selectedPass = {
    ...sourcePass,
    drawItemIndex: 2,
    materialHandle: selectedMaterial.materialHandle,
  };
  const selectedEntries = entries.map((entry) => ({
    ...entry,
    materialHandle: selectedPass.materialHandle,
  }));
  const compact = {
    ...source,
    materials: [source.material, selectedMaterial],
    gpuDrivenDraws: [{ ...draw, drawItemIndex: 2, materialSlot: 1 }],
    shadowCasterPasses: [selectedPass],
  };
  const admitted = preparePublishedShadowPasses(
    compact,
    new Map([[selectedPass.materialHandle, selectedEntries]]),
    artifact,
  );
  expect(admitted?.[0]).toMatchObject({
    drawItemIndex: 2,
    materialHandle: selectedPass.materialHandle,
    gpuDrivenEligible: true,
  });
  expect(admitted?.[0]?.cpuReason).toBeUndefined();
  expect(preparePublishedShadowPasses(compact, byMaterial, artifact)?.[0]).toBe(selectedPass);
  const changedState = { ...sourcePass, renderState: { cullMode: 'front' as const } };
  expect(prepare({ ...source, shadowCasterPasses: [changedState] })?.[0]).toBe(changedState);
  const customVertex = { ...sourcePass, vertexEntry: 'custom_direct_vertex' };
  expect(
    preparePublishedShadowPasses(
      { ...source, shadowCasterPasses: [customVertex] },
      new Map([
        [
          customVertex.materialHandle,
          entries.map((entry) => ({ ...entry, vertexEntry: customVertex.vertexEntry })),
        ],
      ]),
      artifact,
    )?.[0],
  ).toBe(customVertex);
  expect(
    preparePublishedShadowPasses(
      compact,
      new Map([
        [
          selectedPass.materialHandle,
          [...selectedEntries, { ...selectedEntries[0], passIndex: 3 } as DispatchEntry],
        ],
      ]),
      artifact,
    )?.[0],
  ).toBe(selectedPass);
  const { materialShaderId: _shader, ...noShader } = sourcePass;
  expect(
    preparePublishedShadowPasses(
      { ...source, shadowCasterPasses: [noShader] },
      new Map([
        [
          noShader.materialHandle,
          entries.map((entry) => ({ ...entry, materialShaderId: undefined })),
        ],
      ]),
      artifact,
    )?.[0],
  ).toBe(noShader);
}
