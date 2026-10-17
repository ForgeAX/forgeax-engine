import { Time, World } from '@forgeax/engine-ecs';
import { createBoxGeometry } from '@forgeax/engine-geometry';
import { rhi } from '@forgeax/engine-rhi-null';
import { registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { createStandardPbrArtifactReceipt } from '@forgeax/engine-shader';
import { expect, it, vi } from 'vitest';
import { createRenderer } from '../assembly/factory';
import { Camera, DirectionalLight, MeshFilter, MeshRenderer } from '../components';
import type { GeometryCommandCapture } from '../geometry-observation';
import { GpuDrivenView } from '../gpu-driven/view-gpu';
import { Materials } from '../materials';
import { renderPublicationTransfers } from '../publication/contract';
import { createRenderPublisher } from '../publication/publisher';
import { renderLifecycleManifestUrl } from './shader-manifest-fixture';

it('keeps the published command source World distinct from its transport namespace', async () => {
  const sourceManifest = renderLifecycleManifestUrl();
  const body = JSON.parse(
    decodeURIComponent(sourceManifest.slice(sourceManifest.indexOf(',') + 1)),
  );
  for (const entry of body.materialShaders) {
    if (entry.identifier !== 'forgeax::default-standard-pbr') continue;
    entry.receipt = createStandardPbrArtifactReceipt();
    for (const variant of entry.variants)
      variant.receipt = createStandardPbrArtifactReceipt(
        false,
        variant.defines.VERTEX_COLOR_AVAILABLE === true,
      );
  }
  const manifest = `data:application/json,${encodeURIComponent(JSON.stringify(body))}`;
  const identity = { source: 'transport-uuid-not-the-world', epoch: 3 };
  const renderer = await createRenderer(
    { width: 32, height: 32, getContext: () => null },
    { publicationSource: identity },
    { shaderManifestUrl: manifest },
    { rhi, createShaderModule: rhi.createShaderModule },
  );
  expect((await renderer.initialization).ok).toBe(true);
  const world = new World();
  const assets = renderer.assetRegistry;
  const publisher = createRenderPublisher(world, assets, identity);
  registerPropagateTransforms(world);
  world
    .spawn(
      { component: Transform, data: { pos: [0, 0, 4] } },
      { component: Camera, data: { fov: 1, aspect: 1, near: 0.1, far: 30, antialias: 0 } },
    )
    .unwrap();
  world
    .spawn({ component: DirectionalLight, data: { direction: [0, -1, -1], intensity: 1 } })
    .unwrap();
  const handle = world.allocSharedRef('MeshAsset', createBoxGeometry(1, 1, 1).unwrap());
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: handle } },
      {
        component: MeshRenderer,
        data: {
          materials: [
            world.allocSharedRef('MaterialAsset', Materials.standard({ baseColor: [1, 1, 1, 1] })),
          ],
        },
      },
    )
    .unwrap();
  const commands: GeometryCommandCapture[] = [];
  // Null does not execute selector shaders. Isolate only the hardware readback;
  // publication, receiver, Renderer and actual command/source recording remain real.
  const read = vi
    .spyOn(GpuDrivenView.prototype, 'readGeometryCommands')
    .mockImplementation(async (rows) => {
      commands.push(...rows);
      return {
        commands: [],
        viewConstants: {
          scope: 'submitted-gpu-cull-view-constants' as const,
          depthPyramid: 'unobserved' as const,
          frustumPlanes: Array(24).fill(0),
          occlusionEnabled: false,
          occlusionHistoryValid: false,
        },
      };
    });
  try {
    const submit = async (observe: boolean, includeIdentity = true) => {
      world.update().unwrap();
      const candidate = publisher.prepare(world.getResource(Time).elapsed).unwrap();
      const packet = structuredClone(candidate.packet, {
        transfer: renderPublicationTransfers(candidate.packet),
      });
      candidate.accept();
      const drawn = renderer.draw({
        publication: packet,
        ...(observe ? { geometryObservation: true as const } : {}),
        ...(includeIdentity ? { geometryObservationSourceWorldIdentity: world.identity } : {}),
      });
      if (!drawn.ok) throw drawn.error;
      const receipt = drawn.value;
      if (receipt === undefined) throw Error('Expected published receipt');
      const completed = await receipt.completed;
      if (!completed.ok) throw completed.error;
      publisher.acknowledgeFeatures(packet.revision, []).unwrap();
      publisher.recycle(packet.revision, renderPublicationTransfers(packet)).unwrap();
      return { receipt, revision: packet.revision };
    };
    await submit(false);
    const captured = await submit(true);
    const observed = await renderer.observeGeometry?.(captured.receipt);
    expect(observed?.status, JSON.stringify(observed)).toBe('complete');
    expect(() => structuredClone(observed)).not.toThrow();
    expect(observed).not.toHaveProperty('completed');
    expect(commands.length).toBeGreaterThan(0);
    const sources = commands.flatMap((command) => [...command.sources.values()]);
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources)
      expect(source).toMatchObject({
        worldIdentity: world.identity,
        entityKey: Number(entity),
        meshHandle: Number(handle),
        sourceRevision: captured.revision,
      });
    expect(world.identity).not.toBe(identity.source);
    const missing = await submit(true, false);
    expect(await renderer.observeGeometry?.(missing.receipt)).toMatchObject({
      status: 'unavailable',
      reason: 'geometry-source-unavailable',
      commands: [],
    });
  } finally {
    read.mockRestore();
    publisher.dispose();
    await renderer.dispose();
  }
});
