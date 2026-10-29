import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { Transform } from '@forgeax/engine-scene';
import {
  createStandardPbrArtifactReceipt,
  ShaderRegistry,
  STANDARD_PIPELINE_PARAM_SCHEMA,
} from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { resolveMaterialShaderArtifact } from '../assembly/material/assembly';
import { Lines, MeshFilter, MeshRenderer, Points } from '../components';
import { BatchTopology } from '../gpu-driven/batch-topology';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import { InstanceProjectionStore } from '../instances';
import { Materials } from '../materials';
import { preparePublicationGeometry } from '../publication/prepare-geometry';
import { createRenderPublisher } from '../publication/publisher';
import { RenderPublicationReceiver } from '../publication/receiver';
import { encodeRenderPublication, renderPublicationTransfers } from '../publication/record';
import { PersistentRenderScene } from '../scene/render-scene';

it('retains receiver-owned inputs through native publication, scene ownership and material collection', () => {
  const source = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const shaderId = 'game::owned-inputs';
  source.shaderRegistry.installMaterialArtifact(shaderId, {
    source: '',
    paramSchema: STANDARD_PIPELINE_PARAM_SCHEMA,
    receipt: createStandardPbrArtifactReceipt(),
  });
  const world = new World({ assets: source });
  const mesh = source.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
  const material = source
    .create({
      ...Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] }),
      passes: [
        {
          name: 'forward',
          program: { module: shaderId },
          renderState: { tags: { LightMode: 'Forward' } },
        },
        {
          name: 'shadow-caster',
          program: { module: shaderId },
          renderState: { tags: { LightMode: 'ShadowCaster' } },
        },
      ],
    })
    .unwrap();
  for (let entity = 0; entity < 8; entity++) {
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: { materials: [material] } },
      )
      .unwrap();
  }
  const identity = { source: 'owned-vertex-inputs', epoch: 1 };
  const publisher = createRenderPublisher(world, source, identity);
  const receiver = new RenderPublicationReceiver(identity);
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const scene = new PersistentRenderScene({ assets });
  try {
    const candidate = publisher.prepare(0).unwrap();
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    candidate.accept();
    const wireReceipt = packet.programs.find((row) => row.key === shaderId)?.shader.receipt;
    expect(wireReceipt).toBeDefined();
    expect(Object.isFrozen(wireReceipt?.vertexInputs)).toBe(false);
    const received = receiver.accept(encodeRenderPublication(packet), assets).unwrap();
    const receipt = assets.shaderRegistry.findMaterialArtifact(shaderId).unwrap().receipt;
    if (receipt === undefined) throw new Error('Missing receiver-owned receipt');
    expect(Object.isFrozen(receipt.vertexInputs)).toBe(true);
    expect(receipt.vertexInputs.every(Object.isFrozen)).toBe(true);
    const resolve: NonNullable<
      Parameters<typeof collectGpuDrivenMaterialArtifacts>[0]['resolve']
    > = (id, options) =>
      resolveMaterialShaderArtifact(
        id,
        assets.shaderRegistry,
        typeof options === 'boolean' ? { vertexColorAvailable: options } : options,
      );
    const prepared = preparePublicationGeometry(
      received,
      assets,
      new InstanceProjectionStore(),
      resolve,
    );
    expect(prepared.frame.renderables).toHaveLength(8);
    for (const snapshot of prepared.frame.renderables) {
      expect(snapshot.gpuDrivenDraws?.[0]?.prepared?.vertexInputs).toBe(receipt.vertexInputs);
    }
    let frame = scene.consumePublication(prepared);
    const collect = () => {
      const topology = new BatchTopology();
      topology.rebuild(scene.compositionSlots());
      const programs = scene.shadowCasterProjection()?.materialPrograms;
      if (programs === undefined) throw Error('missing accepted material programs');
      return collectGpuDrivenMaterialArtifacts({
        batches: topology.query(topology.sourcePlan(), undefined).batches,
        programs,
        resolve,
        clustered: false,
        reflectionFallback: false,
        probeBlend: false,
        shadowViews: true,
      });
    };
    const initial = collect();
    const tables = new Set<unknown>(
      [...initial.batchExecutions.values()].flatMap((execution) =>
        [execution.forward, execution.shadow].flatMap((pass) =>
          pass.route === 'gpu' ? [pass.prepared.vertexInputs] : [],
        ),
      ),
    );
    expect(
      frame.renderables.every((snapshot) =>
        snapshot.gpuDrivenDraws?.every((draw) => draw.prepared === undefined),
      ),
    ).toBe(true);
    const scans = vi.spyOn(Array.prototype, 'some');
    let inputScans: number;
    try {
      const result = collect();
      inputScans = scans.mock.contexts.filter((receiver) => tables.has(receiver)).length;
      expect(result.materialArtifacts.size).toBe(1);
      expect(result.shadowMaterialArtifacts.size).toBe(1);
    } finally {
      scans.mockRestore();
    }
    // Receiver-owned inputs retain their color fact without rescanning either pass.
    expect.soft(inputScans).toBe(0);
    expect(tables.size).toBe(1);
    expect(tables.has(receipt.vertexInputs)).toBe(true);
    const initialPrograms = scene.shadowCasterProjection()?.materialPrograms;
    expect(initialPrograms).toBeDefined();
    const initialOverlays = initialPrograms?.overlays;
    expect(initialOverlays).toBeDefined();
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    const publishNext = () => {
      world.update(0).unwrap();
      const next = publisher.prepare(0).unwrap();
      const wire = structuredClone(next.packet, {
        transfer: renderPublicationTransfers(next.message),
      });
      next.accept();
      frame = scene.consumePublication(
        preparePublicationGeometry(
          receiver.accept(encodeRenderPublication(wire), assets).unwrap(),
          assets,
          new InstanceProjectionStore(),
          resolve,
        ),
      );
      publisher
        .recycle(wire.revision, renderPublicationTransfers(encodeRenderPublication(wire)))
        .unwrap();
    };
    publishNext();
    expect(scene.shadowCasterProjection()?.materialPrograms).toBe(initialPrograms);
    expect(scene.shadowCasterProjection()?.materialPrograms?.overlays).toBe(initialOverlays);
    expect(collect().materialArtifacts.size).toBe(1);
    const first = world
      .query({ read: [MeshRenderer] })
      .unwrap()
      [Symbol.iterator]()
      .next().value;
    if (first === undefined) throw new Error('Missing source renderable');
    world.despawn(first.entity).unwrap();
    publishNext();
    expect(scene.shadowCasterProjection()?.materialPrograms).not.toBe(initialPrograms);
    expect(scene.shadowCasterProjection()?.materialPrograms?.overlays).not.toBe(initialOverlays);
    expect(collect().materialArtifacts.size).toBe(1);
  } finally {
    receiver.dispose();
    publisher.dispose();
    scene.dispose();
  }
});

