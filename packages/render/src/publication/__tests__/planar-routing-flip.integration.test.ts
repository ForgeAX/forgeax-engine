import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { createPrimitiveMesh } from '@forgeax/engine-geometry';
import { createMaterialProgramSetDigest } from '@forgeax/engine-pack';
import { RhiNullAdapter } from '@forgeax/engine-rhi-null';
import { Transform } from '@forgeax/engine-scene';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { MaterialAsset, MaterialPass } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialRecordFixture } from '../../../../assets-runtime/src/__tests__/fixtures/material-publication';
import { publishRuntimeAssets } from '../../../../assets-runtime/src/__tests__/fixtures/runtime-publication';
import { Camera, MeshFilter, MeshRenderer } from '../../components';
import { CameraView } from '../../components/camera-view';
import { PlanarReflection } from '../../components/planar-reflection';
import { renderMaterialContext } from '../../extract/material-context';
import { createRenderTargetOwner } from '../../targets/owner';
import { createRenderPublisher } from '../publisher';
import { encodeRenderPublication, renderPublicationTransfers } from '../record';

const pass = (name: string, lightMode: string): MaterialPass => ({
  name,
  program: { module: `game::${name.toLowerCase()}` },
  renderState: { tags: { LightMode: lightMode } },
});

/** A cooked planar receiver (u32 `planarReflection`) with authored Forward + Deferred passes. */
async function fixture() {
  const assets = new AssetRegistry({
    shaderRegistry: new ShaderRegistry({ manifestUrl: undefined }),
  });
  const world = new World({ assets });
  const device = (await new RhiNullAdapter().requestDevice()).unwrap();
  const context = renderMaterialContext(device.caps).materialContext;
  if (context === undefined) throw new Error('Missing material context');
  const base = materialRecordFixture({
    passes: [pass('Forward', 'Forward'), pass('Deferred', 'Deferred')],
    parameters: [{ name: 'planarReflection', type: 'u32' }],
    values: { planarReflection: 1 },
    contexts: [context],
  });
  // The Deferred pass is cooked for the deferred pipeline context.
  const programs = base.programs.map((program) => ({
    ...program,
    selections: program.selections.map((selection) => {
      if (selection.pass !== 'Deferred') return selection;
      const context = selection.context;
      if (context.pass !== 'forward' && context.pass !== 'depth' && context.pass !== 'shadow')
        throw new Error('Deferred fixture requires a raster material context');
      return { ...selection, context: { ...context, pipeline: 'deferred' as const } };
    }),
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
      asset: {
        kind: 'material',
        passes: [first, ...rest],
        parameters: record.resolved.parameters,
        values: record.resolved.values,
        cooked: record,
      } as MaterialAsset,
    },
  ]);
  const material = (await assets.load(record.guid, 'material')).unwrap();
  const mesh = assets.create(createPrimitiveMesh('cube').unwrap()).unwrap();
  world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: [material] } },
    )
    .unwrap();
  const target = createRenderTargetOwner({ rendererId: Symbol(), getGeneration: () => 1 }).create({
    shape: '2d',
    width: 32,
    height: 32,
    format: 'rgba8unorm',
    sampleCount: 1,
    mipLevels: 1,
    sampled: true,
    readback: false,
  });
  if (!target.ok) throw target.error;
  const capture = () => ({
    component: PlanarReflection,
    data: { target: world.allocSharedRef('RenderTarget', target.value) },
  });
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 3, 5] } },
      { component: Camera, data: { fov: Math.PI / 3, aspect: 1, near: 0.1, far: 100 } },
      { component: CameraView, data: {} },
    )
    .unwrap();
  const publisher = createRenderPublisher(
    world,
    assets,
    { source: 'planar-routing-flip', epoch: 1 },
    device.caps,
  );
  /** Prepare and accept one packet; return the Deferred presence of each material it carries. */
  const publish = () => {
    const candidate = publisher.prepare(0).unwrap();
    const rows = candidate.packet.materials.map((row) => ({
      deferred: row.value.passes.some(
        (item) =>
          (item.renderState?.tags as { LightMode?: string } | undefined)?.LightMode === 'Deferred',
      ),
      deferredPass: row.value.deferredPass,
    }));
    candidate.accept();
    // Free the slot, as the receiving side does after decoding.
    const packet = structuredClone(candidate.packet, {
      transfer: renderPublicationTransfers(candidate.message),
    });
    publisher
      .recycle(packet.revision, renderPublicationTransfers(encodeRenderPublication(packet)))
      .unwrap();
    return rows;
  };
  return {
    publish,
    addCapture: () => world.addComponent(camera, capture()).unwrap(),
    removeCapture: () => world.removeComponent(camera, PlanarReflection).unwrap(),
    dispose: () => publisher.dispose(),
  };
}

describe('planar receiver republication', () => {
  it('republishes the receiver when a PlanarReflection capture is removed or added at runtime', async () => {
    const f = await fixture();
    try {
      f.addCapture();
      // Capture published: the receiver is forward only.
      const routed = f.publish();
      expect(routed).toHaveLength(1);
      expect(routed[0]).toEqual({ deferred: false, deferredPass: false });
      // Nothing about the receiver changed, yet the next packet carries it with Deferred again.
      f.removeCapture();
      const restored = f.publish();
      expect(restored).toHaveLength(1);
      expect(restored[0]).toEqual({ deferred: true, deferredPass: true });
      // And back to forward only when a capture returns.
      f.addCapture();
      const rerouted = f.publish();
      expect(rerouted).toHaveLength(1);
      expect(rerouted[0]).toEqual({ deferred: false, deferredPass: false });
      // A stable demand republishes nothing.
      expect(f.publish()).toHaveLength(0);
    } finally {
      f.dispose();
    }
  });
});