for (const component of [Points, Lines]) {
  it(`keeps ${component.name} with its native owner after publication geometry preparation`, () => {
    const assets = new AssetRegistry({
      shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
    });
    const world = new World({ assets });
    const mesh = assets.create(createBoxGeometry(1, 1, 1).unwrap()).unwrap();
    world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: mesh } },
        { component: MeshRenderer, data: {} },
        { component, data: {} },
      )
      .unwrap();
    const identity = { source: 'points-lines-owner', epoch: 1 };
    const publisher = createRenderPublisher(world, assets, identity);
    const receiver = new RenderPublicationReceiver(identity);
    try {
      const candidate = publisher.prepare(0).unwrap();
      const message = structuredClone(candidate.message, {
        transfer: renderPublicationTransfers(candidate.message),
      });
      candidate.accept();
      const accepted = receiver.accept(message, assets).unwrap();
      const prepared = preparePublicationGeometry(accepted, assets, new InstanceProjectionStore());
      expect(prepared.frame.renderables).toHaveLength(1);
      expect(prepared.frame.renderables.at(0)?.pointsLines).toBeDefined();
      expect(prepared.frame.renderables.at(0)?.gpuDrivenDraws ?? []).toEqual([]);
    } finally {
      receiver.dispose();
      publisher.dispose();
    }
  });
}
